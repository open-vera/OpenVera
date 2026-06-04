# Tool Output Rendering — UI Rendering Strategy

## 1. Design Goals

Separate tool execution from UI rendering:

- **Tools** only return structured `ToolResult`, unaware of terminal width, colors, or Ink components
- **Rendering layer** chooses an appropriate rendering strategy based on `ToolResult.metadata.renderHint`
- Adding new tools or new rendering formats does not affect each other

---

## 2. RenderHint — Tool Tells UI How to Render

The tool declares the content type in `ToolResult.metadata.renderHint`; the rendering layer dispatches accordingly:

```ts
type RenderHint =
  | { type: "text" }                  // Plain text, default
  | { type: "code"; lang?: string }   // Code block (syntax highlighting)
  | { type: "diff" }                  // Unified diff format
  | { type: "file-list" }             // File path list
  | { type: "image"; mimeType: string } // base64 image
  | { type: "error" }                 // Error message (red highlight)
  | { type: "bash-output"; exitCode: number } // Command output (with exit code)
```

When a tool does not set `renderHint`, it defaults to `text` rendering.

---

## 3. Rendering Entry Point — ToolResultView

All tool results are rendered through a single entry component:

```tsx
// packages/core/src/repl/ui/ToolResultView.tsx

interface ToolResultViewProps {
  toolName: string;
  args: Record<string, unknown>;
  result: ToolResult;
  width: number;
}

export function ToolResultView({ toolName, args, result, width }: ToolResultViewProps) {
  if (!result.ok) {
    return <ErrorView message={result.error?.message ?? result.content} code={result.error?.code} />;
  }

  const hint = result.metadata?.renderHint;
  switch (hint?.type) {
    case "diff":       return <DiffView content={result.content} width={width} />;
    case "code":       return <CodeView content={result.content} lang={hint.lang} width={width} />;
    case "file-list":  return <FileListView content={result.content} />;
    case "bash-output": return <BashOutputView content={result.content} exitCode={hint.exitCode} width={width} />;
    case "image":      return <ImageView content={result.content} mimeType={hint.mimeType} />;
    default:           return <TextView content={result.content} width={width} />;
  }
}
```

---

## 4. Renderer Designs

### 4.1 TextView (Default)

Plain text output, auto-wrapped, truncated when exceeding `maxLines` with a line count hint:

```
read 342 lines from src/agent/loop.ts
----------------------------------------
  1  import type { LLMAdapter } from "../adapters/base.js";
  2  import type {
  3    CompletionRequest,
...
 50  export async function runAgent(
[... 292 more lines, use offset/limit to read more]
```

### 4.2 DiffView (edit_file Output)

Renders unified diff with green for `+` lines, red for `-` lines, dim gray for `@@` lines:

```
edit_file  src/session/store.ts
-----------------------------------------
@@ -87,6 +87,10 @@
   writeAssistant(p: {
     ...
+    turn: number;
+    latencyMs: number;
+    toolCalls: string[];
+    status: "ok" | "error";
   }): string {
```

Implementation: parses unified diff format, renders color by line type. No external diff library dependency; self-parses `+/-/@@ ` prefixes.

### 4.3 CodeView (read_file for Code Files)

Line numbers + syntax highlighting (language determined by file extension):

```
read_file  packages/core/src/agent/loop.ts  (50/342 lines)
--------------------------------------------------------------
  1| import type { LLMAdapter } from "../adapters/base.js";
  2| import type {
  3|   CompletionRequest,
```

Syntax highlighting: uses `chalk` for keyword coloring (`import`/`export`/`function`/`class`/`const`/`return`). Does not introduce a full syntax highlighting library (e.g., highlight.js), keeping the zero-dependency principle.

### 4.4 FileListView (list_dir / glob Output)

Directory tree or file list format:

```
list_dir  packages/core/src/
------------------------------
📁 adapters/      (4 files)
📁 agent/         (1 file)
📁 config/        (3 files)
📁 context/       (4 files)
📁 session/       (5 files)
📁 tools/         (8 files)
📄 index.ts
```

### 4.5 BashOutputView (bash Output)

```
bash  npm test
----------------------------------
exit 0  (1.2s)
----------------------------------
> vera@0.1.0 test
> jest --passWithNoTests

PASS  src/session/cost.test.ts
  ✓ calculateCost returns 0 for unknown model (3ms)

Test Suites: 1 passed, 1 total
```

Non-zero exit code: the bottom status line is highlighted red: `exit 1  (2.4s)`.

### 4.6 ErrorView (Tool Failure)

```
✗ read_file  /etc/passwd
  PERMISSION_DENIED: path is outside allowed workdir
  Allowed: /Users/yang/workspace/open-vera
  Got:     /etc/passwd
```

### 4.7 ImageView (Screenshot / Image Read)

Inline image display (when terminal supports it) or fallback to metadata text:

```
[image: screenshot.png  1920x1080  jpeg  245KB]
```

Uses `sixel` or iTerm2 inline image protocol when the terminal supports it. Detection: `TERM_PROGRAM === "iTerm.app"` or `$COLORTERM === "truecolor"`.

---

## 5. Custom Renderer Registration

Tools can register custom renderers, overriding the default dispatch logic:

```ts
// Custom: render web_search results with a special format
ToolResultView.register("web_search", WebSearchResultView);
```

```tsx
function WebSearchResultView({ result }: { result: ToolResult }) {
  const results = JSON.parse(result.content) as SearchResult[];
  return (
    <Box flexDirection="column" gap={1}>
      {results.map((r) => (
        <Box key={r.url} flexDirection="column">
          <Text bold color="cyan">{r.title}</Text>
          <Text color="gray">{r.url}</Text>
          <Text wrap="wrap">{r.snippet}</Text>
        </Box>
      ))}
    </Box>
  );
}
```

---

## 6. ConversationPanel Integration

When a `ChatMessage` contains tool call records, render `ToolResultView`:

```ts
// repl/ui/types.ts extension
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  toolUses?: Array<{          // new
    name: string;
    args: Record<string, unknown>;
    result: ToolResult;
  }>;
}
```

`ConversationPanel` renders `toolUses` in order within assistant messages. Each tool call displays the tool name, parameter summary, and result.

---

## 7. Tool Call Display Format (Collapsible)

Long tool output is collapsed by default; the user can expand:

```
▶ read_file  src/agent/loop.ts  (342 lines)   [expand]
▶ bash  npm test  exit 0  (1.2s)              [expand]
```

Expanding shows the full rendered result. Collapse/expand state is held in React state; no persistence needed.

Initially, all results can be shown expanded; collapsible behavior is added after tool call volume increases.

---

## 8. File Structure

```
packages/core/src/repl/ui/
+-- ToolResultView.tsx      <- Dispatch entry point
+-- renderers/
|   +-- TextView.tsx
|   +-- DiffView.tsx
|   +-- CodeView.tsx
|   +-- FileListView.tsx
|   +-- BashOutputView.tsx
|   +-- ErrorView.tsx
|   +-- ImageView.tsx
+-- ConversationPanel.tsx   <- Calls ToolResultView (existing file, needs modification)
```

---

## 9. Implementation Order

1. `ToolResultView.tsx` + `renderers/ErrorView.tsx` — Get error rendering right first
2. `renderers/TextView.tsx` — Default rendering, with line count truncation
3. `renderers/CodeView.tsx` — Mainly used by read_file
4. `renderers/DiffView.tsx` — edit_file results
5. `renderers/BashOutputView.tsx` — bash results
6. `renderers/FileListView.tsx` — list_dir / glob
7. `ConversationPanel.tsx` integration of toolUses rendering
8. Collapse/expand interaction (low priority)
9. `renderers/ImageView.tsx` — When computer use is needed

# 工具输出渲染 — UI 渲染策略

## 1. 设计目标

将工具执行与 UI 渲染解耦：

- **工具**只返回结构化的 `ToolResult`，不感知终端宽度、颜色或 Ink 组件
- **渲染层**根据 `ToolResult.metadata.renderHint` 选择合适的渲染策略
- 新增工具或新增渲染格式互不影响

---

## 2. RenderHint — 工具告知 UI 如何渲染

工具在 `ToolResult.metadata.renderHint` 中声明内容类型，渲染层据此分发：

```ts
type RenderHint =
  | { type: "text" }                  // 纯文本，默认
  | { type: "code"; lang?: string }   // 代码块（语法高亮）
  | { type: "diff" }                  // Unified diff 格式
  | { type: "file-list" }             // 文件路径列表
  | { type: "image"; mimeType: string } // base64 图片
  | { type: "error" }                 // 错误信息（红色高亮）
  | { type: "bash-output"; exitCode: number } // 命令输出（含退出码）
```

工具未设置 `renderHint` 时，默认使用 `text` 渲染。

---

## 3. 渲染入口 — ToolResultView

所有工具结果通过单一入口组件渲染：

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

## 4. 各渲染器设计

### 4.1 TextView（默认）

纯文本输出，自动换行，超过 `maxLines` 时截断并显示行数提示：

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

### 4.2 DiffView（edit_file 输出）

渲染 unified diff，`+` 行绿色，`-` 行红色，`@@` 行灰色：

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

实现方式：自行解析 unified diff 格式，按行类型着色。不依赖外部 diff 库，自行解析 `+/-/@@ ` 前缀。

### 4.3 CodeView（代码文件 read_file）

行号 + 语法高亮（语言由文件扩展名决定）：

```
read_file  packages/core/src/agent/loop.ts  (50/342 lines)
--------------------------------------------------------------
  1| import type { LLMAdapter } from "../adapters/base.js";
  2| import type {
  3|   CompletionRequest,
```

语法高亮：使用 `chalk` 对关键字着色（`import`/`export`/`function`/`class`/`const`/`return`）。不引入完整的语法高亮库（如 highlight.js），保持零依赖原则。

### 4.4 FileListView（list_dir / glob 输出）

目录树或文件列表格式：

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

### 4.5 BashOutputView（bash 输出）

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

非零退出码：底部状态行红色高亮：`exit 1  (2.4s)`。

### 4.6 ErrorView（工具失败）

```
✗ read_file  /etc/passwd
  PERMISSION_DENIED: path is outside allowed workdir
  Allowed: /Users/yang/workspace/open-vera
  Got:     /etc/passwd
```

### 4.7 ImageView（截图 / 图片读取）

终端支持时内联显示图片，否则降级为元数据文本：

```
[image: screenshot.png  1920x1080  jpeg  245KB]
```

终端支持检测：`TERM_PROGRAM === "iTerm.app"` 或 `$COLORTERM === "truecolor"` 时使用 sixel 或 iTerm2 内联图片协议。

---

## 5. 自定义渲染器注册

工具可以注册自定义渲染器，覆盖默认分发逻辑：

```ts
// 自定义：以特殊格式渲染 web_search 结果
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

## 6. ConversationPanel 集成

当 `ChatMessage` 包含工具调用记录时，渲染 `ToolResultView`：

```ts
// repl/ui/types.ts 扩展
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  toolUses?: Array<{          // 新增
    name: string;
    args: Record<string, unknown>;
    result: ToolResult;
  }>;
}
```

`ConversationPanel` 在 assistant 消息中按顺序渲染 `toolUses`。每条工具调用展示工具名称、参数摘要和结果。

---

## 7. 工具调用展示格式（可折叠）

较长工具输出默认折叠，用户可展开：

```
▶ read_file  src/agent/loop.ts  (342 lines)   [expand]
▶ bash  npm test  exit 0  (1.2s)              [expand]
```

展开后显示完整渲染结果。折叠/展开状态保存在 React state 中，无需持久化。

初期所有结果默认展开显示，待工具调用量增加后再添加可折叠行为。

---

## 8. 文件结构

```
packages/core/src/repl/ui/
+-- ToolResultView.tsx      <- 分发入口
+-- renderers/
|   +-- TextView.tsx
|   +-- DiffView.tsx
|   +-- CodeView.tsx
|   +-- FileListView.tsx
|   +-- BashOutputView.tsx
|   +-- ErrorView.tsx
|   +-- ImageView.tsx
+-- ConversationPanel.tsx   <- 调用 ToolResultView（已有文件，需修改）
```

---

## 9. 实施顺序

1. `ToolResultView.tsx` + `renderers/ErrorView.tsx` — 先搞对错误渲染
2. `renderers/TextView.tsx` — 默认渲染，含行数截断
3. `renderers/CodeView.tsx` — 主要用于 read_file
4. `renderers/DiffView.tsx` — edit_file 结果
5. `renderers/BashOutputView.tsx` — bash 结果
6. `renderers/FileListView.tsx` — list_dir / glob
7. `ConversationPanel.tsx` 集成 toolUses 渲染
8. 折叠/展开交互（低优先级）
9. `renderers/ImageView.tsx` — 需要 computer use 时

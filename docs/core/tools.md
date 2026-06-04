# Tools System Overview

> Package: `@open-vera/core` | Source: `packages/core/src/tools/`
> Last updated: 2026-06-04

## Architecture Overview

Vera's tools system is the hub through which the Agent interacts with the external world. It consists of three major components:

```
                 +------------------------------------+
                 |         ToolRegistry                |
                 |   Register . Lookup . Schema . Stats|
                 +--------------+---------------------+
                                |
          +---------------------+---------------------+
          |                     |                      |
          v                     v                      v
   +----------------+  +----------------+  +----------------+
   | SecurityPlugin |  |  Middlewares   |  |  Lifecycle     |
   | (Hook)         |  |  (Pipeline)    |  |  Hooks         |
   +----------------+  +----------------+  +----------------+
          |                     |                      |
          +---------------------+----------------------+
                                v
                 +------------------------------------+
                 |         ToolDef.execute()           |
                 |   Concrete tool implementations     |
                 +------------------------------------+
```

- **ToolRegistry**: Tool registry — registers, looks up, executes tools, maintains statistics
- **ToolDef**: Single tool definition — name, description, JSON Schema parameters, execution function
- **SecurityPlugin**: Intervenes via LifecycleHook at `onBeforeToolCall` to enforce security policies
- **Middleware**: Inserts custom logic at before/after/onError phases

---

## ToolRegistry — Registration and Execution Core

**File**: `registry.ts`

### Registration API

```typescript
const registry = new ToolRegistry();

// Register a single tool
registry.register(readFileTool);

// Batch register by group
registry.registerGroup(
  { name: "file", description: "File operations", defaults: { timeoutMs: 10_000 } },
  [readFileTool, writeFileTool, editFileTool]
);

// Query by group
registry.getGroup("file"); // -> { group, tools }

// Register security hook (as LifecycleHook)
const security = new SecurityPlugin(config);
registry.use(security);

// Register middleware
registry.addMiddleware({ name: "audit", before: ..., after: ... });
```

### Schema Export

```typescript
// Export all tools' LLM-visible schemas
registry.getSchemas(); // -> Tool[]

// Filter by group
registry.getSchemasByGroup("file"); // -> Tool[]
```

The `Tool[]` array returned by `getSchemas()` is passed to `adapter.complete()` as the tool list for LLM function calling.

### Execution Flow

```
execute(name, args, ctx)
  |
  +-- 1. Lookup ToolDef (not found -> errorResult("UNKNOWN"))
  +-- 2. Check dryRun (if true -> return simulated result, skip actual execution)
  +-- 3. Check deprecation (non-blocking warning)
  +-- 4. LifecycleHook.onBeforeToolCall (SecurityPlugin short-circuits here)
  +-- 5. Middleware.before (can modify args, skip execution)
  +-- 6. Idempotency cache check
  +-- 7. Execute + timeout control + retry (max 3, exponential backoff)
  +-- 8. Middleware.after (can transform result)
  +-- 9. LifecycleHook.onAfterToolCall
  +-- 10. Update idempotency cache
  +-- 11. Record stats (ToolStatsCollector)
```

#### Retry Strategy

- Default max 3 retries (`maxRetries = 3`)
- Exponential backoff: `100ms * 2^attempt`
- Only retries when `error.retryable === true`
- Calls Middleware.onError on final attempt failure for recovery

#### Idempotency Cache

Tools marked with `options.idempotent = true` (e.g., `read_file`, `list_dir`, `glob`, `grep`) have their first successful result cached. Subsequent calls with the same `(toolName, args)` return the cached result directly, avoiding redundant operations.

---

## ToolDef — Tool Definition

**File**: `types.ts`

```typescript
interface ToolDef<TArgs = object> {
  name: string;                // Tool name (LLM-visible)
  description: string;         // Tool description (LLM-visible, for function calling)
  parameters: JSONSchema;      // JSON Schema parameter definition
  options?: {
    timeoutMs?: number;        // Execution timeout (default 30s)
    retries?: number;          // Retry count
    idempotent?: boolean;      // Whether idempotent (results can be cached)
    riskLevel?: "low" | "medium" | "high";  // Risk level
  };
  version?: ToolVersion;       // Version and deprecation info
  group?: string;              // Tool group
  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}
```

### ToolContext — Execution Context

Context passed to each tool's execution, containing:

| Field | Type | Description |
|---|---|---|
| `cwd` | `string` | Current working directory |
| `sessionId` | `string` | Session ID |
| `allowedPaths` | `string[]` | Allowed path list |
| `env` | `Record<string, string>` | Environment variables |
| `signal` | `AbortSignal` | Cancellation signal |
| `dryRun` | `boolean` | Whether simulating execution |
| `onOutput` | `(chunk: string) => void` | Streaming output callback |
| `memoryStore` | `MemoryStore?` | Memory storage (for memory_write/memory_search) |
| `vectorStore` | `VectorStore?` | Vector storage (for knowledge_search) |
| `llmAdapter` | `LLMAdapter?` | LLM adapter (for visual_analyze) |
| `sandboxProvider` | `SandboxProvider?` | Sandbox provider (for sandbox_exec) |

### ToolResult — Execution Result

```typescript
interface ToolResult {
  ok: boolean;                          // Whether execution succeeded
  content: string;                      // Result text (shown to LLM)
  metadata?: {
    bytesRead?: number; linesRead?: number;
    linesChanged?: number; exitCode?: number;
    truncated?: boolean;
    renderHint?: RenderHint;            // Rendering hint (for REPL UI)
    diff?: { filePath: string; hunks: StructuredPatchHunk[] };
  };
  error?: { code: ToolErrorCode; message: string; retryable: boolean };
  retryCount?: number;
  needsConfirm?: { message: string; allowDir: string; retry: ... };
  dryRun?: boolean;
}
```

The `needsConfirm` field is used for **security confirmation** scenarios — when the SecurityPlugin detects an operation requiring user approval, it returns a `needsConfirm` result instead of outright denying. The REPL layer displays a confirmation prompt and retries the call after user approval.

---

## Built-in Tools Overview

`createToolRegistry()` in `index.ts` registers 13 core tools by default, plus conditionally registered tools (depending on external services).

### File Operation Tools

#### 1. read_file
**File**: `read-file.ts` | **Risk**: low | **Idempotent**: yes

Reads file content, returns line-numbered text. Supports offset/limit pagination. Auto-detects and rejects binary files. Max output 2000 lines. Result carries `renderHint: { type: "code" }`.

#### 2. write_file
**File**: `write-file.ts` | **Risk**: medium

Creates or overwrites a file, auto-creates parent directories. Uses atomic writes (temp file -> rename, preventing corruption on interruption). Checks for **content staleness** before writing — if the file was modified externally and not re-read, the write is rejected. Returns a unified diff.

#### 3. edit_file
**File**: `edit-file.ts` | **Risk**: medium

Precise string replacement. Requires `old_string` to appear **exactly once** in the file (0 matches = NOT_FOUND error, multiple = ambiguity error). Also uses atomic writes and staleness checks. Returns a unified diff.

#### 4. list_dir
**File**: `list-dir.ts` | **Risk**: low | **Idempotent**: yes

Lists directory contents with icons distinguishing files and directories, showing file sizes and subdirectory item counts.

#### 5. glob
**File**: `glob.ts` | **Risk**: low | **Idempotent**: yes

Searches files by glob pattern. Supports `*` (single level), `**` (recursive), `?` (single character). Auto-skips `node_modules`, `.git`, `.vera`, `dist`, `build`. Returns path-sorted match list.

#### 6. grep
**File**: `grep.ts` | **Risk**: low | **Idempotent**: yes

Searches files for regex matches. Supports recursive directory search, glob filename filtering, context line display. Auto-skips binary files. Max 200 match records returned.

### Command Execution Tool

#### 7. bash
**File**: `bash.ts` | **Risk**: high

Executes shell commands in an independent process group. Features:
- Streaming stdout/stderr collection; terminates process if output exceeds 512KB
- Supports `ctx.signal` cancellation
- Post-command safety net: final output capped at 80K characters
- Separate error handling for timeout, cancellation, and output overflow
- Returns `renderHint: { type: "bash-output", exitCode }`

### Conditionally Registered Tools

The following tools are only registered when their corresponding dependencies are provided:

- **memory_write / memory_search** (requires `memoryStore`): Persistent memory write and semantic search
- **knowledge_search** (requires `vectorStore` + `embeddingAdapter`): RAG knowledge base search
- **visual_analyze** (requires `llmAdapter`): Image/visual analysis
- **sandbox_exec / sandbox_upload / sandbox_download** (requires `sandboxProvider`): Isolated sandbox execution
- **file_upload / file_download / file_list** (requires `objectStore`): Object storage operations
- **browser**: Built-in browser tool (Puppeteer integration)
- **desktop_screenshot / desktop_input / desktop_script / desktop_accessibility**: Desktop automation tools
- **computer_use**: Comprehensive Computer Use capability

---

## SecurityPlugin — Security Policy

**File**: `security.ts`

SecurityPlugin implements the `ToolLifecycleHook` interface, executing multi-layer security checks in `onBeforeToolCall`. Check order:

```
1. Deny list check (deniedTools)
2. Allow list check (allowedTools)
3. Bash dangerous command detection (rm -rf, sudo, chmod 777, dd of=, git push --force)
   +- Triggers needsConfirm (requires user confirmation)
4. Read-only mode check (readonlyMode -> deny write_file/edit_file/bash)
5. Budget check (budgetUsd)
6. Path boundary check (path must not be outside workdir)
   +- Triggers needsConfirm (requires user approval for path)
7. Domain whitelist check (allowedDomains)
8. Prompt injection detection (patterns like "ignore previous instructions")
```

### SecurityConfig

```typescript
interface SecurityConfig {
  allowedTools?: string[];          // Tool whitelist (empty = allow all)
  deniedTools?: string[];           // Tool deny list (higher priority than whitelist)
  allowedBashCommands?: string[];   // Allowed bash commands (glob matching)
  deniedBashCommands?: string[];    // Denied bash commands (glob matching)
  workdir?: string;                 // Path boundary for file operations
  allowedDomains?: string[];        // Domain whitelist for network tools
  readonlyMode?: boolean;           // Read-only mode (deny write operations)
  budgetUsd?: number;               // Budget cap (USD)
  usdUsed?: number;                 // Cost used so far
}
```

---

## Permission Rules System

**File**: `permission-rules.ts`

Supports two levels of permission configuration:

1. **Global**: `~/.vera/permissions.json`
2. **Project-level**: `<project>/.vera/permissions.json`

Both levels are **merged** (project-level appended after global). Priority: deniedTools > allowedTools.

```json
{
  "allowedTools": ["read_file", "list_dir", "glob", "grep", "write_file", "edit_file"],
  "deniedTools": ["bash"],
  "allowedBashCommands": ["ls", "cat", "echo", "find", "wc"],
  "deniedBashCommands": ["rm -rf *", "sudo *"]
}
```

Bash command matching uses glob-like patterns (`*` matches any characters).

---

## Middleware System

**File**: `types.ts -> ToolMiddleware`

Middleware provides three-phase hooks to insert custom logic before and after tool execution:

```typescript
interface ToolMiddleware {
  name: string;

  // Before execution: can modify args or return skip+result to skip execution
  before?: (name, args, ctx) => Promise<{
    args: Record<string, unknown>;
    skip?: boolean;
    result?: ToolResult;
  } | null>;

  // After execution: can transform result
  after?: (name, args, result, ctx) => Promise<ToolResult>;

  // On error: can recover (return ToolResult) or give up (return null)
  onError?: (name, args, error, ctx) => Promise<ToolResult | null>;
}
```

Multiple middlewares form a **pipeline**, executing in registration order:

```
before1 -> before2 -> execute -> after1 -> after2
```

`onError` is only called after final retry failure, attempting recovery in registration order.

---

## Tool Statistics

**File**: `tool-stats.ts`

`ToolStatsCollector` automatically records metadata for each tool call, providing:

- **Per-tool stats**: `getStats(toolName)` -> call count, success rate, error rate, latency distribution
- **Global stats**: `getAllStats()` -> aggregate metrics for all tools
- **Top N tools**: `topTools(10)` -> ranked by call count
- **Latency percentiles**: P50 / P95 / P99

Default retention: most recent 1,000 call records (FIFO eviction).

---

## Custom Tool Registration

```typescript
const myTool: ToolDef<{ name: string }> = {
  name: "greet",
  description: "Greet someone by name",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name to greet" }
    },
    required: ["name"]
  },
  options: { timeoutMs: 5_000, riskLevel: "low", idempotent: true },
  async execute(args, ctx) {
    return { ok: true, content: `Hello, ${args.name}!` };
  }
};

registry.register(myTool);
```

---

## Render Hints

Each tool result can carry `metadata.renderHint`, guiding the REPL UI on how to display the result:

| RenderHint Type | Use |
|---|---|
| `{ type: "text" }` | Plain text display |
| `{ type: "code", lang? }` | Syntax-highlighted code block |
| `{ type: "diff" }` | Unified diff view |
| `{ type: "file-list" }` | File list view |
| `{ type: "image", mimeType }` | Image display |
| `{ type: "error" }` | Red error message |
| `{ type: "bash-output", exitCode }` | Terminal-style output |

---

## Tool Creation Entry Point

**File**: `index.ts -> createToolRegistry()`

```typescript
const { registry, security } = createToolRegistry({
  cwd: "/path/to/project",
  security: { readonlyMode: false },
  sessionStore,          // Optional: enables AnalyticsPlugin
  memoryStore,           // Optional: registers memory tools
  vectorStore,           // Optional: registers knowledge_search
  embeddingAdapter,      // Optional: for vectorStore
  llmAdapter,            // Optional: registers visual_analyze
  sandboxProvider,       // Optional: registers sandbox tools
  objectStore,           // Optional: registers file_upload/download/list
});
```

`createToolRegistry()` automatically handles:
1. Registering all built-in tools
2. Loading permission rules (from `~/.vera/permissions.json` and project `.vera/permissions.json`)
3. Registering SecurityPlugin as the first hook (ensuring security checks run first)
4. Optionally registering AnalyticsPlugin (requires SessionStore)
5. Optionally registering conditional tools (memory, knowledge_search, visual_analyze, sandbox, storage)

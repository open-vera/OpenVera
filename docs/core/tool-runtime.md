# Tool Runtime — Execution Model, Lifecycle, and Harness Integration

## 1. Design Goals

Tool Runtime is not just "calling functions." It needs to solve four problems simultaneously:

1. **Execution**: The tool logic itself (read_file / bash / web_search...)
2. **Security**: Harness performs permission checks before execution; out-of-bounds operations must not reach the tool
3. **Observability**: Every tool call must produce consumable events (tracing, analytics, session writes)
4. **Extensibility**: Adding new tools or hooks must not require changes to the main flow

These four concerns are managed uniformly through a **lifecycle + hook system**, rather than being scattered across individual tool files.

---

## 2. Overall Architecture

```
Agent Loop
    |
    | tool_call event
    v
+--------------------------------------------------+
|              ToolExecutor                         |
|                                                   |
|  1. resolve tool from registry                   |
|  2. run hook: onBeforeToolCall                   |  <- HarnessPlugin intercepts here
|  3. execute tool impl                            |
|  4. run hook: onAfterToolCall                    |  <- Analytics/Session writes here
|  5. return ToolResult                            |
+--------------------------------------------------+
    |
    | ToolResult
    v
Agent Loop (returns content as tool result message to model)
```

Harness and Analytics are both **plugins**, connected via hooks. The main flow is unaware of specific plugin existence.

---

## 3. Core Data Structures

### 3.1 ToolResult

```ts
interface ToolResult {
  ok: boolean;
  content: string;           // Content returned to the model
  metadata?: {
    bytesRead?: number;
    linesChanged?: number;
    exitCode?: number;
    truncated?: boolean;
    renderHint?: RenderHint; // Tells UI layer how to render (see tool-rendering.md)
  };
  error?: {
    code: ToolErrorCode;
    message: string;
    retryable: boolean;
  };
}

type ToolErrorCode =
  | "PERMISSION_DENIED"    // harness denied
  | "PATH_OUTSIDE_CWD"     // path out of bounds
  | "BUDGET_EXCEEDED"      // token / USD exceeded
  | "TIMEOUT"              // execution timeout
  | "NOT_FOUND"            // file or resource not found
  | "EXEC_ERROR"           // bash non-zero exit
  | "UNKNOWN";
```

### 3.2 ToolDef (Tool Description + Implementation Together)

```ts
interface ToolDef<TArgs = Record<string, unknown>> {
  // -- Schema visible to the model --
  name: string;
  description: string;
  parameters: JSONSchema;

  // -- Execution options --
  options?: {
    timeoutMs?: number;     // default 30000
    retries?: number;       // default 0 (no retry)
    idempotent?: boolean;   // marks idempotent, allows dry-run mode skip
    riskLevel?: "low" | "medium" | "high";  // for harness to decide if approval is needed
  };

  // -- Implementation --
  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}
```

### 3.3 ToolContext (Context Injected at Execution)

```ts
interface ToolContext {
  cwd: string;
  sessionId: string;
  env?: Record<string, string>;
  signal?: AbortSignal;     // supports abort
  dryRun?: boolean;         // harness can downgrade high-risk tools to dry-run
}
```

---

## 4. Lifecycle and Hooks

### 4.1 Full Lifecycle

```
onTurnStart(turn, messages)
    |
    +-- [for each tool call in this turn]
    |       |
    |       +-- onBeforeToolCall(name, args, ctx)   -> can return ToolResult to short-circuit
    |       +-- execute(args, ctx)
    |       +-- onAfterToolCall(name, args, result, ctx)
    |
onTurnEnd(turn, messages, usage)
    |
onSessionEnd(sessionId, summary)
```

### 4.2 Hook Interface

```ts
interface ToolLifecycleHook {
  // Return non-null to short-circuit, skipping tool execution (for harness interception)
  onBeforeToolCall?(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult | null>;

  onAfterToolCall?(
    name: string,
    args: Record<string, unknown>,
    result: ToolResult,
    ctx: ToolContext
  ): Promise<void>;

  onTurnStart?(turn: number, messages: Message[]): Promise<void>;
  onTurnEnd?(turn: number, messages: Message[], usage: Usage): Promise<void>;
  onSessionEnd?(sessionId: string): Promise<void>;
}
```

### 4.3 Hook Execution Order

Multiple plugins' hooks execute in registration order. In `onBeforeToolCall`, if any returns non-null, subsequent plugins' `onBeforeToolCall` do not execute — direct short-circuit.

```
[HarnessPlugin.onBeforeToolCall] -> returns PERMISSION_DENIED -> short-circuit
[AnalyticsPlugin.onBeforeToolCall] -> not executed
execute() -> not executed
```

---

## 5. SecurityPlugin — Permission and Security Checks

SecurityPlugin is the security guard before Core-layer tool execution, implementing `ToolLifecycleHook`. It is unaware of Harness Flow/Plan concepts and performs only static tool-call-level checks.

### 5.1 Checks (onBeforeToolCall)

| Check | Logic | Returns on Denial |
|---|---|---|
| **Tool whitelist** | Is tool name in `allowedTools` | `PERMISSION_DENIED` |
| **Path bounds** | Is file path within `scope.workdir` | `PATH_OUTSIDE_CWD` |
| **Domain whitelist** | web_search / fetch_url domain check | `PERMISSION_DENIED` |
| **Budget check** | `budget.usdUsed >= budget.usdBudget` | `BUDGET_EXCEEDED` |
| **Read-only mode** | Deny all write operations in `readonlyMode` | `PERMISSION_DENIED` |
| **Prompt injection defense** | Detect injection patterns in tool params | `PERMISSION_DENIED` |

### 5.2 SecurityConfig Source

Defaults read from `cwd` and caller-provided options. The upper Harness layer can override `workdir`, `allowedTools`, `budgetUsd`, etc., when constructing the ToolRegistry, achieving TaskScope-level constraints.

```ts
interface SecurityConfig {
  allowedTools?: string[];
  workdir?: string;
  allowedDomains?: string[];
  readonlyMode?: boolean;
  budgetUsd?: number;
  usdUsed?: number;
}
```

---

## 6. AnalyticsPlugin — Telemetry and Session Writing

Analytics also connects via hooks, without intruding on tool implementations:

```ts
class AnalyticsPlugin implements ToolLifecycleHook {
  constructor(private store: SessionStore) {}

  async onBeforeToolCall(name, args, ctx) {
    // Record tool_call entry to session JSONL
    this._pendingUuid = this.store.writeToolCall({ ... });
    return null; // don't intercept
  }

  async onAfterToolCall(name, args, result, ctx) {
    // Record tool_result entry
    this.store.writeToolResult({ parentUuid: this._pendingUuid, ... });
    // Future: send to external analytics system
  }

  async onTurnEnd(turn, messages, usage) {
    // assistant entry already written by App.tsx onUsage; extra aggregation can happen here
  }
}
```

This way, **tool_call / tool_result session writes move from App.tsx to AnalyticsPlugin**, and App.tsx no longer needs to manually call store in onToolCall.

---

## 7. ToolRegistry — Registration and Execution

```ts
class ToolRegistry {
  private tools = new Map<string, ToolDef>();
  private hooks: ToolLifecycleHook[] = [];

  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
  }

  use(hook: ToolLifecycleHook): void {
    this.hooks.push(hook);
  }

  // Returns Tool[] schema list for agent loop
  getSchemas(): Tool[] {
    return [...this.tools.values()].map(toToolSchema);
  }

  // Called by agent loop's onToolCall
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> {
    const toolDef = this.tools.get(name);
    if (!toolDef) {
      return { ok: false, content: `Unknown tool: ${name}`, error: { code: "UNKNOWN", message: `Tool not found: ${name}`, retryable: false } };
    }

    // onBeforeToolCall hooks (ordered, short-circuit capable)
    for (const hook of this.hooks) {
      const intercepted = await hook.onBeforeToolCall?.(name, args, ctx);
      if (intercepted) return intercepted;
    }

    // Execute (with timeout)
    const result = await executeWithTimeout(
      () => toolDef.execute(args as never, ctx),
      toolDef.options?.timeoutMs ?? 30_000
    );

    // onAfterToolCall hooks
    for (const hook of this.hooks) {
      await hook.onAfterToolCall?.(name, args, result, ctx);
    }

    return result;
  }
}
```

---

## 8. Tool File Structure

```
packages/core/src/tools/
+-- index.ts          <- createToolRegistry() builds full registry, registers all built-in tools
+-- types.ts          <- ToolResult, ToolDef, ToolContext, ToolLifecycleHook
+-- registry.ts       <- ToolRegistry class
+-- executor.ts       <- executeWithTimeout, retryWithPolicy
+-- security.ts       <- SecurityPlugin implementation (path bounds + whitelist + budget + injection defense)
+-- analytics.ts      <- AnalyticsPlugin implementation
|
+-- read-file.ts      <- tool description + execute implementation together
+-- write-file.ts
+-- edit-file.ts
+-- list-dir.ts
+-- glob.ts
+-- bash.ts
+-- grep.ts
+-- web-search.ts
```

Cross-platform and edge-case code (e.g., path handling differences, binary file detection) is extracted into shared helpers:

```
packages/core/src/tools/utils/
+-- path.ts           <- path sanitization, cwd boundary checks, Windows/POSIX compatibility
+-- truncate.ts       <- large output truncation (aligned with Claude Code's tool-budget logic)
+-- binary.ts         <- binary file detection (extension + magic bytes)
```

---

## 9. Integration with Agent Loop

`streamAgent()`'s `onToolCall` callback is changed to call `registry.execute()`:

```ts
// packages/core/src/index.ts (at startup)
const registry = createToolRegistry({
  cwd: process.cwd(),
  harnessConfig: { ... },   // read from TaskScope
  sessionStore,             // passed to AnalyticsPlugin
});

await startRepl({
  ...,
  tools: registry.getSchemas(),
  onToolCall: (name, args) =>
    registry.execute(name, args, { cwd: process.cwd(), sessionId }),
});
```

---

## 10. Implementation Order

1. `tools/types.ts` — ToolResult / ToolDef / ToolContext / ToolLifecycleHook
2. `tools/utils/path.ts` — Path utilities
3. `tools/utils/truncate.ts` — Output truncation
4. `tools/registry.ts` — ToolRegistry
5. `tools/executor.ts` — timeout / retry
6. `tools/harness.ts` — HarnessPlugin (path bounds + whitelist implemented first)
7. `tools/analytics.ts` — AnalyticsPlugin (writes session JSONL)
8. Built-in tools: read-file -> list-dir -> glob -> bash -> edit-file -> write-file -> grep
9. `tools/index.ts` — createToolRegistry()
10. Integrate into index.ts, replacing the onToolCall stub in App.tsx

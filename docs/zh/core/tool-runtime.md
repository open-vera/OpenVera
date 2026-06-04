# 工具运行时 — 执行模型、生命周期与 Harness 集成

## 1. 设计目标

工具运行时不仅仅是"调用函数"，它需要同时解决四个问题：

1. **执行**：工具逻辑本身（read_file / bash / web_search...）
2. **安全**：Harness 在执行前进行权限检查；越界操作不能到达工具层
3. **可观测性**：每次工具调用都必须产生可消费的事件（追踪、分析、会话写入）
4. **可扩展性**：新增工具或 Hook 不应修改主流程

这四个关注点通过 **生命周期 + Hook 系统** 统一管理，而非分散在各个工具文件中。

---

## 2. 整体架构

```
Agent Loop
    |
    | tool_call 事件
    v
+--------------------------------------------------+
|              ToolExecutor                         |
|                                                   |
|  1. 从 registry 解析工具                          |
|  2. 执行 hook: onBeforeToolCall                  |  <- HarnessPlugin 在此拦截
|  3. 执行工具实现                                  |
|  4. 执行 hook: onAfterToolCall                   |  <- Analytics/Session 在此写入
|  5. 返回 ToolResult                              |
+--------------------------------------------------+
    |
    | ToolResult
    v
Agent Loop（将 content 作为 tool_result 消息返回给模型）
```

Harness 和 Analytics 都是**插件**，通过 Hook 连接。主流程不感知具体插件的存在。

---

## 3. 核心数据结构

### 3.1 ToolResult

```ts
interface ToolResult {
  ok: boolean;
  content: string;           // 返回给模型的内容
  metadata?: {
    bytesRead?: number;
    linesChanged?: number;
    exitCode?: number;
    truncated?: boolean;
    renderHint?: RenderHint; // 告知 UI 层如何渲染（见 tool-rendering.md）
  };
  error?: {
    code: ToolErrorCode;
    message: string;
    retryable: boolean;
  };
}

type ToolErrorCode =
  | "PERMISSION_DENIED"    // harness 拒绝
  | "PATH_OUTSIDE_CWD"     // 路径越界
  | "BUDGET_EXCEEDED"      // Token / USD 超限
  | "TIMEOUT"              // 执行超时
  | "NOT_FOUND"            // 文件或资源未找到
  | "EXEC_ERROR"           // bash 非零退出
  | "UNKNOWN";
```

### 3.2 ToolDef（工具定义与实现合一）

```ts
interface ToolDef<TArgs = Record<string, unknown>> {
  // -- 模型可见的 Schema --
  name: string;
  description: string;
  parameters: JSONSchema;

  // -- 执行选项 --
  options?: {
    timeoutMs?: number;     // 默认 30000
    retries?: number;       // 默认 0（不重试）
    idempotent?: boolean;   // 标记幂等，允许 dry-run 模式跳过
    riskLevel?: "low" | "medium" | "high";  // 供 harness 决定是否需要审批
  };

  // -- 实现 --
  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}
```

### 3.3 ToolContext（执行时注入的上下文）

```ts
interface ToolContext {
  cwd: string;
  sessionId: string;
  env?: Record<string, string>;
  signal?: AbortSignal;     // 支持中断
  dryRun?: boolean;         // harness 可将高风险工具降级为 dry-run
}
```

---

## 4. 生命周期与 Hook

### 4.1 完整生命周期

```
onTurnStart(turn, messages)
    |
    +-- [本轮每次工具调用]
    |       |
    |       +-- onBeforeToolCall(name, args, ctx)   -> 可返回 ToolResult 短路
    |       +-- execute(args, ctx)
    |       +-- onAfterToolCall(name, args, result, ctx)
    |
onTurnEnd(turn, messages, usage)
    |
onSessionEnd(sessionId, summary)
```

### 4.2 Hook 接口

```ts
interface ToolLifecycleHook {
  // 返回非 null 则短路，跳过工具执行（用于 harness 拦截）
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

### 4.3 Hook 执行顺序

多个插件的 Hook 按注册顺序执行。`onBeforeToolCall` 中，任一返回非 null 则后续插件的 `onBeforeToolCall` 不再执行——直接短路。

```
[HarnessPlugin.onBeforeToolCall] -> 返回 PERMISSION_DENIED -> 短路
[AnalyticsPlugin.onBeforeToolCall] -> 不执行
execute() -> 不执行
```

---

## 5. SecurityPlugin — 权限与安全检查

SecurityPlugin 是 Core 层工具执行前的安全守卫，实现 `ToolLifecycleHook`。它不感知 Harness 的 Flow/Plan 概念，只做静态的工具调用级检查。

### 5.1 检查项（onBeforeToolCall）

| 检查项 | 逻辑 | 拒绝时返回 |
|---|---|---|
| **工具白名单** | 工具名是否在 `allowedTools` 中 | `PERMISSION_DENIED` |
| **路径边界** | 文件路径是否在 `scope.workdir` 内 | `PATH_OUTSIDE_CWD` |
| **域名白名单** | web_search / fetch_url 域名检查 | `PERMISSION_DENIED` |
| **预算检查** | `budget.usdUsed >= budget.usdBudget` | `BUDGET_EXCEEDED` |
| **只读模式** | `readonlyMode` 下拒绝所有写操作 | `PERMISSION_DENIED` |
| **提示注入防御** | 检测工具参数中的注入模式 | `PERMISSION_DENIED` |

### 5.2 SecurityConfig 来源

默认值从 `cwd` 和调用方提供的选项中读取。上层 Harness 层在构造 ToolRegistry 时可覆盖 `workdir`、`allowedTools`、`budgetUsd` 等，实现 TaskScope 级约束。

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

## 6. AnalyticsPlugin — 遥测与会话写入

Analytics 同样通过 Hook 连接，不侵入工具实现：

```ts
class AnalyticsPlugin implements ToolLifecycleHook {
  constructor(private store: SessionStore) {}

  async onBeforeToolCall(name, args, ctx) {
    // 向 session JSONL 写入 tool_call 条目
    this._pendingUuid = this.store.writeToolCall({ ... });
    return null; // 不拦截
  }

  async onAfterToolCall(name, args, result, ctx) {
    // 写入 tool_result 条目
    this.store.writeToolResult({ parentUuid: this._pendingUuid, ... });
    // 未来：发送到外部分析系统
  }

  async onTurnEnd(turn, messages, usage) {
    // assistant 条目已由 App.tsx 在 onUsage 中写入；此处可做额外聚合
  }
}
```

这样，**tool_call / tool_result 的会话写入从 App.tsx 移到了 AnalyticsPlugin**，App.tsx 不再需要在 onToolCall 中手动调用 store。

---

## 7. ToolRegistry — 注册与执行

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

  // 返回 Tool[] schema 列表供 agent loop 使用
  getSchemas(): Tool[] {
    return [...this.tools.values()].map(toToolSchema);
  }

  // 由 agent loop 的 onToolCall 调用
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> {
    const toolDef = this.tools.get(name);
    if (!toolDef) {
      return { ok: false, content: `Unknown tool: ${name}`, error: { code: "UNKNOWN", message: `Tool not found: ${name}`, retryable: false } };
    }

    // onBeforeToolCall hooks（有序，支持短路）
    for (const hook of this.hooks) {
      const intercepted = await hook.onBeforeToolCall?.(name, args, ctx);
      if (intercepted) return intercepted;
    }

    // 执行（带超时）
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

## 8. 工具文件结构

```
packages/core/src/tools/
+-- index.ts          <- createToolRegistry() 构建完整 registry，注册所有内置工具
+-- types.ts          <- ToolResult, ToolDef, ToolContext, ToolLifecycleHook
+-- registry.ts       <- ToolRegistry 类
+-- executor.ts       <- executeWithTimeout, retryWithPolicy
+-- security.ts       <- SecurityPlugin 实现（路径边界 + 白名单 + 预算 + 注入防御）
+-- analytics.ts      <- AnalyticsPlugin 实现
|
+-- read-file.ts      <- 工具描述 + execute 实现合一
+-- write-file.ts
+-- edit-file.ts
+-- list-dir.ts
+-- glob.ts
+-- bash.ts
+-- grep.ts
+-- web-search.ts
```

跨平台和边界情况代码（如路径处理差异、二进制文件检测）提取到共享辅助函数中：

```
packages/core/src/tools/utils/
+-- path.ts           <- 路径清洗、cwd 边界检查、Windows/POSIX 兼容
+-- truncate.ts       <- 大输出截断（与 Claude Code 的 tool-budget 逻辑对齐）
+-- binary.ts         <- 二进制文件检测（扩展名 + magic bytes）
```

---

## 9. 与 Agent Loop 集成

`streamAgent()` 的 `onToolCall` 回调改为调用 `registry.execute()`：

```ts
// packages/core/src/index.ts（启动时）
const registry = createToolRegistry({
  cwd: process.cwd(),
  harnessConfig: { ... },   // 从 TaskScope 读取
  sessionStore,             // 传给 AnalyticsPlugin
});

await startRepl({
  ...,
  tools: registry.getSchemas(),
  onToolCall: (name, args) =>
    registry.execute(name, args, { cwd: process.cwd(), sessionId }),
});
```

---

## 10. 实施顺序

1. `tools/types.ts` — ToolResult / ToolDef / ToolContext / ToolLifecycleHook
2. `tools/utils/path.ts` — 路径工具
3. `tools/utils/truncate.ts` — 输出截断
4. `tools/registry.ts` — ToolRegistry
5. `tools/executor.ts` — 超时 / 重试
6. `tools/harness.ts` — HarnessPlugin（先实现路径边界 + 白名单）
7. `tools/analytics.ts` — AnalyticsPlugin（写入 session JSONL）
8. 内置工具：read-file -> list-dir -> glob -> bash -> edit-file -> write-file -> grep
9. `tools/index.ts` — createToolRegistry()
10. 集成到 index.ts，替换 App.tsx 中的 onToolCall stub

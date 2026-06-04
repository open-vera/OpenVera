# 工具系统概述

> 所属包：`@open-vera/core` | 源码目录：`packages/core/src/tools/`
> 最后更新：2026-06-04

## 架构概览

Vera 的工具系统是 Agent 与外部世界交互的枢纽。它由三大组件构成：

```
                 ┌──────────────────────────────────┐
                 │         ToolRegistry               │
                 │   注册 · 查找 · Schema 导出 · 统计  │
                 └──────────┬───────────────────────┘
                            │
          ┌─────────────────┼─────────────────┐
          ▼                 ▼                  ▼
   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
   │ SecurityPlugin│ │  Middlewares │ │  Lifecycle    │
   │ (Hook)        │ │  (Pipeline)  │ │  Hooks        │
   └──────────────┘ └──────────────┘ └──────────────┘
          │                 │                  │
          └─────────────────┼──────────────────┘
                            ▼
                 ┌──────────────────────────────────┐
                 │         ToolDef.execute()         │
                 │   具体工具实现（read_file, bash…）│
                 └──────────────────────────────────┘
```

- **ToolRegistry**：工具注册表，负责注册、查找、执行工具，维护统计分析
- **ToolDef**：单个工具的定义——名称、描述、JSON Schema 参数、执行函数
- **SecurityPlugin**：作为 LifecycleHook 介入 `onBeforeToolCall`，执行安全策略
- **Middleware**：在 before/after/onError 三个阶段插入自定义逻辑

---

## ToolRegistry —— 注册与执行核心

**文件**：`registry.ts`

### 注册 API

```typescript
const registry = new ToolRegistry();

// 注册单个工具
registry.register(readFileTool);

// 按组批量注册
registry.registerGroup(
  { name: "file", description: "File operations", defaults: { timeoutMs: 10_000 } },
  [readFileTool, writeFileTool, editFileTool]
);

// 按组查询
registry.getGroup("file"); // → { group, tools }

// 注册 security hook（作为 LifecycleHook）
const security = new SecurityPlugin(config);
registry.use(security);

// 注册 middleware
registry.addMiddleware({ name: "audit", before: ..., after: ... });
```

### Schema 导出

```typescript
// 导出所有工具的 LLM 可见 schema
registry.getSchemas(); // → Tool[]

// 按组过滤
registry.getSchemasByGroup("file"); // → Tool[]
```

`getSchemas()` 返回的 `Tool[]` 数组会被传递给 `adapter.complete()`，作为 LLM function calling 的工具列表。

### 执行流程

```
execute(name, args, ctx)
  │
  ├─ 1. 查找 ToolDef（不存在 → errorResult("UNKNOWN")）
  ├─ 2. 检查 dryRun（若为 true → 返回模拟结果，跳过实际执行）
  ├─ 3. 检查 deprecation（非阻塞 warning）
  ├─ 4. LifecycleHook.onBeforeToolCall（SecurityPlugin 在此短切）
  ├─ 5. Middleware.before（可修改 args、跳过执行）
  ├─ 6. 幂等性缓存检查（check idempotent cache）
  ├─ 7. 执行 + 超时控制 + 重试（最多 3 次，指数退避）
  ├─ 8. Middleware.after（可变换结果）
  ├─ 9. LifecycleHook.onAfterToolCall
  ├─ 10. 更新幂等缓存
  └─ 11. 记录统计（ToolStatsCollector）
```

#### 重试策略

- 默认最多 3 次重试（`maxRetries = 3`）
- 指数退避：`100ms * 2^attempt`
- 仅在 `error.retryable === true` 时重试
- 最终尝试失败时调用 Middleware.onError 尝试恢复

#### 幂等性缓存

标有 `options.idempotent = true` 的工具（如 `read_file`、`list_dir`、`glob`、`grep`），首次成功结果会被缓存。之后相同 `(toolName, args)` 的调用直接返回缓存结果，避免重复操作。

---

## ToolDef —— 工具定义

**文件**：`types.ts`

```typescript
interface ToolDef<TArgs = object> {
  name: string;                // 工具名称（LLM 可见）
  description: string;         // 工具描述（LLM 可见，用于 function calling）
  parameters: JSONSchema;      // JSON Schema 参数定义
  options?: {
    timeoutMs?: number;        // 执行超时（默认 30s）
    retries?: number;          // 重试次数
    idempotent?: boolean;      // 是否幂等（可缓存结果）
    riskLevel?: "low" | "medium" | "high";  // 风险等级
  };
  version?: ToolVersion;       // 版本与废弃信息
  group?: string;              // 所属工具组
  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}
```

### ToolContext —— 执行上下文

传递给每个工具的执行上下文，包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `cwd` | `string` | 当前工作目录 |
| `sessionId` | `string` | 会话 ID |
| `allowedPaths` | `string[]` | 允许访问的路径列表 |
| `env` | `Record<string, string>` | 环境变量 |
| `signal` | `AbortSignal` | 取消信号 |
| `dryRun` | `boolean` | 是否为模拟执行 |
| `onOutput` | `(chunk: string) => void` | 流式输出回调（bash 等长命令用） |
| `memoryStore` | `MemoryStore?` | 记忆存储（memory_write/memory_search 使用） |
| `vectorStore` | `VectorStore?` | 向量存储（knowledge_search 使用） |
| `llmAdapter` | `LLMAdapter?` | LLM 适配器（visual_analyze 等使用） |
| `sandboxProvider` | `SandboxProvider?` | 沙箱提供者（sandbox_exec 等使用） |

### ToolResult —— 执行结果

```typescript
interface ToolResult {
  ok: boolean;                          // 执行是否成功
  content: string;                      // 结果文本（给 LLM 看）
  metadata?: {
    bytesRead?: number; linesRead?: number;
    linesChanged?: number; exitCode?: number;
    truncated?: boolean;
    renderHint?: RenderHint;            // 渲染提示（REPL UI 用）
    diff?: { filePath: string; hunks: StructuredPatchHunk[] };
  };
  error?: { code: ToolErrorCode; message: string; retryable: boolean };
  retryCount?: number;
  needsConfirm?: { message: string; allowDir: string; retry: ... };
  dryRun?: boolean;
}
```

`needsConfirm` 字段用于**安全确认**场景——SecurityPlugin 检测到需要用户批准的操作时，不直接拒绝，而是返回一个 `needsConfirm` 结果。REPL 层展示确认提示，用户批准后重试该调用。

---

## 内建工具一览

`createToolRegistry()` 在 `index.ts` 中默认注册 13 个核心工具。另有条件注册的工具（依赖外部服务）。

### file 操作工具

#### 1. read_file

**文件**：`read-file.ts` | **风险**：low | **幂等**：是

```json
{
  "path": "src/index.ts",      // 文件路径（必填）
  "offset": 10,                 // 起始行号（1-based，可选）
  "limit": 50                   // 最多读取行数（可选）
}
```

功能：读取文件内容，返回带行号的文本。支持 offset/limit 分页。自动检测并拒绝二进制文件。最大输出 2000 行（超出行数截断并标注）。结果带 `renderHint: { type: "code" }`。

#### 2. write_file

**文件**：`write-file.ts` | **风险**：medium

```json
{
  "path": "src/new.ts",        // 文件路径（必填）
  "content": "export ..."      // 要写入的内容（必填）
}
```

功能：创建或覆盖文件，自动创建父目录。使用原子写入（临时文件 → rename，防止写入中断导致文件损坏）。写入前检查**内容过时**（staleness）——如果文件被外部修改过且未被重新读取，写入将被拒绝。返回统一 diff。

#### 3. edit_file

**文件**：`edit-file.ts` | **风险**：medium

```json
{
  "path": "src/file.ts",       // 文件路径（必填）
  "old_string": "old code",    // 要替换的原始字符串（必填，精确匹配）
  "new_string": "new code"     // 替换后的字符串（必填）
}
```

功能：精确字符串替换。要求 `old_string` 在文件中**恰好出现一次**（0 次报 NOT_FOUND，多次报歧义错误）。同样使用原子写入和过时检查。返回统一 diff。

#### 4. list_dir

**文件**：`list-dir.ts` | **风险**：low | **幂等**：是

```json
{
  "path": "src"                // 目录路径（可选，默认 cwd）
}
```

功能：列出目录内容，用图标区分文件和目录，显示文件大小和子目录项数。

#### 5. glob

**文件**：`glob.ts` | **风险**：low | **幂等**：是

```json
{
  "pattern": "**/*.test.ts",   // Glob 表达式（必填）
  "path": "packages"           // 搜索起始目录（可选，默认 cwd）
}
```

功能：按 glob 模式搜索文件。支持 `*`（单层）、`**`（递归）、`?`（单字符）。自动跳过 `node_modules`、`.git`、`.vera`、`dist`、`build` 等目录。返回按路径排序的匹配列表。

#### 6. grep

**文件**：`grep.ts` | **风险**：low | **幂等**：是

```json
{
  "pattern": "function\\s+\\w+", // 正则表达式（必填）
  "path": "src",                  // 搜索起始路径（可选）
  "glob": "*.ts",                 // 文件名过滤（可选）
  "case_insensitive": true,       // 忽略大小写（可选）
  "context": 3                    // 上下文行数（可选）
}
```

功能：在文件中搜索正则表达式匹配。支持递归目录搜索、glob 文件名过滤、上下文行显示。自动跳过二进制文件。最多返回 200 条匹配记录。

### 命令执行工具

#### 7. bash

**文件**：`bash.ts` | **风险**：high

```json
{
  "command": "ls -la",         // Shell 命令（必填）
  "timeout": 30000             // 超时毫秒（可选，默认 30000）
}
```

功能：在独立进程组中执行 Shell 命令。特性：
- 流式收集 stdout/stderr，超过 512KB 立即终止进程
- 支持 `ctx.signal` 取消
- 命令完成后安全网截断：最终输出不超过 80K 字符
- 超时、取消、输出溢出各有独立错误处理
- 返回 `renderHint: { type: "bash-output", exitCode }`

### 条件注册工具

以下工具仅在创建 registry 时提供了对应依赖才会注册：

- **memory_write / memory_search**（需 `memoryStore`）：持久化记忆写入与语义搜索
- **knowledge_search**（需 `vectorStore` + `embeddingAdapter`）：RAG 知识库搜索
- **visual_analyze**（需 `llmAdapter`）：图片/视觉分析
- **sandbox_exec / sandbox_upload / sandbox_download**（需 `sandboxProvider`）：隔离沙箱执行
- **file_upload / file_download / file_list**（需 `objectStore`）：对象存储操作
- **browser**：内置浏览器工具（Puppeteer 集成）
- **desktop_screenshot / desktop_input / desktop_script / desktop_accessibility**：桌面自动化工具
- **computer_use**：综合 Computer Use 能力

---

## SecurityPlugin —— 安全策略

**文件**：`security.ts`

SecurityPlugin 实现 `ToolLifecycleHook` 接口，在 `onBeforeToolCall` 中执行多层安全检查。检查顺序为：

```
1. 黑名单检查 (deniedTools)
2. 白名单检查 (allowedTools)
3. Bash 危险命令检测（rm -rf, sudo, chmod 777, dd of=, git push --force）
   └─ 触发 needsConfirm（需用户确认）
4. 只读模式检查 (readonlyMode → 拒绝 write_file/edit_file/bash)
5. 费用预算检查 (budgetUsd)
6. 路径边界检查（path 不能在 workdir 之外）
   └─ 触发 needsConfirm（需用户批准路径）
7. 域名白名单检查 (allowedDomains)
8. 提示注入检测（ignore previous instructions 等模式）
```

### SecurityConfig 配置

```typescript
interface SecurityConfig {
  allowedTools?: string[];          // 工具白名单（空 = 全部允许）
  deniedTools?: string[];           // 工具黑名单（优先级高于白名单）
  allowedBashCommands?: string[];   // 允许的 bash 命令（glob 匹配）
  deniedBashCommands?: string[];    // 禁止的 bash 命令（glob 匹配）
  workdir?: string;                 // 文件操作的路径边界
  allowedDomains?: string[];        // 网络工具的域名白名单
  readonlyMode?: boolean;           // 只读模式（禁止写操作）
  budgetUsd?: number;               // 费用上限（USD）
  usdUsed?: number;                 // 已使用费用
}
```

### 路径确认流程

当 Agent 尝试访问 workdir 之外的路径时，SecurityPlugin 不是直接拒绝，而是返回 `needsConfirm`：

```typescript
{
  ok: false,
  content: "Path is outside allowed workdir...",
  needsConfirm: {
    message: "Agent wants to access a path outside the working directory...",
    allowDir: "/the/allowed/directory",
    retry: { name, args }  // 用户批准后按原参数重试
  }
}
```

调用方调用 `security.allowPath(dir)` 后重试，该目录将被加入 session 级别的白名单。

---

## 权限规则系统（Permission Rules）

**文件**：`permission-rules.ts`

支持两级权限配置文件：

1. **全局**：`~/.vera/permissions.json`
2. **项目级**：`<project>/.vera/permissions.json`

两级配置**合并**（项目级追加到全局之后），优先级：deniedTools > allowedTools。

```json
{
  "allowedTools": ["read_file", "list_dir", "glob", "grep", "write_file", "edit_file"],
  "deniedTools": ["bash"],
  "allowedBashCommands": ["ls", "cat", "echo", "find", "wc"],
  "deniedBashCommands": ["rm -rf *", "sudo *"]
}
```

bash 命令匹配使用 glob-like 模式（`*` 匹配任意字符）。

---

## Middleware 系统

**文件**：`types.ts → ToolMiddleware`

Middleware 提供了在工具执行前后插入自定义逻辑的三阶段钩子：

```typescript
interface ToolMiddleware {
  name: string;

  // 执行前：可修改参数或返回 skip+result 跳过执行
  before?: (name, args, ctx) => Promise<{
    args: Record<string, unknown>;
    skip?: boolean;
    result?: ToolResult;
  } | null>;

  // 执行后：可变换结果
  after?: (name, args, result, ctx) => Promise<ToolResult>;

  // 出错时：可恢复（返回 ToolResult）或放弃（返回 null）
  onError?: (name, args, error, ctx) => Promise<ToolResult | null>;
}
```

多个 middleware 组成**管道**，按注册顺序依次执行：

```
before₁ → before₂ → execute → after₁ → after₂
```

`onError` 仅在最终重试失败后调用，按注册顺序依次尝试恢复。

### Middleware 管理

```typescript
registry.addMiddleware({ name: "audit", before: ..., after: ... });
registry.removeMiddleware("audit"); // 按名称移除
```

---

## 工具统计分析

**文件**：`tool-stats.ts`

`ToolStatsCollector` 自动记录每次工具调用的元数据，提供：

- **按工具统计**：`getStats(toolName)` → 调用次数、成功率、错误率、延迟分布
- **全局统计**：`getAllStats()` → 所有工具的聚合指标
- **Top N 工具**：`topTools(10)` → 按调用次数排名
- **延迟分位数**：P50 / P95 / P99

默认保留最近 1,000 条调用记录（FIFO 淘汰）。

---

## 自定义工具注册

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

## 工具渲染提示（RenderHint）

每个工具结果可以携带 `metadata.renderHint`，指导 REPL UI 以合适的方式展示结果：

| RenderHint 类型 | 用途 |
|---|---|
| `{ type: "text" }` | 纯文本展示 |
| `{ type: "code", lang? }` | 语法高亮代码块 |
| `{ type: "diff" }` | 统一 diff 视图 |
| `{ type: "file-list" }` | 文件列表视图 |
| `{ type: "image", mimeType }` | 图片展示 |
| `{ type: "error" }` | 红色错误信息 |
| `{ type: "bash-output", exitCode }` | 终端样式输出 |

---

## 工具创建入口

**文件**：`index.ts → createToolRegistry()`

```typescript
const { registry, security } = createToolRegistry({
  cwd: "/path/to/project",
  security: { readonlyMode: false },
  sessionStore,          // 可选：启用 AnalyticsPlugin
  memoryStore,           // 可选：注册 memory 工具
  vectorStore,           // 可选：注册 knowledge_search 工具
  embeddingAdapter,      // 可选：配合 vectorStore
  llmAdapter,            // 可选：注册 visual_analyze 工具
  sandboxProvider,       // 可选：注册 sandbox 工具
  objectStore,           // 可选：注册 file_upload/download/list 工具
});
```

`createToolRegistry()` 自动处理：
1. 注册所有内建工具
2. 加载权限规则（从 `~/.vera/permissions.json` 和项目 `.vera/permissions.json`）
3. 注册 SecurityPlugin 作为第一个 hook（确保安全检查最先执行）
4. 可选注册 AnalyticsPlugin（需 SessionStore）
5. 可选注册条件工具（memory、knowledge_search、visual_analyze、sandbox、storage）


---


# Tool Runtime — 执行模型、生命周期与 Harness 集成

## 1. 设计目标

Tool Runtime 不只是"调函数"。它需要同时解决四个问题：

1. **执行**：工具逻辑本身（read_file / bash / web_search…）
2. **安全**：Harness 在执行前做权限检查，越界操作不能到达工具
3. **可观测**：每次工具调用都要产生可消费的事件（tracing、analytics、session 写入）
4. **可扩展**：新增工具或新增 hook 不需要改主流程

这四件事通过**生命周期 + Hook 系统**统一管理，而不是分散在每个工具文件里。

---

## 2. 整体架构

```
Agent Loop
    │
    │ tool_call 事件
    ▼
┌──────────────────────────────────────────────┐
│              ToolExecutor                     │
│                                               │
│  1. resolve tool from registry               │
│  2. run hook: onBeforeToolCall               │  ← HarnessPlugin 在这里拦截
│  3. execute tool impl                        │
│  4. run hook: onAfterToolCall                │  ← Analytics/Session 在这里写入
│  5. return ToolResult                        │
└──────────────────────────────────────────────┘
    │
    │ ToolResult
    ▼
Agent Loop（把 content 作为 tool result message 返回给模型）
```

Harness 和 Analytics 都是**插件（Plugin）**，通过 hook 接入。主流程不感知具体插件存在。

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
    renderHint?: RenderHint; // 告诉 UI 层怎么渲染（见 tool-rendering.md）
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
  | "BUDGET_EXCEEDED"      // token / USD 超出
  | "TIMEOUT"              // 执行超时
  | "NOT_FOUND"            // 文件或资源不存在
  | "EXEC_ERROR"           // bash 非零退出
  | "UNKNOWN";
```

### 3.2 ToolDef（工具描述 + 实现放一起）

```ts
interface ToolDef<TArgs = Record<string, unknown>> {
  // ── 给模型看的 schema ──────────────────────────────
  name: string;
  description: string;
  parameters: JSONSchema;

  // ── 执行选项 ───────────────────────────────────────
  options?: {
    timeoutMs?: number;     // 默认 30000
    retries?: number;       // 默认 0（不重试）
    idempotent?: boolean;   // 标记幂等，允许 dry-run 模式直接跳过
    riskLevel?: "low" | "medium" | "high";  // 供 harness 判断是否需要审批
  };

  // ── 实现 ───────────────────────────────────────────
  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}
```

### 3.3 ToolContext（执行时注入的上下文）

```ts
interface ToolContext {
  cwd: string;
  sessionId: string;
  env?: Record<string, string>;
  signal?: AbortSignal;     // 支持 abort
  dryRun?: boolean;         // harness 可以将高风险工具降级为 dry-run
}
```

---

## 4. 生命周期与 Hook

### 4.1 完整生命周期

```
onTurnStart(turn, messages)
    │
    ├─ [for each tool call in this turn]
    │       │
    │       ├─ onBeforeToolCall(name, args, ctx)   → 可返回 ToolResult 短路执行
    │       ├─ execute(args, ctx)
    │       └─ onAfterToolCall(name, args, result, ctx)
    │
onTurnEnd(turn, messages, usage)
    │
onSessionEnd(sessionId, summary)
```

### 4.2 Hook 接口

```ts
interface ToolLifecycleHook {
  // 返回非 null 则短路，不执行工具本身（用于 harness 拦截）
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

多个插件的 hook 按注册顺序执行。`onBeforeToolCall` 中任意一个返回非 null，后续插件的 `onBeforeToolCall` 不再执行，直接短路。

```
[HarnessPlugin.onBeforeToolCall] → 返回 PERMISSION_DENIED → 短路
[AnalyticsPlugin.onBeforeToolCall] → 不执行
execute() → 不执行
```

---

## 5. SecurityPlugin — 权限与安全检查

SecurityPlugin 是 Core 层工具执行前的安全守卫，实现 `ToolLifecycleHook`。它不感知 Harness 的 Flow/Plan 概念，只做工具调用级别的静态检查。

### 5.1 检查项（onBeforeToolCall）

| 检查 | 逻辑 | 拒绝时返回 |
|---|---|---|
| **工具白名单** | `allowedTools` 是否包含此工具名 | `PERMISSION_DENIED` |
| **路径越界** | 文件路径是否在 `scope.workdir` 内 | `PATH_OUTSIDE_CWD` |
| **域名白名单** | web_search / fetch_url 的域名检查 | `PERMISSION_DENIED` |
| **预算检查** | `budget.usdUsed >= budget.usdBudget` | `BUDGET_EXCEEDED` |
| **只读模式** | `readonlyMode` 下拒绝所有写操作 | `PERMISSION_DENIED` |
| **Prompt injection 防御** | 检测工具参数里的 injection 特征 | `PERMISSION_DENIED` |

### 5.2 SecurityConfig 来源

默认从 `cwd` 和调用方传入的选项读取。上层 Harness 在构建 ToolRegistry 时可覆盖 `workdir`、`allowedTools`、`budgetUsd` 等字段，实现 TaskScope 级别的约束。

```ts
// packages/core/src/tools/security.ts
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

## 6. AnalyticsPlugin — 遥测与 Session 写入

Analytics 也通过 hook 接入，不侵入工具实现：

```ts
class AnalyticsPlugin implements ToolLifecycleHook {
  constructor(private store: SessionStore) {}

  async onBeforeToolCall(name, args, ctx) {
    // 记录 tool_call entry 到 session JSONL
    this._pendingUuid = this.store.writeToolCall({ ... });
    return null; // 不拦截
  }

  async onAfterToolCall(name, args, result, ctx) {
    // 记录 tool_result entry
    this.store.writeToolResult({ parentUuid: this._pendingUuid, ... });
    // 未来：发送到外部 analytics 系统
  }

  async onTurnEnd(turn, messages, usage) {
    // 已由 App.tsx 的 onUsage 写入 assistant entry，此处可做额外聚合
  }
}
```

这样 **tool_call / tool_result 的 session 写入从 App.tsx 移到 AnalyticsPlugin**，App.tsx 不再需要手动在 onToolCall 里调 store。

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

  // 返回给 agent loop 的 Tool[] schema 列表
  getSchemas(): Tool[] {
    return [...this.tools.values()].map(toToolSchema);
  }

  // 被 agent loop 的 onToolCall 调用
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> {
    const toolDef = this.tools.get(name);
    if (!toolDef) {
      return { ok: false, content: `Unknown tool: ${name}`, error: { code: "UNKNOWN", message: `Tool not found: ${name}`, retryable: false } };
    }

    // onBeforeToolCall hooks（按顺序，可短路）
    for (const hook of this.hooks) {
      const intercepted = await hook.onBeforeToolCall?.(name, args, ctx);
      if (intercepted) return intercepted;
    }

    // 执行（带 timeout）
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
├── index.ts          ← createToolRegistry() 构建完整注册表，注册所有内置工具
├── types.ts          ← ToolResult, ToolDef, ToolContext, ToolLifecycleHook
├── registry.ts       ← ToolRegistry 类
├── executor.ts       ← executeWithTimeout, retryWithPolicy
├── security.ts       ← SecurityPlugin 实现（路径越界 + 白名单 + 预算 + injection 防御）
├── analytics.ts      ← AnalyticsPlugin 实现
│
├── read-file.ts      ← 工具描述 + execute 实现放一起
├── write-file.ts
├── edit-file.ts
├── list-dir.ts
├── glob.ts
├── bash.ts
├── grep.ts
└── web-search.ts
```

多平台和边缘情况代码（如路径处理差异、二进制文件检测）提取到共享 helper：

```
packages/core/src/tools/utils/
├── path.ts           ← 路径净化、cwd 边界检查、Windows/POSIX 兼容
├── truncate.ts       ← 大输出截断（参考 Claude Code 的 tool-budget 逻辑）
└── binary.ts         ← 二进制文件检测（扩展名 + magic bytes）
```

---

## 9. 与 Agent Loop 的集成

`streamAgent()` 的 `onToolCall` 回调改为调用 `registry.execute()`：

```ts
// packages/core/src/index.ts（启动时）
const registry = createToolRegistry({
  cwd: process.cwd(),
  harnessConfig: { ... },   // 从 TaskScope 读
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

## 10. 待实现顺序

1. `tools/types.ts` — ToolResult / ToolDef / ToolContext / ToolLifecycleHook
2. `tools/utils/path.ts` — 路径工具
3. `tools/utils/truncate.ts` — 输出截断
4. `tools/registry.ts` — ToolRegistry
5. `tools/executor.ts` — timeout / retry
6. `tools/harness.ts` — HarnessPlugin（路径越界 + 白名单优先实现）
7. `tools/analytics.ts` — AnalyticsPlugin（写 session JSONL）
8. 内置工具：read-file → list-dir → glob → bash → edit-file → write-file → grep
9. `tools/index.ts` — createToolRegistry()
10. 集成进 index.ts，替换 App.tsx 里的 onToolCall stub

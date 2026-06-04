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

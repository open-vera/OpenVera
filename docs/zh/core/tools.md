# 工具系统概览

> 包：`@open-vera/core` | 源码：`packages/core/src/tools/`
> 最后更新：2026-06-04

## 架构概览

Vera 的工具系统是 Agent 与外部世界交互的枢纽，由三大组件构成：

```
                 +------------------------------------+
                 |         ToolRegistry                |
                 |   注册 . 查找 . Schema . 统计        |
                 +--------------+---------------------+
                                |
          +---------------------+---------------------+
          |                     |                      |
          v                     v                      v
   +----------------+  +----------------+  +----------------+
   | SecurityPlugin |  |   中间件       |  |   生命周期     |
   | (Hook)         |  |   (Pipeline)   |  |   钩子         |
   +----------------+  +----------------+  +----------------+
          |                     |                      |
          +---------------------+----------------------+
                                v
                 +------------------------------------+
                 |         ToolDef.execute()           |
                 |   具体的工具实现                     |
                 +------------------------------------+
```

- **ToolRegistry**：工具注册表——注册、查找、执行工具，维护统计
- **ToolDef**：单个工具定义——名称、描述、JSON Schema 参数、执行函数
- **SecurityPlugin**：通过 LifecycleHook 在 `onBeforeToolCall` 介入，执行安全策略
- **Middleware**：在 before/after/onError 阶段插入自定义逻辑

---

## ToolRegistry — 注册与执行核心

**文件**：`registry.ts`

### 注册 API

```typescript
const registry = new ToolRegistry();

// 注册单个工具
registry.register(readFileTool);

// 按组批量注册
registry.registerGroup(
  { name: "file", description: "文件操作", defaults: { timeoutMs: 10_000 } },
  [readFileTool, writeFileTool, editFileTool]
);

// 按组查询
registry.getGroup("file"); // -> { group, tools }

// 注册安全钩子（作为 LifecycleHook）
const security = new SecurityPlugin(config);
registry.use(security);

// 注册中间件
registry.addMiddleware({ name: "audit", before: ..., after: ... });
```

### Schema 导出

```typescript
// 导出所有工具对 LLM 可见的 Schema
registry.getSchemas(); // -> Tool[]

// 按组筛选
registry.getSchemasByGroup("file"); // -> Tool[]
```

`getSchemas()` 返回的 `Tool[]` 数组作为工具列表传给 `adapter.complete()`，供 LLM function calling 使用。

### 执行流程

```
execute(name, args, ctx)
  |
  +-- 1. 查找 ToolDef（未找到 -> errorResult("UNKNOWN")）
  +-- 2. 检查 dryRun（若 true -> 返回模拟结果，跳过实际执行）
  +-- 3. 检查废弃标记（非阻塞警告）
  +-- 4. LifecycleHook.onBeforeToolCall（SecurityPlugin 在此短路）
  +-- 5. Middleware.before（可修改 args、跳过执行）
  +-- 6. 幂等缓存检查
  +-- 7. 执行 + 超时控制 + 重试（最多 3 次，指数退避）
  +-- 8. Middleware.after（可转换结果）
  +-- 9. LifecycleHook.onAfterToolCall
  +-- 10. 更新幂等缓存
  +-- 11. 记录统计（ToolStatsCollector）
```

#### 重试策略

- 默认最多 3 次重试（`maxRetries = 3`）
- 指数退避：`100ms * 2^attempt`
- 仅在 `error.retryable === true` 时重试
- 最终尝试失败时调用 Middleware.onError 尝试恢复

#### 幂等缓存

标记为 `options.idempotent = true` 的工具（如 `read_file`、`list_dir`、`glob`、`grep`），首次成功结果被缓存。后续相同 `(toolName, args)` 的调用直接返回缓存结果，避免冗余操作。

---

## ToolDef — 工具定义

**文件**：`types.ts`

```typescript
interface ToolDef<TArgs = object> {
  name: string;                // 工具名称（LLM 可见）
  description: string;         // 工具描述（LLM 可见，用于 function calling）
  parameters: JSONSchema;      // JSON Schema 参数定义
  options?: {
    timeoutMs?: number;        // 执行超时（默认 30s）
    retries?: number;          // 重试次数
    idempotent?: boolean;      // 是否幂等（结果可缓存）
    riskLevel?: "low" | "medium" | "high";  // 风险等级
  };
  version?: ToolVersion;       // 版本和废弃信息
  group?: string;              // 工具分组
  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}
```

### ToolContext — 执行上下文

传递给每个工具执行的上下文，包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `cwd` | `string` | 当前工作目录 |
| `sessionId` | `string` | 会话 ID |
| `allowedPaths` | `string[]` | 允许的路径列表 |
| `env` | `Record<string, string>` | 环境变量 |
| `signal` | `AbortSignal` | 取消信号 |
| `dryRun` | `boolean` | 是否模拟执行 |
| `onOutput` | `(chunk: string) => void` | 流式输出回调 |
| `memoryStore` | `MemoryStore?` | 记忆存储（供 memory_write/memory_search 使用） |
| `vectorStore` | `VectorStore?` | 向量存储（供 knowledge_search 使用） |
| `llmAdapter` | `LLMAdapter?` | LLM 适配器（供 visual_analyze 使用） |
| `sandboxProvider` | `SandboxProvider?` | 沙箱提供者（供 sandbox_exec 使用） |

### ToolResult — 执行结果

```typescript
interface ToolResult {
  ok: boolean;                          // 执行是否成功
  content: string;                      // 结果文本（展示给 LLM）
  metadata?: {
    bytesRead?: number; linesRead?: number;
    linesChanged?: number; exitCode?: number;
    truncated?: boolean;
    renderHint?: RenderHint;            // 渲染提示（供 REPL UI 使用）
    diff?: { filePath: string; hunks: StructuredPatchHunk[] };
  };
  error?: { code: ToolErrorCode; message: string; retryable: boolean };
  retryCount?: number;
  needsConfirm?: { message: string; allowDir: string; retry: ... };
  dryRun?: boolean;
}
```

`needsConfirm` 字段用于**安全确认**场景——当 SecurityPlugin 检测到需要用户批准的操作时，返回 `needsConfirm` 结果而非直接拒绝。REPL 层显示确认提示，用户批准后重试调用。

---

## 内置工具一览

`index.ts` 中的 `createToolRegistry()` 默认注册 13 个核心工具，外加条件注册工具（依赖外部服务）。

### 文件操作工具

#### 1. read_file
**文件**：`read-file.ts` | **风险**：低 | **幂等**：是

读取文件内容，返回带行号的文本。支持 offset/limit 分页。自动检测并拒绝二进制文件。最大输出 2000 行。结果携带 `renderHint: { type: "code" }`。

#### 2. write_file
**文件**：`write-file.ts` | **风险**：中

创建或覆盖文件，自动创建父目录。使用原子写入（临时文件 -> 重命名，防止中断时损坏）。写入前检查**内容过期**——如果文件被外部修改且未重新读取，写入被拒绝。返回 unified diff。

#### 3. edit_file
**文件**：`edit-file.ts` | **风险**：中

精确字符串替换。要求 `old_string` 在文件中**恰好出现一次**（0 次匹配 = NOT_FOUND 错误，多次 = 歧义错误）。同样使用原子写入和过期检查。返回 unified diff。

#### 4. list_dir
**文件**：`list-dir.ts` | **风险**：低 | **幂等**：是

列出目录内容，用图标区分文件和目录，显示文件大小和子目录条目数。

#### 5. glob
**文件**：`glob.ts` | **风险**：低 | **幂等**：是

按 glob 模式搜索文件。支持 `*`（单层）、`**`（递归）、`?`（单字符）。自动跳过 `node_modules`、`.git`、`.vera`、`dist`、`build`。返回按路径排序的匹配列表。

#### 6. grep
**文件**：`grep.ts` | **风险**：低 | **幂等**：是

按正则表达式搜索文件内容。支持递归目录搜索、glob 文件名过滤、上下文行显示。自动跳过二进制文件。最多返回 200 条匹配记录。

### 命令执行工具

#### 7. bash
**文件**：`bash.ts` | **风险**：高

在独立进程组中执行 Shell 命令。特性：
- 流式收集 stdout/stderr；输出超过 512KB 时终止进程
- 支持 `ctx.signal` 取消
- 命令后安全网：最终输出上限 80K 字符
- 分别处理超时、取消、输出溢出错误
- 返回 `renderHint: { type: "bash-output", exitCode }`

### 条件注册工具

以下工具仅在提供对应依赖时才注册：

- **memory_write / memory_search**（需 `memoryStore`）：持久化记忆写入和语义搜索
- **knowledge_search**（需 `vectorStore` + `embeddingAdapter`）：RAG 知识库搜索
- **visual_analyze**（需 `llmAdapter`）：图像/视觉分析
- **sandbox_exec / sandbox_upload / sandbox_download**（需 `sandboxProvider`）：隔离沙箱执行
- **file_upload / file_download / file_list**（需 `objectStore`）：对象存储操作
- **browser**：内置浏览器工具（Puppeteer 集成）
- **desktop_screenshot / desktop_input / desktop_script / desktop_accessibility**：桌面自动化工具
- **computer_use**：全面的 Computer Use 能力

---

## SecurityPlugin — 安全策略

**文件**：`security.ts`

SecurityPlugin 实现 `ToolLifecycleHook` 接口，在 `onBeforeToolCall` 中执行多层安全检查。检查顺序：

```
1. 拒绝列表检查（deniedTools）
2. 允许列表检查（allowedTools）
3. Bash 危险命令检测（rm -rf, sudo, chmod 777, dd of=, git push --force）
   +- 触发 needsConfirm（需用户确认）
4. 只读模式检查（readonlyMode -> 拒绝 write_file/edit_file/bash）
5. 预算检查（budgetUsd）
6. 路径边界检查（路径不得超出 workdir）
   +- 触发 needsConfirm（需用户批准路径）
7. 域名白名单检查（allowedDomains）
8. Prompt 注入检测（如 "ignore previous instructions" 模式）
```

### SecurityConfig

```typescript
interface SecurityConfig {
  allowedTools?: string[];          // 工具白名单（空 = 允许全部）
  deniedTools?: string[];           // 工具拒绝列表（优先级高于白名单）
  allowedBashCommands?: string[];   // 允许的 bash 命令（glob 匹配）
  deniedBashCommands?: string[];    // 拒绝的 bash 命令（glob 匹配）
  workdir?: string;                 // 文件操作的路径边界
  allowedDomains?: string[];        // 网络工具的域名白名单
  readonlyMode?: boolean;           // 只读模式（拒绝写操作）
  budgetUsd?: number;               // 预算上限（美元）
  usdUsed?: number;                 // 已消耗费用
}
```

---

## 权限规则系统

**文件**：`permission-rules.ts`

支持两级权限配置：

1. **全局**：`~/.vera/permissions.json`
2. **项目级**：`<project>/.vera/permissions.json`

两级**合并**（项目级追加在全局之后）。优先级：deniedTools > allowedTools。

```json
{
  "allowedTools": ["read_file", "list_dir", "glob", "grep", "write_file", "edit_file"],
  "deniedTools": ["bash"],
  "allowedBashCommands": ["ls", "cat", "echo", "find", "wc"],
  "deniedBashCommands": ["rm -rf *", "sudo *"]
}
```

Bash 命令匹配使用类 glob 模式（`*` 匹配任意字符）。

---

## 中间件系统

**文件**：`types.ts -> ToolMiddleware`

中间件提供三阶段钩子，在工具执行前后插入自定义逻辑：

```typescript
interface ToolMiddleware {
  name: string;

  // 执行前：可修改 args 或返回 skip+result 跳过执行
  before?: (name, args, ctx) => Promise<{
    args: Record<string, unknown>;
    skip?: boolean;
    result?: ToolResult;
  } | null>;

  // 执行后：可转换结果
  after?: (name, args, result, ctx) => Promise<ToolResult>;

  // 出错时：可恢复（返回 ToolResult）或放弃（返回 null）
  onError?: (name, args, error, ctx) => Promise<ToolResult | null>;
}
```

多个中间件组成**管道**，按注册顺序执行：

```
before1 -> before2 -> execute -> after1 -> after2
```

`onError` 仅在最终重试失败后调用，按注册顺序尝试恢复。

---

## 工具统计

**文件**：`tool-stats.ts`

`ToolStatsCollector` 自动记录每次工具调用的元数据，提供：

- **单工具统计**：`getStats(toolName)` -> 调用次数、成功率、错误率、延迟分布
- **全局统计**：`getAllStats()` -> 所有工具的聚合指标
- **Top N 工具**：`topTools(10)` -> 按调用次数排名
- **延迟百分位**：P50 / P95 / P99

默认保留：最近 1,000 条调用记录（FIFO 淘汰）。

---

## 自定义工具注册

```typescript
const myTool: ToolDef<{ name: string }> = {
  name: "greet",
  description: "按名称问候某人",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "要问候的名字" }
    },
    required: ["name"]
  },
  options: { timeoutMs: 5_000, riskLevel: "low", idempotent: true },
  async execute(args, ctx) {
    return { ok: true, content: `你好，${args.name}！` };
  }
};

registry.register(myTool);
```

---

## 渲染提示（Render Hints）

每个工具结果可携带 `metadata.renderHint`，指导 REPL UI 如何展示结果：

| RenderHint 类型 | 用途 |
|---|---|
| `{ type: "text" }` | 纯文本展示 |
| `{ type: "code", lang? }` | 语法高亮代码块 |
| `{ type: "diff" }` | Unified diff 视图 |
| `{ type: "file-list" }` | 文件列表视图 |
| `{ type: "image", mimeType }` | 图片展示 |
| `{ type: "error" }` | 红色错误信息 |
| `{ type: "bash-output", exitCode }` | 终端风格输出 |

---

## 工具创建入口

**文件**：`index.ts -> createToolRegistry()`

```typescript
const { registry, security } = createToolRegistry({
  cwd: "/path/to/project",
  security: { readonlyMode: false },
  sessionStore,          // 可选：启用 AnalyticsPlugin
  memoryStore,           // 可选：注册记忆工具
  vectorStore,           // 可选：注册 knowledge_search
  embeddingAdapter,      // 可选：供 vectorStore 使用
  llmAdapter,            // 可选：注册 visual_analyze
  sandboxProvider,       // 可选：注册沙箱工具
  objectStore,           // 可选：注册 file_upload/download/list
});
```

`createToolRegistry()` 自动处理：
1. 注册所有内置工具
2. 加载权限规则（从 `~/.vera/permissions.json` 和项目 `.vera/permissions.json`）
3. 注册 SecurityPlugin 作为第一个钩子（确保安全检查最先执行）
4. 可选注册 AnalyticsPlugin（需要 SessionStore）
5. 可选注册条件工具（记忆、knowledge_search、visual_analyze、沙箱、存储）

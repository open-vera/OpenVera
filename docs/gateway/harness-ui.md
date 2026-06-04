# Harness Web UI 方案

## 概述

Harness Web UI 是 Vera 框架的图形化管理界面，提供项目发现、能力清单、运行监控、健康检查、对话交互等功能。它由两个独立进程组成：一个 Node.js HTTP 后端（Express）和一个 Vue 3 单页应用前端。前后端通过 REST API 和 SSE 通信，后端直接读取本地 `.vera` 目录下的文件系统数据，无需额外数据库。

**代码位置：**

- 后端：`apps/gateway-ui/server/`
- 前端：`apps/gateway-ui/web/`
- 共享类型与核心逻辑：`packages/gateway/`

**启动方式：**

```bash
# 后端（默认端口 7720）
npx vera-gateway-serve --root /path/to/project1 --root /path/to/project2

# 前端开发模式
cd apps/gateway-ui/web && pnpm dev
```

后端通过 `--root` 参数指定一个或多个工作区根目录，`ProjectRegistry` 会递归扫描这些目录及其子目录，发现所有包含 `.vera` 或 `package.json` 的项目。

---

## 整体架构

```
Browser (Vue 3 SPA)
  │
  │  REST + SSE
  ▼
Express Server (port 7720)
  │
  ├─ GatewayState ─────────────────────────────┐
  │   ├─ ProjectRegistry.discover()            │  扫描文件系统
  │   ├─ CapabilityRegistry.registerMany()     │  枚举项目能力
  │   └─ DoctorService.run()                   │  运行健康检查
  │
  ├─ Runtime Stores ───────────────────────────┐
  │   ├─ runtime-store   (runs/flows/checkpoints)│  读取 .vera/flows/
  │   ├─ conversation-store  (对话内存)          │  Map 内存存储
  │   ├─ operations-store   (运维监控)           │  CPU/内存/活跃度
  │   └─ timeline-stream    (SSE 实时推送)       │  ndjson 轮询
  │
  ├─ Execution Runtimes ───────────────────────┐
  │   ├─ chat-runtime    (@open-vera/core)     │  多 provider 适配
  │   ├─ mcp-runtime     (MCP 配置解析)         │  .mcp-servers.json
  │   └─ rag-runtime     (关键词检索)           │  .vera/rag/ 全文扫描
  │
  └─ Action Dispatcher ────────────────────────┐
      ├─ /api/manage/:action   管理类动作        │  同步返回 accepted
      └─ /api/execute/:action  执行类动作        │  异步执行返回结果
```

### 技术选型

| 层 | 技术 | 原因 |
|---|---|---|
| 前端框架 | Vue 3 + Vue Router | SPA 路由，组件化视图 |
| 构建工具 | Vite | 快速 HMR，ESM 原生支持 |
| 后端框架 | Express | 轻量 HTTP 服务，中间件生态 |
| 数据持久化 | 文件系统（ndjson） | 无外部依赖，直接读 `.vera` 目录 |
| 实时通信 | SSE (Server-Sent Events) | 单向推送 timeline 事件，比 WebSocket 更简单 |
| 对话存储 | 内存 Map | 轻量会话，进程重启即清空 |

### 设计原则

1. **零配置数据库**：所有数据来源为文件系统（`.vera/` 下的 ndjson、json 文件），不需要安装 PostgreSQL、Redis 等外部存储。
2. **只读优先**：除对话创建和运行触发外，所有查询接口均为 GET，不修改源文件。
3. **GatewayState 即时扫描**：`loadGatewayState()` 在每次请求时重新扫描文件系统，保证数据始终是最新的（文件系统扫描开销低，不需要内存缓存）。
4. **进程分离**：后端和前端独立部署，通过 CORS 跨域通信。后端可脱离前端独立运行作为 headless API 服务。

---

## 后端模块

### 入口文件：`server/src/index.ts`

Express 应用，定义全部 API 路由。核心流程：

1. 解析 CLI 参数（`--port`、`--root`）
2. 注册 CORS 和 JSON body 解析中间件
3. 注册所有 REST 路由（见下方 API 设计）
4. 启动 HTTP 监听

每个请求到达时调用 `loadGatewayState(args.roots)` 获取最新的项目、能力和健康检查快照。

### GatewayState（`server/src/state.ts`）

```typescript
interface GatewayState {
  projects: GatewayProject[];              // 发现的项目列表
  capabilities: CapabilityDescriptor[];    // 所有项目的能力清单
  doctor: DoctorReport;                    // 健康检查报告
}
```

`loadGatewayState()` 的执行顺序：先通过 `ProjectRegistry.discover()` 扫描项目，再为每个项目调用 `createProjectCapabilityInventory()` 生成能力列表，最后运行 `DoctorService.run()` 生成健康检查报告。

### Runtime Store（`server/src/runtime-store.ts`）

最核心的数据读取模块，负责从 `.vera/flows/iterations/` 目录读取运行数据。

**数据结构：**

```
.vera/flows/iterations/
  iter-2026-06-04T10-30-00-000Z/
    timeline.ndjson     ← 运行事件流（每行一个 JSON 事件）
    checkpoints.ndjson  ← 检查点索引
    subagents.json      ← 子 agent 调用树
    memory/             ← 分层记忆
      episodic.jsonl
      semantic.jsonl
      working.jsonl
    artifacts/          ← 步骤产物
      plan-001.json
      step-001.json
      ...
```

**关键函数：**

| 函数 | 功能 |
|---|---|
| `listRuns()` | 列举所有项目的运行历史，按启动时间倒序 |
| `getRun()` | 获取单次运行详情（含 timeline、步骤聚合、产物列表） |
| `getTimeline()` | 读取原始 ndjson 事件流 |
| `getMemory()` | 读取分层记忆，支持按 tier 过滤和关键词搜索 |
| `getCheckpoints()` | 读取流程检查点索引 |
| `getSubagents()` | 读取子 agent 池状态和调用树 |
| `getCostSummary()` | 汇总所有运行的费用（USD） |
| `spawnRun()` | 通过 `child_process.spawn` 启动一个新的 `openvera flow run` 进程 |
| `listFlows()` | 解析 `.vera/flows/flow/` 下的 flow 定义（Markdown frontmatter） |

**运行状态推断：**

通过解析 timeline 事件流来推断运行状态：
- 包含 `flow_completed` 事件 → `completed`
- 包含 `flow_failed` 事件 → `failed`
- 包含 `approval_requested` 事件 → `paused`
- 其他情况 → `running`

### Timeline Stream（`server/src/timeline-stream.ts`）

提供 SSE 实时事件推送。工作流程：

1. 读取 timeline ndjson 文件的当前内容，解析为事件数组并逐条推送
2. 如果运行处于 `running` 状态（或请求参数 `live=1`），启动 1 秒间隔的轮询
3. 每次轮询读取文件新增内容（基于 offset），增量推送新事件
4. 当检测到 `flow_completed` 或 `flow_failed` 终端事件时，发送 `done` 事件并关闭连接

前端可通过 `EventSource` 或 `fetch` + ReadableStream 消费该接口。

### Conversation Store（`server/src/conversation-store.ts`）

纯内存存储，使用 `Map<string, Conversation>` 结构。支持创建对话、追加消息、按项目过滤列表。

对话生命周期完全在进程内，服务重启后消失。这是有意为之——对话是临时交互界面，持久化由 flow 的运行记录负责。

### Chat Runtime（`server/src/chat-runtime.ts`）

对话 LLM 调用层。从项目的 `.vera/settings.json` 读取 provider 配置，支持 Anthropic、OpenAI、Gemini 三种 adapter。未配置 API Key 时返回 placeholder 文本（"未配置 LLM"），不会报错。

### Operations Store（`server/src/operations-store.ts`）

运维监控模块，提供宿主机资源指标（CPU 核心数、内存使用率、磁盘使用率）和项目活跃度热力图（按小时统计 run 启动次数）。

### Action Dispatcher（`server/src/actions.ts`）

统一动作分发机制，分为两类：

- **ManagementAction**：管理类动作（`config.edit`、`mcp.reload`、`skill.reload`、`rag.reindex`、`channel.connect/disconnect`、`sandbox.test`），同步返回 `accepted` 确认
- **ExecutionAction**：执行类动作（`chat.send`、`flow.run`、`rag.search`、`mcp.tool.call`、`sandbox.run`），异步执行并返回结果

---

## 前端模块

### 路由设计（`web/src/router.ts`）

| 路径 | 组件 | 说明 |
|---|---|---|
| `/` | OverviewView | 网关总览：项目数、能力数、Doctor 状态 |
| `/projects` | ProjectsView | 项目列表 |
| `/projects/:projectId` | ProjectDetailView | 项目详情：能力清单、运行活跃度 |
| `/capabilities` | CapabilitiesView | 全部能力列表，支持按 kind 过滤 |
| `/skills` | CapabilityKindView | 技能目录（kind=skill 的过滤视图） |
| `/mcp` | McpView | MCP 服务器和工具列表（懒加载） |
| `/rag` | RagView | RAG 知识库检索界面（懒加载） |
| `/cost` | CostView | 费用汇总 |
| `/chat` | ChatView | 对话界面 |
| `/chat/:conversationId` | ChatView | 指定对话详情 |
| `/runs` | RunsWorkspaceView | 运行工作区（侧栏 + 详情） |
| `/runs/:runId` | RunShell | 单次运行详情壳 |
| `/runs/:runId/memory` | RunMemoryTab | 运行记忆面板 |
| `/runs/:runId/checkpoints` | RunCheckpointsTab | 运行检查点面板 |
| `/runs/:runId/subagents` | RunSubagentsTab | 子 agent 面板 |
| `/runs/:runId/timeline` | RunTimelineTab | 时间线实时事件面板 |
| `/management` | ManagementView | 管理动作触发器 |
| `/execution` | ExecutionView | 执行动作触发器 |
| `/operations` | OperationsView | 运维监控面板 |
| `/doctor` | DoctorView | 健康检查结果表 |
| `/settings` | SettingsView | 设置页面 |

### RunsWorkspaceView（运行工作区）

左侧栏：Flow 启动面板（选择项目和 Flow → Start run）+ 运行历史列表（按状态着色）。

右侧详情区：嵌套路由 `<router-view>`，根据选中 run 渲染对应的 tab：
- **Overview**（RunOverviewTab）：运行摘要、步骤列表、产物 ID
- **Memory**（RunMemoryTab）：分层记忆查看，支持按 tier 筛选和全文搜索
- **Checkpoints**（RunCheckpointsTab）：流程检查点列表，可展开查看原始数据
- **Subagents**（RunSubagentsTab）：子 agent 池状态（活跃/排队）和调用树
- **Timeline**（RunTimelineTab）：通过 SSE 实时接收并展示 timeline 事件流

运行中状态每 5 秒自动刷新，完成后停止轮询。

### 统一的 API 客户端（`web/src/api.ts`）

前端通过 `gatewayApi` 对象调用后端接口，封装了类型安全的 `getJson<T>()` 函数和所有 endpoint 方法。接口返回类型与后端完全对齐，编译时即能发现不匹配。

`useStream` composable（`web/src/composables/useStream.ts`）封装了 SSE 消费逻辑，用于 timeline 实时推送场景。

---

## 核心概念

### Project Registry（项目注册表）

`packages/gateway/src/project-registry.ts`

负责发现和验证工作区中的项目。扫描逻辑：

1. 遍历 `--root` 指定的根目录
2. 如果 `includeChildren: true`（默认），递归扫描一级子目录
3. 判定标准：目录下存在 `.vera/` 或 `package.json`
4. 每个项目生成唯一 ID：`{name}-{sha1(rootDir)[:8]}`
5. 记录来源：`"explicit"`（命令行指定）或 `"discovered"`（子目录扫描）

### Capability Manager（能力管理器）

`packages/gateway/src/capability-registry.ts`

每个项目自动生成 15 种能力描述符：

| Kind | 名称 | 来源路径 | 可用动作 |
|---|---|---|---|
| `config` | Vera config | `.vera/settings.json` | view, edit, test |
| `prompt` | Workspace prompt | `CLAUDE.md` | view, edit, reload |
| `context` | Project context | `.vera/context` | view, reload |
| `memory` | Project memory | `.vera/memory` | view, edit, reload |
| `rag` | RAG index | `.vera/rag` | view, reindex, test |
| `skill` | Project skills | `.claude/skills` | view, edit, reload |
| `plugin` | Plugin registry | `.vera/plugins` | view, enable, disable, reload |
| `mcp` | MCP servers | `.cursor/projects` | view, test, reload |
| `channel` | Channels | `.vera/channels` | view, connect, disconnect, test |
| `sandbox` | Sandbox providers | `.vera/sandbox` | view, test |
| `flow` | Flows | `.vera/flows` | view, edit, reload |
| `conversation` | Conversations | `.vera/conversations` | view, edit |
| `tool` | Tool policies | `.vera/permissions.json` | view, edit, reload |
| `log` | Runtime logs | `.vera/logs` | view |
| `cost` | Cost management | `.vera/cost` | view, test |

每种能力的状态有四种：`available`（文件存在）、`disabled`、`error`（health check 失败）、`unknown`（文件不存在）。

### Doctor（健康检查）

`packages/gateway/src/doctor.ts`

`DoctorService` 对每个项目和能力执行三级检查：

1. **Gateway 级**：项目注册表检查（是否有项目被发现）
2. **Project 级**：项目根目录、`.vera` 目录、flow 目录的存在性
3. **Capability 级**：每个能力对应的源文件/目录是否存在

检查状态：`pass` / `warn` / `fail`。汇总规则：
- 存在任一 `fail` → 整体 `fail`
- 存在任一 `warn` 且无 `fail` → 整体 `warn`
- 全部 `pass` → 整体 `pass`

---

## API 设计

所有接口前缀 `/api`，返回 JSON。成功时 HTTP 200/201/202，失败时返回 `{ error: string }` 及对应状态码。

### 网关级

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/gateway/overview` | 网关总览（项目数、能力汇总、Doctor 状态） |
| GET | `/api/gateway/doctor` | 健康检查完整报告 |
| GET | `/api/gateway/operations/summary` | 运维摘要（运行中/完成/失败数 + 项目活跃度） |
| GET | `/api/gateway/operations/resources` | 宿主机资源（CPU、内存、磁盘） |
| GET | `/api/gateway/operations/activity` | 24 小时运行活跃度热力图 |

### 项目

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/projects` | 项目列表 |
| GET | `/api/projects/:projectId` | 项目详情（含能力清单和活跃度） |
| GET | `/api/projects/:projectId/capabilities` | 项目能力清单 |
| GET | `/api/projects/:projectId/runs` | 项目运行历史 |
| GET | `/api/projects/:projectId/flows` | 项目 flow 模板列表 |
| GET | `/api/projects/:projectId/rag/search?q=` | 项目 RAG 检索 |
| GET | `/api/projects/:projectId/mcp/servers` | 项目 MCP 服务器列表 |
| GET | `/api/projects/:projectId/mcp/tools` | 项目 MCP 工具列表 |

### 能力

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/capabilities` | 全部能力列表 |
| GET | `/api/capabilities?kind=skill` | 按 kind 过滤能力 |

### 运行

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/runs` | 运行列表（支持 `?projectId=` 过滤） |
| POST | `/api/runs` | 启动运行（body: `{ projectId, flowDir, model, provider }`） |
| GET | `/api/runs/:runId` | 运行详情（含 timeline、步骤、产物） |
| GET | `/api/runs/:runId/timeline` | 运行 timeline 原始事件 |
| GET | `/api/runs/:runId/stream?live=1` | SSE 实时事件流 |
| GET | `/api/runs/:runId/steps/:stepId` | 步骤详情 |
| GET | `/api/runs/:runId/artifacts/:artifactId` | 步骤产物内容 |
| GET | `/api/runs/:runId/memory?tier=&search=` | 运行记忆（支持分层筛选和搜索） |
| GET | `/api/runs/:runId/checkpoints` | 运行检查点列表 |
| GET | `/api/runs/:runId/checkpoints/:checkpointId` | 单个检查点详情 |
| GET | `/api/runs/:runId/subagents` | 子 agent 池状态和调用树 |

### Flow

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/flows` | Flow 模板列表（支持 `?projectId=` 过滤） |

### 对话

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/conversations` | 对话列表（支持 `?projectId=` 过滤） |
| POST | `/api/conversations` | 创建对话（body: `{ projectId, title }`） |
| GET | `/api/conversations/:conversationId` | 对话详情 |
| POST | `/api/conversations/:conversationId/messages` | 发送消息（body: `{ role, content }`） |

发送消息时，如果 role 为 `user`，后端会自动调用 LLM 生成 assistant 回复并追加到对话中。

### 动作分发

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/manage/:action` | 管理类动作（同步返回 accepted） |
| POST | `/api/execute/:action` | 执行类动作（异步执行返回结果） |

### 费用

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/cost` | 费用汇总（总费用 + 按 run 明细） |

---

## 数据流示意

### 启动运行的完整数据流

```
1. 用户在前端点击 "Start run"
2. POST /api/runs  { projectId, flowDir }
3. server/runtime-store.spawnRun()
   ├─ 生成 runId: iter-{ISO timestamp}
   ├─ child_process.spawn("openvera", ["flow", "run", "--dir", flowDir])
   │    └─ @open-vera/harness HarnessRuntime.run()
   │         ├─ Planner: 生成 ExecutionPlan
   │         ├─ Agent:   执行步骤 → 写入 artifacts/
   │         ├─ Memory:  提取记忆 → 写入 memory/
   │         ├─ Checkpoint: 保存检查点 → 写入 checkpoints.ndjson
   │         └─ Timeline: 记录事件 → 追加 timeline.ndjson
   └─ 返回 { runId, startedAt }
4. 前端跳转到 /runs/:runId
5. RunTimelineTab 连接 GET /api/runs/:runId/stream?live=1
6. 后端每秒读取 timeline.ndjson 增量，SSE 推送新事件
7. 检测到 flow_completed 或 flow_failed → 发送 done，关闭 SSE
```

### Timeline 事件类型

timeline ndjson 中记录的关键事件类型：

| 事件类型 | 含义 | 关键字段 |
|---|---|---|
| `flow_started` | 流程启动 | goal, ts |
| `step_dispatched` | 步骤分发执行 | stepId, agent |
| `step_start` | 步骤正式启动 | stepId, step |
| `agent_call` | 调用 agent | agent, model |
| `step_done` | 步骤完成 | stepId, status, score |
| `step_failed` | 步骤失败 | stepId, error |
| `approval_requested` | 请求人工审批 | stepId, message |
| `approval_granted` | 审批通过 | stepId |
| `checkpoint_created` | 检查点创建 | checkpointId, state |
| `flow_completed` | 流程完成 | goal, totalUsd |
| `flow_failed` | 流程失败 | error, totalUsd |

---

## 扩展点

当前 Web UI 为 v0.3 版本，以下是已识别但尚未实现的改进方向：

1. **WebSocket 替代 SSE 轮询**：当前 timeline 实时推送基于每秒轮询文件，对于高频率事件场景可改为 `fs.watch` + WebSocket 推送，降低延迟。
2. **对话持久化**：当前 conversation 存储在进程内存中，重启丢失。可持久化到 `.vera/conversations/` 的 ndjson 文件中。
3. **认证与多用户**：当前无认证机制，所有访问者可看到所有项目数据。适用于本地开发场景，生产部署需要集成 OAuth 或 API Key 认证。
4. **向量检索增强**：当前 RAG 检索回退到关键词匹配，需要集成 embedding adapter 实现真正的语义搜索。
5. **执行动作的异步状态查询**：当前 `/api/execute/:action` 是请求-响应模式，长耗时动作（如 flow.run）的进度无法查询，需要引入任务队列和状态轮询接口。
6. **Capability 实时健康检测**：当前健康检查的"资源存在性"判断是静态的（文件是否存在），可扩展为实际连通性测试（如 MCP 连接测试、Provider API 连通性测试）。

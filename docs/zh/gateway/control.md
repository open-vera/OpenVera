# Vera 控制网关方案

> 目标：为项目、能力、运行时服务和 UI 界面提供一个统一的控制面，而不将执行逻辑移出 Core 或 Harness。

## 原则

- 网关是控制面：服务发现、配置、诊断、编排和展示。
- Core 仍然是单次调用的运行时边界，负责 config、tools、channels、memory、MCP、prompt、context、sandbox 和 RAG 原语。
- Harness 仍然是工作流边界，负责 flows、runs、checkpoints、critique、replanning 和 subagents。
- UI 应用通过 Gateway API 获取数据，而非各自独立扫描项目文件。
- 敏感文件受保护：Gateway 仅报告其存在和脱敏后的元数据，绝不暴露原始密钥。

## 目标架构

```text
apps/gateway-ui
  -> packages/gateway
    -> packages/harness
      -> packages/core
```

`packages/gateway` 持有 UI 和服务端共用的领域模型：

- `ProjectRegistry`：发现本地项目及其 `.vera` 资源。
- `CapabilityRegistry`：将 config、skills、memory、rules、MCP、RAG、prompts、context、sandbox、plugins、channels、flows、logs 和 conversations 归一化为统一的描述符模型。
- `DoctorService`：对项目和能力运行只读健康检查。
- `GatewayRuntime`（后续）：启动 flow、绑定 channel、恢复对话、流式推送事件。

## 能力模型

每个被管理的界面都表示为一个能力：

- `config`：provider、model、routing、session、MCP server 配置。
- `prompt`：system prompt、agent prompt、flow stage prompt、skill prompt。
- `context`：上下文预算、压缩、注入来源、token 核算。
- `memory`：用户/项目/参考/反馈记忆及自动提取。
- `rag`：文档来源、embedding adapter、vector store、索引新鲜度。
- `skill`：本地 skill、skill 进化、推荐、版本管理、热重载。
- `plugin`：tool、channel、sandbox、adapter 和 MCP plugin 注册。
- `mcp`：server 状态、tools、resources、auth、schema、调用记录。
- `channel`：CLI、API、webhook、飞书、Slack、Telegram、Discord、企微、WhatsApp。
- `sandbox`：本地、Docker、E2B、CubeSandbox 等 provider 及调用日志。
- `flow`：flows、stages、agents、runs、checkpoints、artifacts、subagents。
- `conversation`：聊天会话、绑定 channel 的会话、flow 对话。
- `log`：运行时日志、traces、成本、tokens、事件、artifacts。

描述符刻意面向 UI 设计：包含 id、kind、scope、source、status、health 和允许的操作。执行逻辑仍在 manager service 之后。

## Gateway API 形态

初始只读 API：

```text
GET /api/gateway/overview
GET /api/gateway/doctor
GET /api/gateway/operations/summary
GET /api/gateway/operations/resources
GET /api/gateway/operations/activity
GET /api/projects
GET /api/projects/:projectId
GET /api/projects/:projectId/capabilities
GET /api/capabilities
GET /api/flows
GET /api/runs
GET /api/runs/:runId
GET /api/runs/:runId/timeline
GET /api/runs/:runId/stream
GET /api/runs/:runId/memory
GET /api/runs/:runId/checkpoints
GET /api/runs/:runId/subagents
GET /api/cost
POST /api/runs
GET /api/conversations?projectId=
POST /api/conversations
POST /api/conversations/:id/messages
POST /api/manage/:action
POST /api/execute/:action
```

`POST /api/execute/flow.run` 启动 `openvera flow run`；`POST /api/execute/chat.send` 通过 `@open-vera/core` `runAgent` 生成回复（无 API Key 时回退为占位文本）。

`GET /api/runs/:runId/stream?live=1` 在 run 进行中以每秒一次的频率 tail `timeline.ndjson`。

`GET /api/projects/:projectId/rag/search?q=` 对 `.vera/rag` 进行关键词搜索；`GET /api/projects/:projectId/mcp/servers|tools` 发现 MCP 配置。

只读层稳定后的管理 API：

```text
POST /api/projects/:projectId/rag/reindex
POST /api/projects/:projectId/skills/reload
POST /api/projects/:projectId/mcp/:serverId/reload
POST /api/channels/:name/connect
POST /api/channels/:name/disconnect
POST /api/conversations
POST /api/conversations/:id/messages
POST /api/runs
```

## UI 信息架构

- 概览（Overview）：项目、活跃 run、channels、MCP、sandbox、doctor 摘要。
- 项目（Projects）：项目列表、资源路径、近期 run、能力清单。
- 能力（Capabilities）：分组的能力清单和状态筛选。
- 聊天（Chat）：项目级对话、channel 绑定、flow 驱动的聊天。
- 流程（Flows）：flow 目录、stage/agent prompt、run 启动器、run 历史。
- 运行（Runs）：时间线、artifacts、checkpoints、memory、subagents。
- RAG：来源、索引、embedding provider、vector store、搜索测试。
- 记忆（Memory）：记忆文件、提取策略、使用统计、整理任务。
- 技能（Skills）：skill 目录、版本、评分、推荐、重载。
- MCP：servers、tools、resources、auth 状态、schema、调用历史。
- 通道（Channels）：adapter、连接状态、会话、消息历史。
- 沙箱（Sandbox）：provider 状态、限制、调用日志、错误。
- Prompts 与 Context：prompt 图、上下文预算、压缩、注入。
- 日志（Logs）：按 project/run/session/tool/MCP/sandbox/channel 筛选。
- 诊断（Doctor）：可操作的诊断项和建议修复。

## 实施阶段

1. 只读基础
   - 新增 `packages/gateway`。
   - 实现项目发现、能力描述符和 doctor 检查。
   - 暴露用于未来 server 的类型化 API。

2. Gateway 服务端
   - `apps/gateway-ui/server` 提供 Gateway 原生 REST（无 `/api/admin` 兼容层）。
   - `operations-store` 处理主机资源和项目活动；`runtime-store` 读取 `.vera/flows/iterations`。

3. 统一 Web 壳
   - `apps/gateway-ui/web`：运行工作台（Flow 启动 + 侧边栏 + Run 子路由）、运维、项目详情、聊天占位。

4. 管理操作
   - 添加安全操作：重载 skill、重载 MCP、连接 channel、运行 doctor、测试 provider、触发 RAG 重建索引。
   - 所有写操作需要显式权限和脱敏审计日志。

5. 对话与运行时集成
   - 添加对话模型。
   - 将对话绑定到 sessions、channels 和 flow runs。
   - 通过统一事件总线流式推送 events、logs、tool calls、costs 和 artifacts。

## 首期交付

首个实现从 `packages/gateway` 开始：

- `CapabilityDescriptor` 及相关类型。
- `CapabilityRegistry`。
- `ProjectRegistry`。
- `createProjectCapabilityInventory`。
- `DoctorService`。

这使得后续的 server/UI 步骤变得机械化：server 序列化这些类型化结果，UI 直接渲染。

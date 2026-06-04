# Vera Control Gateway Plan

> Goal: provide one control plane for projects, capabilities, runtime services, and UI surfaces without moving execution logic out of Core or Harness.

## Principles

- Gateway is a control plane: discovery, configuration, diagnostics, orchestration, and presentation.
- Core remains the single-call runtime boundary for config, tools, channels, memory, MCP, prompt, context, sandbox, and RAG primitives.
- Harness remains the workflow boundary for flows, runs, checkpoints, critique, replanning, and subagents.
- UI apps consume Gateway APIs instead of scanning project files independently.
- Sensitive files stay protected: Gateway reports their presence and redacted metadata, never raw secrets.

## Target Architecture

```text
apps/gateway-ui
  -> packages/gateway
    -> packages/harness
      -> packages/core
```

`packages/gateway` owns the domain model used by the UI and server:

- `ProjectRegistry`: discovers local projects and their `.vera` resources.
- `CapabilityRegistry`: normalizes config, skills, memory, rules, MCP, RAG, prompts, context, sandbox, plugins, channels, flows, logs, and conversations into one descriptor model.
- `DoctorService`: runs read-only health checks for projects and capabilities.
- `GatewayRuntime` later: starts flows, binds channels, resumes conversations, and streams events.

## Capability Model

Every managed surface is represented as a capability:

- `config`: provider, model, routing, session, MCP server config.
- `prompt`: system prompts, agent prompts, flow stage prompts, skill prompts.
- `context`: context budget, compression, injection sources, token accounting.
- `memory`: user/project/reference/feedback memory and automatic extraction.
- `rag`: document sources, embedding adapter, vector store, index freshness.
- `skill`: local skills, skill evolution, recommendation, versioning, hot reload.
- `plugin`: tool, channel, sandbox, adapter, and MCP plugin registration.
- `mcp`: server state, tools, resources, auth, schema, call records.
- `channel`: CLI, API, webhook, Feishu, Slack, Telegram, Discord, WeCom, WhatsApp.
- `sandbox`: local, Docker, E2B, CubeSandbox providers and call logs.
- `flow`: flows, stages, agents, runs, checkpoints, artifacts, subagents.
- `conversation`: chat sessions, channel-bound sessions, flow conversations.
- `log`: runtime logs, traces, cost, tokens, events, artifacts.

The descriptor is intentionally UI-friendly: it contains id, kind, scope, source, status, health, and allowed actions. Execution remains behind manager services.

## Gateway API Shape

Initial read-only API:

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

`POST /api/execute/flow.run` 启动 `openvera flow run`；`POST /api/execute/chat.send` 经 `@open-vera/core` `runAgent` 生成回复（无 API Key 时回退占位文案）。

`GET /api/runs/:runId/stream?live=1` 在 run 进行中每秒 tail `timeline.ndjson`。

`GET /api/projects/:projectId/rag/search?q=` 关键词检索 `.vera/rag`；`GET /api/projects/:projectId/mcp/servers|tools` 发现 MCP 配置。

Management API after the read-only layer is stable:

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

## UI Information Architecture

- Overview: projects, active runs, channels, MCP, sandbox, doctor summary.
- Projects: project list, resource paths, recent runs, capabilities.
- Capabilities: grouped capability inventory and status filters.
- Chat: project-scoped conversations, channel binding, flow-backed chat.
- Flows: flow catalog, stage/agent prompts, run launcher, run history.
- Runs: timeline, artifacts, checkpoints, memory, subagents.
- RAG: sources, indexes, embedding provider, vector store, search test.
- Memory: memory files, extraction policy, usage statistics, organization jobs.
- Skills: skill catalog, versions, score, recommendation, reload.
- MCP: servers, tools, resources, auth state, schema, call history.
- Channels: adapters, connection state, sessions, message history.
- Sandbox: provider status, limits, call logs, errors.
- Prompts and Context: prompt graph, context budget, compression, injections.
- Logs: project/run/session/tool/MCP/sandbox/channel filters.
- Doctor: actionable diagnostics and suggested fixes.

## Implementation Phases

1. Read-only foundation
   - Add `packages/gateway`.
   - Implement project discovery, capability descriptors, and doctor checks.
   - Expose typed APIs for a future server.

2. Gateway server
   - `apps/gateway-ui/server` 提供 Gateway 原生 REST（无 `/api/admin` 兼容层）。
   - `operations-store` 负责主机资源与项目活动；`runtime-store` 读取 `.vera/flows/iterations`。

3. Unified web shell
   - `apps/gateway-ui/web`：Runs 工作区（Flow 启动 + 侧栏 + Run 子路由）、Operations、Project 详情、Chat 占位。

4. Management actions
   - Add safe actions: reload skill, reload MCP, connect channel, run doctor, test provider, trigger RAG reindex.
   - All write actions require explicit permissions and redacted audit logs.

5. Conversation and runtime integration
   - Add conversation model.
   - Bind conversations to sessions, channels, and flow runs.
   - Stream events, logs, tool calls, costs, and artifacts through one event bus.

## First Cut

The first implementation starts with `packages/gateway`:

- `CapabilityDescriptor` and related types.
- `CapabilityRegistry`.
- `ProjectRegistry`.
- `createProjectCapabilityInventory`.
- `DoctorService`.

This makes the next server/UI step mechanical: the server serializes these typed results, and the UI renders them.

# Vera 插件化实施计划

> 本计划基于 `docs/zh/platform/plugin.md` 的最终方案，目标是把插件系统拆成可执行的工程任务。方案方向已复核：可行，关键前提是 P0 允许用户显式启用第三方 same-process 插件，但不把 P0 描述为强沙箱。

## 1. 审查结论

当前方案没有方向性阻塞，可以进入实施拆解。需要坚持以下约束：

- 插件主要贡献 capability，hook 只做横切拦截、变换和观察。
- Host 保留最终控制：权限、路径、网络、secret、预算、审批、状态机、token budget、session 生命周期。
- P0 支持用户显式启用第三方插件，同进程执行，视为用户信任代码；CLI/Gateway 必须展示来源、权限和风险提示，并写入 lockfile。
- Runtime capability 和 Gateway descriptor 必须分层：runtime 可持有 factory/对象，Gateway/API 只暴露可序列化 DTO。
- 不做 big-bang rewrite。先引入兼容层，让旧 `ToolRegistry`、adapter、Channel、Harness runner 逐步迁到新 runtime。

### 1.1 源码审查校准

本计划已按当前 `packages/core/src` 和 `packages/harness/src` 校准，关键结论如下：

| 源码事实 | 方案判断 | 计划影响 |
|----------|----------|----------|
| `packages/core/src/tools/registry.ts` 同时负责注册、hook、middleware、retry、timeout、idempotent cache、stats | 不能直接删除或替换为纯 capability map | P0.5 先引入 `ToolHost` 兼容层，保留旧行为；P1 再把内置工具拆成 builtin plugin |
| `packages/core/src/tools/index.ts` 的 `createToolRegistry()` 硬编码所有内置工具，并通过参数注入 memory/RAG/vision/sandbox/storage | 工具插件化要先解决 optional dependency | capability 需要声明 dependency/readiness，Host 决定工具是否进入 schema |
| `packages/core/src/agent/loop.ts` 有 `runAgent` 和 `streamAgent` 两条独立执行路径，compression 还会额外调用 LLM | 事件不能只接主聊天路径 | `llm:*`、`tool:*`、`compression:*` 必须覆盖 streaming、non-streaming、proactive/reactive compression |
| `packages/core/src/config/types.ts` 仍把 `AdapterType` 固定为 `"anthropic" | "openai" | "gemini"` | 第三方 provider 被配置类型挡住 | P2 必须把 adapter 类型改为 string registry，并由 schema/provider capability 校验 |
| `packages/core/src/channel/plugin-registry.ts` 的 `unloadAllByPlugin()` 只移除 map，不异步 disconnect | 当前专用 registry 不能作为最终插件生命周期模型 | ChannelService 要把 disconnect/dispose 变成 deactivate 的硬验收 |
| `packages/harness/src/runtime/runtime.ts` 构造函数直接持有 `LLMAdapter/model`，并直接调用 planner/critic/replan | Harness 不是简单加 hook，必须抽 services | P3 先让 `HarnessRuntime` 依赖 `HarnessServices`，再替换 planner/runner/critic selector |
| `packages/harness/src/agent/types.ts` 已有 AgentRunner、capabilities、readiness、fallback registry 雏形 | Runner 插件化可复用现有接口 | P3.1 扩充 metadata：ownerPluginId、scope、priority、tags、shadow/fallback |
| `packages/harness/src/agent/stream-runner.ts` 直接 import `@open-vera/core/agent` 并传入裸 adapter/model/tools | 默认 runner 必须改成 service consumer | 默认 builtin runner 通过 `LlmService`、`ToolHost`、Prompt/Context services 运行 |

因此最终方案是可落地的，但实施时必须先做 runtime service 兼容层，再迁移内置能力；不能先把内部模块全部拆成插件。

## 2. 总体阶段

| 阶段 | 目标 | 主要产出 | 阻塞下游 |
|------|------|----------|----------|
| P0 | 插件运行时骨架 | `packages/plugin-runtime`、manifest、loader、host、event bus、runtime capability registry、lockfile | 全部 |
| P0.5 | Runtime services 收敛 | `LlmService`、`ToolHost`、`PromptComposer`、`ContextComposer`、`HarnessServices`、`GatewayServices` | Tool/LLM/Harness/Gateway |
| P1 | Tool/Channel capability 化 | 内置 tools/channel 重包，旧 registry 兼容层，Policy/Audit 接入 | Agent loop、Gateway 管理 |
| P2 | LLM/Prompt/Context capability 化 | provider registry、config schema、model alias、prompt/context providers | Core loop、Harness runner |
| P3 | Core Agent 事件化 | `runAgent`/`streamAgent` 稳定事件、compression/routing/tool event 覆盖 | 审计、测试、插件 hook |
| P4 | Harness 策略插件化 | planner/runner/critic/replan/approval/artifact/checkpoint selectors | Flow/Swarm/Eval/Training |
| P5 | Gateway 管理面 | plugin/capability/status/health/action API 和 UI | 用户操作闭环 |
| P6 | 隔离与热重载增强 | Worker/child process mode、RPC、kill/reload/resource limit | 企业和高风险插件 |

### 2.1 阶段性 checkpoint

2026-06-05 已形成第一个可提交节点：

- `@open-vera/plugin-runtime` 骨架完成，覆盖 manifest、loader、host、EventBus、RuntimeCapabilityRegistry、PolicyEngine、lockfile 和 fixture 插件生命周期。
- Core 已接入 `LlmService`、`ToolHost`、`PromptComposer`、`ContextComposer`、`ChannelService` 兼容层，保留旧 adapter/tool/channel 行为并补充稳定事件和 descriptor 边界。
- Gateway 已接入共享 `GatewayPluginAdmin` / runtime capability registry，Chat、capability/doctor、channel 管理 action 可消费已启用插件能力。
- Harness 已引入 `HarnessServices`，默认 planner/critic/replan/runner 可通过 service override 替换，默认 runner 走 `LlmService` 和 `ToolHost`。
- P1 已开始：内置 tool contribution 分组、ToolHost guardrail/audit sink、channel unload/disconnect contract、第三方 channel fixture 管理动作。

本节点验证：

- `pnpm --filter @open-vera/plugin-runtime typecheck`
- `pnpm --filter @open-vera/plugin-runtime test`
- `pnpm --filter @open-vera/core typecheck`
- `pnpm --filter @open-vera/core test`
- `pnpm --filter @open-vera/gateway typecheck`
- `pnpm --filter @open-vera/gateway test`
- `pnpm --filter @open-vera/openvera typecheck`
- `pnpm --filter @open-vera/openvera test`
- `pnpm --filter @vera/gateway-ui-server typecheck`

下一步优先继续 P1/P2：把 `SecurityPlugin` / `AnalyticsPlugin` 从旧 lifecycle 中进一步拆成 Host policy/audit source，继续替换旧 `ChannelPluginRegistry` 调用方，并推进 ModelRegistry、provider schema、config composer 与 setup wizard 的 provider 来源迁移。

## 3. P0：插件运行时骨架

实施状态（2026-06-05）：

- 已落地 `@open-vera/plugin-runtime` 包，包含 manifest、loader、host、EventBus、RuntimeCapabilityRegistry、lockfile、PolicyEngine 和 `definePlugin()`。
- 已支持 fixture 插件 discover -> enable -> activate -> deactivate，第三方 same-process 风险信息写入 Gateway/lockfile 流程。
- `ctx.provide.tool()`、`ctx.provide.llmAdapter()`、`ctx.provide.modelProvider()` 已可注册 runtime capability，并转换为不包含 factory/execute 的 Gateway descriptor。
- 已验证：`pnpm --filter @open-vera/plugin-runtime typecheck`、`pnpm --filter @open-vera/plugin-runtime test`。

### P0.1 新建包结构

文件：

- `packages/plugin-runtime/package.json`
- `packages/plugin-runtime/tsconfig.json`
- `packages/plugin-runtime/src/index.ts`
- `packages/plugin-runtime/src/manifest.ts`
- `packages/plugin-runtime/src/plugin-host.ts`
- `packages/plugin-runtime/src/plugin-loader.ts`
- `packages/plugin-runtime/src/capability-registry.ts`
- `packages/plugin-runtime/src/event-bus.ts`
- `packages/plugin-runtime/src/context.ts`
- `packages/plugin-runtime/src/disposable.ts`
- `packages/plugin-runtime/src/lockfile.ts`
- `packages/plugin-runtime/src/policy-engine.ts`

要求：

- `plugin-runtime` 只依赖 `@open-vera/shared`、`@open-vera/logger` 和 Node 标准库。
- 禁止依赖 `@open-vera/core`、`@open-vera/openvera`、`@open-vera/gateway`。
- 导出 `definePlugin()`、`PluginHost`、manifest 类型、capability 类型、hook 类型。

验收：

- `pnpm --filter @open-vera/plugin-runtime typecheck` 通过。
- 能用 fixture 插件完成 discover -> validate -> activate -> deactivate。

### P0.2 Manifest 与 lockfile

任务：

- 定义 manifest schema：`id`、`name`、`version`、`apiVersion`、`entry`、`scope`、`activationEvents`、`contributes`、`permissions`。
- 支持内置、本地目录、用户目录、workspace/npm dependency 四类 source。
- 生成 `.vera/plugins-lock.json`，记录 source、version、checksum、enabled、approvedPermissions、activatedAt、lastError。

验收：

- 缺必填字段会失败。
- apiVersion 不兼容会失败。
- 启用第三方插件会记录 lockfile。
- lockfile 可复现插件启用状态。

### P0.3 EventBus

任务：

- 实现 `intercept`、`transform`、`observe`、`config` 四类 hook。
- 支持 event glob：`tool:before:*`、`flow:*:error`。
- 支持 scope/priority/enforce 排序。
- 支持 timeout 和 critical 策略。

验收：

- intercept first handled wins。
- transform 串行传值。
- observe 并发执行，失败 fail-open。
- critical transform/intercept 超时按策略 fail-open/fail-closed。

### P0.4 Runtime capability registry

任务：

- 定义 `RuntimeCapability`，包含 `id`、`kind`、`ownerPluginId`、`scope`、`status`、`factory`、`metadata`、`permissions`、`healthCheck`。
- 定义 `toDescriptor()`，转换为 Gateway 可序列化 `CapabilityDescriptor`。
- 实现冲突策略：同名 tool 默认拒绝；model alias 按 project > workspace > user > builtin；singleton 进入 active/shadow。

验收：

- factory 不会出现在 descriptor JSON。
- 冲突行为可测试。
- disabled/error/shadow 状态可被 Gateway 查询。

### P0.5 P0 第三方插件用户体验

任务：

- CLI/Gateway 启用第三方插件时展示：source、version、checksum、permissions、same-process 风险。
- 支持 `enable`、`disable`、`reload`、`inspect`。
- P0 不阻止用户启用第三方插件，但必须可见、可停、可审计。

验收：

- fixture 第三方插件可被启用并注册 capability。
- 禁用后 capability 不再可用。
- activate 失败后状态为 error，不拖垮宿主。

## 4. P0.5：Runtime Services 收敛

实施状态（2026-06-05）：

- 已新增 `LlmService` 兼容层，Core CLI、Gateway Chat、Harness CLI 的 adapter 构造已集中到该服务，`llm:request` / `llm:response` / `llm:error` 事件已有基础覆盖。
- 已新增 `LlmService.buildAdapter()` 事件化兼容 wrapper，旧 `LLMAdapter` 调用形状下仍会经过 `llm:*` 事件；Gateway Chat、Harness CLI 默认 adapter 已不再返回裸 provider adapter。
- 已新增 `ToolHost` 兼容层，旧 `ToolRegistry` 可被包装成 tool capability，REPL、Harness skill provider 和默认 `StreamAgentRunner` fallback 已通过 `ToolHost.execute()` 执行工具。
- `ToolHost.getSchemas()` 已按 runtime capability status 做 readiness 过滤，`disabled` / `error` / `shadow` tool 不进入 LLM schema，执行时返回明确不可用结果。
- 已新增 `PromptComposer` / `ContextComposer` 兼容层，`PromptStore`、project context、插件 `prompt-block` / `context-provider` capability 可组合为统一 system/context 输出，Core single-shot 路径已接入。
- `ContextComposer` 已支持将 `MemoryStore` 和 `VectorStore`/`EmbeddingAdapter` 包装为 host-owned context provider capability，按 query 检索、排序、裁剪后注入上下文；descriptor 不暴露 store/adapter factory。
- 已新增 `HarnessServices` 兼容层，`HarnessRuntime` 的默认 runner、planner、plan/step critique、replan、retrospective 已可通过 service override 替换；默认 `StreamAgentRunner` 可消费 `LlmService` 和 `ToolHost`，兼容构造仍支持裸 adapter。
- Gateway capability 列表已能混合静态项目扫描和 runtime descriptor，并支持 runtime healthCheck 序列化。
- `AdapterType` 已从固定 union 放开为 string，`LlmService` 已支持显式 adapter factory 和 runtime `llm-adapter` capability；未知 adapter 会明确失败，不再静默回退 Anthropic。
- Gateway capability/doctor 路径已会激活 lockfile 中 enabled 的插件，并把项目 runtime capabilities 传入 Gateway Chat 的 `LlmService`，已启用的插件 LLM adapter 可被 Gateway Chat 选择。
- Gateway server 已统一复用同一个 `GatewayPluginAdmin` / `EventBus`，普通 Chat 路由和 `/api/execute/chat.send` action 均会共享插件 host 生命周期、runtime capability registry 和 `llm:*` hook。
- `visual_analyze` 已支持直接消费 purpose-aware `LlmService`，`createToolRegistry()`、Core CLI、Harness flow/repl 工具注册路径已可注入 `llmService`；旧 `llmAdapter` 兼容保留。
- `SessionManager.autoCompress()` 已兼容 `LlmService` 并通过 `purpose: "compression"` 构造压缩 adapter；旧 `LLMAdapter` 参数兼容保留。
- `runAgent` / `streamAgent` 已新增 observe-only `EventBus` 入口，覆盖 `turn:start` / `turn:end`、`context:select` / `context:inject`、`llm:*`、`tool:*`、`compression:*` 和 `turn:retry` 基础事件，事件 payload 已用 contract test 固化为可序列化 DTO。
- 已新增 `ChannelService` 兼容层，支持把 channel adapter factory 注册为 `channel-adapter` runtime capability，descriptor 映射为 Gateway `channel` kind，且 load/connect/disconnect/send/receive/unload/error 会发出 `channel:*` 事件。
- `PluginContext.provide.channelAdapter()` 已可贡献第三方 channel adapter capability；fixture 插件已验证 discover -> enable -> activate -> descriptor -> `ChannelService.registerRuntimeCapability()` -> load/send 的 P0 路径。
- 仍未完成：Core/REPL/Harness 默认装配 memory/RAG context provider、内置 provider/tool 完整插件化。

### P0.5.1 LlmService

当前阻断：

- `packages/core/src/main.ts`
- `apps/gateway-ui/server/src/chat-runtime.ts`
- `packages/harness/src/cli/adapter.ts`
- `packages/core/src/session/title.ts`
- `packages/core/src/tools/visual-analyze.ts`
- `packages/core/src/context/compression.ts`
- `packages/harness/src/runtime/runtime.ts`
- `packages/harness/src/agent/stream-runner.ts`

任务：

- 新增 `LlmService` contract：`complete()`、`stream()`、`listModels()`、`resolveModel()`、`selectAdapter()`。
- 支持 purpose：`chat`、`routing`、`compression`、`vision`、`tool`。
- 将 Anthropic/OpenAI/Gemini 内置 adapter 先通过 compatibility provider 注册。
- 替换所有分散的 `buildAdapter()` 和 env key switch。
- 内置 provider 迁移时保留现有 `LLMAdapter` 协议，避免一次性修改所有 adapter 实现。
- `LlmService` 发出 `llm:request`、`llm:response`、`llm:error` 事件，事件 payload 只包含可序列化字段和经过脱敏的 headers/env 信息。

验收：

- Core CLI、Gateway Chat、Harness CLI 均不直接 import 三家 adapter。
- 新 provider 插件无需修改 Core/Gateway/Harness 入口。
- compression/routing 调用可被审计。
- REPL/Core CLI 的 routing、compression、AI title provider、`visual_analyze` 和 `SessionManager.autoCompress()` 分支已标记 purpose；Harness 默认 planner、plan/step critique、replan、retrospective 和 Harness flow/repl `visual_analyze` 工具已通过 purpose-aware `LlmService` 调用；Core/Gateway 已支持 runtime `llm-adapter` capability；agent loop proactive/reactive compression 已可通过 `LlmService.buildAdapter(..., { purpose: "compression" })` 调用；Harness CLI 的插件 capability 注入仍需继续迁移。

### P0.5.2 ToolHost

当前阻断：

- `packages/core/src/tools/index.ts`
- `packages/core/src/tools/registry.ts`
- `packages/core/src/repl/ui/hooks/useToolCallHandler.ts`
- `packages/harness/src/skill/registry-provider.ts`
- `packages/harness/src/agent/stream-runner.ts`
- `packages/harness/src/runner.ts`
- `packages/harness/src/tracking/change-tracker.ts`

任务：

- 新增 `ToolHost`：`getSchemas()`、`execute()`、`registerCapability()`。
- 写 `ToolRegistryAdapter`，把旧 `ToolDef`/`ToolRegistry` 接入 capability。
- 保留旧行为：`needsConfirm`、metadata、retry、idempotent cache、timeout、stats、dryRun、onOutput、deprecation warning。
- PolicyEngine 先包住 `ToolHost.execute()`，再逐步替换 `SecurityPlugin`。
- `ToolHost` 执行顺序固定为：schema/permission preflight -> EventBus intercept before -> legacy middleware before -> execute with timeout/retry -> legacy middleware after -> EventBus transform after -> audit/stats/session write。
- optional tools 不再靠 `createToolRegistry(opts)` 参数直接决定，改为依赖 capability readiness：memory/RAG/vision/sandbox/storage capability ready 后才进入 schema。
  - 当前进展：`ToolHost.getSchemas()` 已按 capability status 过滤，`disabled` / `error` / `shadow` tool 不进入 schema；optional tool 的注册来源仍待 P1 内置 tool 插件化继续迁移。

验收：

- 旧 tool 测试通过。
- REPL/subagent/skill provider 都走 `ToolHost.execute()`。
- 第三方 P0 tool 可注册和执行。
- `needsConfirm` 不丢失。
- `ToolResult.metadata.renderHint/diff` 在 REPL UI 中不丢失。
- 旧 `ToolMiddleware` 与新 EventBus 顺序有 contract test 固化。

### P0.5.3 PromptComposer / ContextComposer

任务：

- `PromptStore`、project context、memory/RAG 注入收敛为 composer service。
- `prompt-block`、`prompt-profile`、`context-provider` 能力注册。
- Host 负责排序、token budget、敏感信息过滤。

验收：

- 现有 prompt/project-context 行为不变。
- 插件可贡献 prompt block。
- context provider 输出可被裁剪和审计。
  - 当前进展：`ContextComposer` 已支持静态/动态 `context` capability、`memory` capability 和 `rag` capability；`MemoryStore` / `VectorStore` + `EmbeddingAdapter` 可作为 host-owned provider 参与统一排序和裁剪。Core/REPL/Harness 默认启用与内置 capability 化仍待后续阶段。

### P0.5.4 HarnessServices / GatewayServices

任务：

- `HarnessRuntime` 构造参数从裸 `adapter/model/options` 过渡到 services。
- `StreamAgentRunner` 从直接持有 `adapter/model` 改为消费 `LlmService`、`ToolHost`、Prompt/Context services。
- `planFromPrompt`、`critiquePlan`、`critiqueStep`、`replanWithCritique` 先通过 compatibility service 调用，不立刻拆 prompt；默认实现已可使用 purpose-aware `LlmService` adapter。
- Gateway server 从 PluginHost 获取 project detector、capability indexer、health check、admin action。

验收：

- 默认 Harness flow 行为不变。
- Gateway capability 列表可混合静态扫描和 runtime descriptor。
- `HarnessRuntime` 内部不再直接 new `StreamAgentRunner(adapter, model)`；默认 runner 由 services 提供。

## 5. P1：Tool 和 Channel 改造

### P1.1 内置 tool 插件拆分

实施状态（2026-06-05）：

- 已新增 `packages/core/src/tools/builtin-tools.ts`，把内置工具按 `builtin-tools-fs`、`builtin-tools-shell`、`builtin-browser`、`builtin-computer-use`、`builtin-memory`、`builtin-rag`、`builtin-sandbox-tools`、`builtin-storage-tools`、`builtin-user-data` 分组成 auditable builtin tool contribution。
- `createToolRegistry()` 已从逐个 `registry.register()` 的硬编码入口迁为通过 `ToolHost.registerCapability()` 注册内置贡献；旧 `ToolRegistry` 执行、middleware、security、analytics 和 schema 行为保持兼容。
- optional tool 仍按 host dependency 是否存在进入 schema，但 capability metadata 已记录 builtin owner、source、category 和 dependencies；新增 `userDataStore` 选项后 `data_save` / `data_load` / `data_list` / `data_delete` 可通过同一内置贡献路径启用。
- `ToolHost` 已新增 Host guardrail / audit sink 兼容接口；`SecurityPlugin` 可作为最终 Host guardrail 先行裁决，`AnalyticsPlugin` 已接入 Host audit sink，并保留旧 lifecycle hook 以兼容直接 `ToolRegistry.execute()` 调用。
- 已补 `ToolHost` contract test，验证 builtin owner/source 可审计、descriptor 不暴露 factory、optional user-data tool 依赖可用时进入 schema 并可执行、Host guardrail 在 legacy registry 前拦截、audit sink 不影响执行、正常 ToolHost registry 路径不重复写 session、guardrail 拦截结果仍会写审计。
- Runtime capability registry 已支持显式 tool override：同名第三方 tool 默认拒绝，只有 `metadata.override: true` / `ctx.provide.tool({ override: true })` 才会替换 active tool；被替换 capability 进入 `shadow`，descriptor/conflict 记录包含 owner/source/override metadata，`ToolHost` 只在 active capability 被接受后更新 legacy registry。
- 已补 `plugin-runtime` 和 `ToolHost` contract test，验证默认同名拒绝、显式 override 替换执行、旧能力 shadow、conflict/descriptor 可审计。
- 仍未完成：`SecurityPlugin` 拆出独立 policy source/Host guardrail 包、`AnalyticsPlugin` 完整迁出旧 lifecycle hook、override 的用户审批 UI/CLI 流程。

内置插件：

- `builtin-tools-fs`
- `builtin-tools-shell`
- `builtin-browser`
- `builtin-computer-use`
- `builtin-memory`
- `builtin-rag`
- `builtin-sandbox-tools`
- `builtin-storage-tools`
- `builtin-user-data`
- `builtin-subagent`
- `builtin-ask-user`

任务：

- 将 `createToolRegistry()` 的硬编码注册拆为内置插件注册。
- optional tool 根据依赖 capability 启用。
- `SecurityPlugin` 迁成 Host guardrail + builtin policy source。
- `AnalyticsPlugin` 迁成 audit sink。

验收：

- 内置工具行为不变。
- 同名第三方 tool 默认被拒绝。
- override 必须显式声明，并可审计。

### P1.2 ChannelService

实施状态（2026-06-05）：

- `ChannelPluginRegistry.unregisterPlugin()` / `unloadAllByPlugin()` / `unloadAll()` 已异步等待 adapter `disconnect()` 后再清理 loaded adapter map，避免插件卸载后连接、watcher、timer 或 server 残留。
- 已补 `unloadAllByPlugin()` 等待异步 disconnect 完成的 contract test。
- 已新增 `ChannelService` 兼容层，旧 `ChannelPluginRegistry` 和 `ChannelGateway` 可被组合为 host-owned service；`channel-adapter` capability descriptor 不暴露 factory，加载实例后由 `ChannelGateway` 管理连接和消息。
- `ChannelService` 已覆盖 `channel:adapter:load`、`channel:adapter:unload`、`channel:connect`、`channel:disconnect`、`channel:message:send`、`channel:message:receive` 和 `channel:error` 事件；unload 会先发出可审计的 `channel:disconnect` 再发 `channel:adapter:unload`。
- Gateway admin `connect` / `disconnect` / `test` / `reload` channel action 已接入 `ChannelService`，会激活 lockfile enabled 插件、注册 runtime `channel-adapter` capability、按 instance load/connect/unload，并返回 descriptor 和 adapter status；Gateway UI server `/api/manage/:action` 已传入共享 `GatewayPluginAdmin` / `EventBus`。
- 已补 `ctx.provide.channelAdapter()` 和 fixture 插件端到端测试，第三方 channel P0 capability 可被 `ChannelService` 消费。
- 已补 Core/Gateway/Gateway UI server contract test，覆盖第三方 fixture channel capability 的 connect/test/reload/disconnect 管理动作。
- 仍未完成：完整替换旧 `ChannelPluginRegistry` 调用方。

任务：

- 每个平台 channel adapter 注册为 `channel-adapter` capability。
- `ChannelPluginRegistry` 变薄为兼容层，最后删除。
- unload/deactivate 必须 disconnect 并清理 watcher/timer/server。
- 修复当前 `unloadAllByPlugin()` 只删除 map、不等待 `disconnect()` 的行为；兼容层也必须异步清理。
- `ChannelGateway` 保留为 Host orchestrator，接入 `channel:connect`、`channel:disconnect`、`channel:message:receive`、`channel:message:send`、`channel:error` 事件。
- Gateway admin action 支持 connect/disconnect/test/reload。

验收：

- 现有 channel 测试通过。
- 卸载 channel 插件后连接不残留。
- 第三方 channel P0 可启用。
- channel 插件 deactivate 失败会进入 error/quarantined，不影响其他 channel。

## 6. P2：LLM、配置、Prompt、Context

### P2.1 ConfigComposer

任务：

- 合并顺序：builtin defaults -> manifest defaults -> user global -> workspace -> project -> env/CLI -> config hooks -> schema validation。
- plugin config 命名空间：`plugins.<id>.config`。
- secret 从普通 config 移除，走 `ctx.secrets`。
- `AdapterType` 从固定 union 改成 string；内置 provider schema 继续校验 `anthropic/openai/gemini` 的专有配置。
- setup wizard 和 provider preset 从 ModelRegistry 读取可用 provider，不再硬编码完整 provider 列表。

验收：

- resolved config 可导出。
- 插件不能默认读取其他插件 config。
- schema 校验错误能定位到插件和路径。
- 旧 `.vera/settings.json` 可自动迁移或兼容读取。

### P2.2 Provider/model registry

实施状态（2026-06-05）：

- `AdapterType` 已放开为 `string`，第三方 adapter 名称不再被配置类型挡住。
- `LlmService` 已提供 `registerAdapterFactory()`、构造期 `adapterFactories`，并可从 `RuntimeCapabilityRegistry` 中选择 `llm-adapter` capability。
- Gateway 已会在 capability/doctor 和 Chat 路径激活 lockfile enabled 插件，并把项目 runtime capability registry 注入 Chat 的 `LlmService`。
- 仍未完成：统一 ModelRegistry、provider schema 校验、setup wizard provider preset 来源迁移、model alias scope 冲突和 purpose/modality 完整选择策略。

任务：

- `AdapterType` 改 string。
- provider/model alias 注册到 model registry。
- routing/intent router 只给建议，Host 决定最终模型。
- model alias 冲突按 project > workspace > user > builtin 选择 active，其余进入 shadow。
- provider capability 必须声明支持的 modality/purpose：chat、tool-call、vision、embedding、compression。

验收：

- 新 provider 不改 Core 源码。
- model alias 冲突按 scope 规则处理。
- routing、session title、compression、vision tool 都能选择不同 purpose 的模型。

### P2.3 Agent loop 事件

任务：

- `runAgent` 和 `streamAgent` 都覆盖：
  - `turn:start` / `turn:end`
  - `llm:request` / `llm:response` / `llm:error`
  - `tool:before` / `tool:after` / `tool:error`
  - `context:select` / `context:inject`
  - `compression:before` / `compression:after`
- reactive/proactive compression 和 routing 调用也走 `LlmService`。
- 插件事件 payload 只暴露稳定 DTO：turn、messages summary、tool call、usage、traceId、sessionId，不暴露内部 `CompressionState` 可变对象。
- 长期可抽共享 `TurnExecutor`，但 P2/P3 过渡期允许在两条路径分别插事件，必须有 contract test 防漏。
  - 当前进展：已补 `eventBus` observe 入口和 `turn/context/proactive compression` contract test；`runAgent` / `streamAgent` 已覆盖 loop 层 `llm:request` / `llm:response` / `llm:error`、`tool:before` / `tool:after` / `tool:error` 基础事件，tool args parse error 已有可观测 `tool:error`，reactive compact retry 和空 assistant after-tool retry 已有 `turn:retry` 契约。`AgentOptions` 已支持 `sessionId` / `traceId` 事件字段，Core single-shot、REPL/plan、subagent、本地默认 remote subagent、Gateway Chat 内部 LLM/loop、Harness 默认 runner 已传入或共享事件上下文。Gateway server 已统一 plugin admin host 与 Chat runtime 的 EventBus/capability 生命周期。proactive/reactive compression 已可通过 `LlmService` 以 `purpose: "compression"` 调用。仍待补齐：更多非默认 runner/legacy caller 传入真实 session/trace 上下文。

验收：

- streaming/non-streaming 事件一致。
- 事件 payload 可序列化。
- 插件不能 import `loop.ts` 私有函数。
- 空 assistant 重试、tool args parse error、reactive compact retry 都有可观测事件。

## 7. P3：Harness 策略插件化

### P3.1 AgentRunner selector

任务：

- `AgentRunnerRegistry` 升级为 capability selector。
- 支持 scope、priority、tags、readiness、fallback、shadow。
- 默认 `StreamAgentRunner` 作为 builtin runner。
- 现有 `AgentRunnerCapabilities` 保留并扩展 owner metadata：`ownerPluginId`、`scope`、`version`、`riskLevel`、`supportedPurposes`。
- selector 输入包含 step type、assignedAgent、required tools、deadline、readonlyMode、tags，输出记录选择原因和 fallback 链路。

验收：

- 插件可新增 runner。
- fallback 规则可测。
- runner 不得绕过 Host `ToolHost` 和 `LlmService`。
- readiness 失败时会自动 fallback，并在 timeline/audit 中记录。

### P3.2 Planner/Critic/Replan/Approval

任务：

- `planFromPrompt` 注册为 builtin `flow-planner`。
- `critiquePlan` / step critique 注册为 `flow-critic`。
- replan merge 注册为 `replan-strategy`。
- approval 变 Host gate + plugin policy suggestions。
- `HarnessRuntime.planAndStart()` 不直接调用 `planFromPrompt`，改为 `services.planner.select().plan()`。
- `runStepCritique()`、`runPlanCritique()`、`replanFlow()` 不直接调用 `critique*`/`replanWithCritique`，改走 services。
- 多 critic 结果必须归一化为统一 `CritiqueResult`，Host 决定最终 `nextAction`。

验收：

- 可替换 planner。
- 多 critic 可合并。
- 高风险 step fail-closed。
- 插件只能建议 `complete/retry/replan/ask_human`，不能直接修改 Flow 状态机。

### P3.3 Artifact、Checkpoint、Timeline

任务：

- 本地 artifact/checkpoint store 作为 builtin provider。
- timeline 作为 `timeline-sink`，供 Gateway stream。
- checkpoint/replay 必须记录插件版本和 capability owner。
- 每次 capability invoke 写入：capability id、ownerPluginId、version、source、checksum、runtimeMode。
- checkpoint resume 时校验 lockfile；插件版本或 checksum 变化时进入人工确认或 degraded mode。

验收：

- 现有 checkpoint/resume 测试通过。
- timeline 可追踪插件能力调用。
- 复现一次 flow 时能知道当时使用了哪个插件版本。

### P3.4 Skill、Swarm、Eval、Benchmark、Training、Proposal、Strategy

任务：

- skill source/resolver/recommender/hot reload capability 化。
- swarm splitter/scheduler/merger 策略化，Host 管并发和资源。
- eval/benchmark runner 和 reporter 插件化。
- training pipeline stage 插件化，训练产物可生成 skill/plugin/proposal。
- dreaming/proposal/strategy 统一接 timeline/audit/cost。

验收：

- 原有 harness 测试通过。
- 至少一个 fixture 插件可新增 eval runner 或 planner。
- training/proposal 不绕过 approval gate。

## 8. P4：Gateway 管理面

任务：

- 插件列表 API：source、version、status、scope、permissions、health、lastError。
- capability 列表 API：descriptor、ownerPluginId、actions、health、conflicts。
- admin action：enable/disable/reload/test/connect/disconnect/reindex。
- Gateway UI 增加插件风险提示、权限审查、lockfile 状态、health check。

验收：

- UI 可启停第三方插件。
- UI 可看到 P0 same-process 风险。
- capability descriptor 不包含 runtime factory。
- health check 失败不会拖垮 Gateway。

## 9. P5：隔离与热重载增强

任务：

- Worker/child process plugin host。
- Host <-> plugin RPC：capability invoke、hook invoke、health check、dispose。
- 超时、kill、resource limit、crash quarantine。
- 同一 manifest 支持 `same-process` 和 `isolated` 两种运行模式。

验收：

- isolated 插件崩溃不影响主进程。
- reload 后旧 worker/timer/connection 不残留。
- P0 same-process 插件仍可使用。

## 10. 测试计划

| 测试包 | 测试重点 |
|--------|----------|
| `plugin-runtime` contract tests | manifest、lockfile、capability conflict、hook ordering、timeout、dispose |
| Core integration tests | `LlmService`、`ToolHost`、agent loop events、provider plugin、tool plugin |
| Harness integration tests | runner selector、planner plugin、critic plugin、approval policy、checkpoint plugin metadata |
| Gateway integration tests | descriptor serialization、admin action、health check、third-party enable/disable |
| Fault injection | activate failure、hook throw、hook timeout、deactivate timeout、channel unload leak |
| Fixture plugins | tool、LLM provider、channel、flow planner、capability indexer、admin action |

最小必须新增 fixtures：

- `fixtures/plugins/tool-echo`
- `fixtures/plugins/provider-mock`
- `fixtures/plugins/channel-memory`
- `fixtures/plugins/flow-planner-static`
- `fixtures/plugins/failing-activate`
- `fixtures/plugins/slow-hook`

## 11. 文件级任务拆解

这一节把当前源码落到可开工的任务边界。每项都应以小 PR 推进，保持旧测试可通过。

### 11.1 Core 第一批文件

| 文件/目录 | 任务 | 验收 |
|-----------|------|------|
| `packages/core/src/adapters/base.ts` | 抽稳定 `LlmService` contract 或桥接类型；保留 `LLMAdapter` 兼容 | 旧 adapter 不改或少改即可接入 |
| `packages/core/src/adapters/index.ts` | 内置 Anthropic/OpenAI/Gemini 注册为 builtin provider compatibility | 新 provider 不需要改该文件 |
| `packages/core/src/config/types.ts` | `AdapterType` 改 string；provider/model 配置挂 schema 校验 | TypeScript 不再阻止第三方 adapter 名称 |
| `packages/core/src/config/providers.ts` | preset 来源从静态表过渡到 ModelRegistry | setup wizard 可展示插件 provider |
| `packages/core/src/main.ts` | Core CLI 启动迁到 `@open-vera/openvera` 或改为创建 PluginHost services | 不再直接 new adapter |
| `packages/core/src/tools/registry.ts` | 包装为 `LegacyToolRegistryAdapter`，把 hook/middleware 行为挂到 `ToolHost` 顺序中 | 原 `registry.test.ts` 通过 |
| `packages/core/src/tools/index.ts` | `createToolRegistry()` 变为 compatibility builder；内置工具注册迁出到 builtin plugin | 旧调用方仍可运行 |
| `packages/core/src/tools/security.ts` | 拆出 Host guardrail policy；普通插件不能覆盖最终拒绝 | permission/security 测试通过 |
| `packages/core/src/tools/analytics.ts` | 迁为 audit sink，observe 失败 fail-open | session JSONL 写入不丢 |
| `packages/core/src/repl/ui/hooks/useToolCallHandler.ts` | 从直接 `registry.execute()` 改 `ToolHost.execute()` | `needsConfirm`、diff/renderHint 正常显示 |
| `packages/core/src/agent/loop.ts` | 两条路径补齐 `turn/llm/tool/context/compression` 事件 | streaming/non-streaming contract test 通过 |
| `packages/core/src/channel/plugin-registry.ts` | 先修异步 unload/disconnect，再变兼容层 | unload 后无 active adapter |
| `packages/core/src/mcp/registry.ts` | MCP tool bridge 产出 tool capability，owner 指向 mcp server | MCP tool 冲突和权限可审计 |
| `packages/core/src/session/*` | SessionService 发 `session:*` 事件；backend 保持兼容 | JSONL/SQLite 测试通过 |

### 11.2 Harness 第一批文件

| 文件/目录 | 任务 | 验收 |
|-----------|------|------|
| `packages/harness/src/cli/adapter.ts` | 删除 provider switch，调用 `LlmService` | CLI 不 import 三家 adapter |
| `packages/harness/src/runtime/runtime.ts` | 构造函数迁到 `HarnessServices`；planner/runner/critic/replan 从 services 获取 | 默认 flow 行为不变 |
| `packages/harness/src/agent/types.ts` | `AgentRunnerRegistry` 升级 selector metadata | readiness/fallback/tag 测试通过 |
| `packages/harness/src/agent/stream-runner.ts` | 改成 service consumer，不直接持有裸 adapter/model | runner 不能绕过 Host tool/policy |
| `packages/harness/src/runtime/planner.ts` | 注册 builtin `flow-planner` | planner 可被 fixture 替换 |
| `packages/harness/src/runtime/critique.ts` | 注册 builtin `flow-critic`、`replan-strategy` | 多 critic 合并可测 |
| `packages/harness/src/runtime/approval.ts` | Host gate + policy suggestion | 高风险 fail-closed |
| `packages/harness/src/runtime/artifacts.ts`、`checkpoint-store.ts`、`timeline.ts` | provider/sink capability + plugin metadata | checkpoint 记录 owner/version |
| `packages/harness/src/skill/*` | skill source/resolver/recommender 接 PluginHost | skill hot reload 不绕过插件生命周期 |
| `packages/harness/src/swarm/*` | splitter/scheduler/merger 策略 capability | Host 仍控制并发和资源 |
| `packages/harness/src/eval/*`、`benchmark/*` | runner/reporter/suite 插件化 | fixture eval runner 可注册 |
| `packages/harness/src/training/*`、`dreaming/*`、`proposal/*`、`strategy/*` | 统一接 timeline/audit/cost/approval | rollout 和训练产物不绕过 approval |

### 11.3 文档和导航

| 文件 | 任务 |
|------|------|
| `docs/zh/platform/plugin.md` | 保持为最终架构方案；顶部链接实施计划 |
| `docs/zh/platform/plugin-implementation-plan.md` | 作为任务拆解单独文档维护，实施时逐步勾状态 |
| `docs/.vitepress/config.ts` | 中文平台侧边栏加入实施计划 |
| `docs/zh/README.md` | 平台文档表格加入实施计划 |

## 12. 实施顺序建议

第一批 PR：

1. `packages/plugin-runtime` skeleton + manifest/lockfile tests。
2. EventBus + capability registry + descriptor serialization。
3. `LlmService` compatibility，替换 Core CLI/Gateway Chat/Harness CLI adapter 构造。
4. `ToolHost` compatibility，替换 REPL/subagent/skill provider 工具执行入口。

第二批 PR：

1. 内置 tool 插件化。
2. PolicyEngine/audit sink 接入 ToolHost。
3. ChannelService 和 channel adapter capability。
4. Gateway plugin/capability descriptor API。

第三批 PR：

1. ConfigComposer 和 provider/model registry。
2. PromptComposer/ContextComposer。
3. Agent loop event coverage。
4. Fixture provider/tool/channel 端到端测试。

第四批 PR：

1. HarnessServices。
2. AgentRunner selector。
3. Planner/Critic/Replan/Approval capability。
4. Artifact/checkpoint/timeline capability。

第五批 PR：

1. Skill/swarm/eval/benchmark/training/proposal/strategy 插件化。
2. Gateway UI 管理面。
3. Worker/child process isolated mode。

## 13. 风险与控制

| 风险 | 控制 |
|------|------|
| 改造面过大 | 每阶段保留 compatibility adapter，不做 big-bang |
| P0 第三方插件被误认为安全沙箱 | CLI/Gateway 明确风险提示，文档和 lockfile 记录 |
| 插件 API 泄漏内部实现 | 只导出 contracts，禁止插件 import `loop.ts`、`runtime.ts`、`registry.ts` |
| Gateway 暴露 runtime 对象 | Runtime capability 与 descriptor 分层，测试 JSON serialization |
| Hook 失败拖垮主流程 | timeout、critical 策略、observe fail-open、circuit breaker |
| Channel/tool reload 残留资源 | disposables 强制清理，fault injection 测试 |
| Harness 状态机被插件破坏 | Flow 状态机留 Host，插件只能通过策略建议和事件影响 |

## 14. 完成定义

P0/P0.5 完成后：

- 用户能启用第三方 same-process 插件。
- 插件能注册 tool/provider/channel/planner 中至少一种 capability。
- Core/Gateway/Harness 入口不再手工 new LLM adapter。
- 工具执行统一走 `ToolHost`。
- Gateway 可展示插件和 capability 状态。

全量完成后：

- Core/Harness/Gateway 都通过同一套 PluginHost 接入扩展。
- 内置 tool、adapter、channel、planner、critic、storage、RAG、memory 都以 builtin plugin 或 capability 方式注册。
- 第三方插件 P0 可用，P1 isolated mode 可选。
- 关键路径具备 contract tests、integration fixture、fault injection。

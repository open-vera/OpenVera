# Vera 插件化重构方案

> 目标：按架构层面重做插件系统，不兼容旧 API。当前已有的 Tool hook、ChannelPluginRegistry、Gateway capability 扫描等只能作为经验输入，不作为兼容约束。
>
> 实施拆解见：[Vera 插件化实施计划](./plugin-implementation-plan.md)。

## 0. 可行性结论

结论：**可行，但不能只是在现有代码里继续加 hook**。现有代码已经有几个可利用的切入面：

- Core 有 `ToolRegistry`、`LLMAdapter`、Agent loop、Session、Channel 抽象。
- Harness 有 Flow 状态机、AgentRunnerRegistry、Critique/Replan/Self-loop/Swarm。
- Gateway 有 ProjectRegistry 和 CapabilityRegistry，天然适合做插件发现、状态展示和运维操作。

主要风险不是“能不能插进去”，而是：

1. **hook 过多导致内部实现被插件锁死**：插件一旦绑定 `loop.ts` 的中间步骤，后续重构会受阻。
2. **插件能力和生命周期混在一起**：工具、模型、Channel、Sandbox、Flow 策略应该优先通过“能力注册”接入，hook 只处理横切逻辑。
3. **缺少权限和隔离边界说明**：插件本质是代码执行能力。P0 可以支持用户显式启用第三方插件，但必须把同进程插件视为“用户信任代码”，不能把 manifest 权限声明误写成强隔离安全边界。
4. **缺少冲突解决**：多个插件同时注册同名 tool/model/adapter/router 时必须有确定性规则。
5. **缺少失败策略**：插件异常、超时、资源泄漏、热重载失败时，宿主必须能降级或隔离。

推荐方向：新增统一插件运行时包，例如 `@open-vera/plugin-runtime`。Core、Harness、Gateway 依赖该包暴露的事件总线、能力注册和插件上下文；插件运行时不反向依赖 Core/Harness/Gateway。

```
packages/harness(@open-vera/openvera), apps/gateway-ui
        |
        v
@open-vera/plugin-runtime
  +-- PluginHost          插件装载、启停、排序、隔离
  +-- PluginLoader        npm / 本地目录 / workspace 发现
  +-- EventBus            intercept / transform / observe
  +-- CapabilityRegistry  tool / adapter / channel / sandbox / strategy
  +-- PolicyEngine        权限、路径、网络、secret、风险审批
  +-- ConfigComposer      配置 schema、默认值、合并、校验
        |
        +----------------+----------------+
        v                v                v
@open-vera/core    @open-vera/openvera   @open-vera/gateway
```

依赖方向：

```
core/harness/gateway -> plugin-runtime -> shared/logger

禁止：
plugin-runtime -> core
core -> harness
core -> gateway
```

## 1. 设计原则

### 1.1 能力注册优先，Hook 辅助

插件接入点分两类：

| 类型 | 用途 | 示例 |
|------|------|------|
| Capability | 提供一个稳定能力 | tool、LLM adapter、model provider、channel adapter、sandbox provider、agent runner、flow planner |
| Hook | 处理横切逻辑 | 安全拦截、审计、请求改写、结果脱敏、token 统计 |

大部分扩展都应走 Capability，而不是 hook 内部流程：

```ts
ctx.provide.tool(def);
ctx.provide.llmAdapter("openai-compatible", factory);
ctx.provide.channel("slack", factory);
ctx.provide.flowPlanner("software-dev", planner);
```

hook 只用于“在能力执行前后做横切处理”：

```ts
ctx.hooks.intercept("tool:before:bash", checkPolicy);
ctx.hooks.transform("llm:request", rewriteMessages);
ctx.hooks.observe("session:write", audit);
```

### 1.2 稳定事件契约，不暴露内部函数

插件不应该 import `loop.ts`、`registry.ts`、`runtime.ts` 的内部函数。宿主只暴露稳定事件和能力接口：

```ts
interface HookEventMap {
  "llm:request": {
    value: LlmRequest;
    result: LlmRequest | InterceptResult<LlmResponse>;
  };
  "tool:before": {
    value: ToolCall;
    result: ToolCall | InterceptResult<ToolResult>;
  };
  "flow:critique:decision": {
    value: CritiqueDecision;
    result: CritiqueDecision;
  };
}
```

事件可以增加字段，但不能随内部重构频繁改语义。没有稳定契约的内部步骤不要开放为插件 API。

### 1.3 安全策略是宿主能力，不是普通插件

`SecurityPlugin` 这类能力可以用插件形式实现，但“最终权限裁决”必须由 Host PolicyEngine 掌握。普通插件不能绕过 Host 提供的 tool/channel/sandbox/storage 等受控服务：

- 路径边界
- 网络域名 allowlist
- 危险命令审批
- secret 访问
- 预算限制
- 高风险 tool 调用

注意：P0 same-process 不是安全沙箱。第三方插件一旦被用户安装并启用，就等价于运行用户选择的本地代码。Host 能约束插件通过 Vera API 发起的能力调用，但不能可靠阻止插件直接 import Node 内置模块、读取 `process.env` 或执行模块初始化副作用。P0 的产品策略是“允许用户使用，明确风险、记录审计、提供禁用/卸载/lockfile”；强隔离留到 P1/P2。

## 2. 插件包模型

### 2.1 插件来源

建议支持四类来源：

| 来源 | 路径/格式 | 适用场景 |
|------|-----------|----------|
| 内置插件 | `packages/*/src/plugins` 或打包内置 | 默认 tool、provider、security、analytics |
| 项目插件 | `.vera/plugins/<id>` | 项目私有能力 |
| 用户插件 | `~/.vera/plugins/<id>` | 个人常用能力 |
| npm/workspace 插件 | package dependency | 可发布生态插件 |

P0 起就允许加载用户显式启用的项目/用户/npm/workspace 插件。启用第三方插件时 CLI/Gateway 应展示来源、版本、权限声明和同进程风险提示，并写入 lockfile；是否继续使用由用户决定。

插件状态独立于来源：

```
discovered -> installed -> enabled -> activated -> deactivated
                                      |
                                      +-> error / quarantined
```

### 2.2 Manifest

每个插件必须声明 manifest，禁止只靠运行时动态探测。

```json
{
  "id": "com.example.slack",
  "name": "Slack Channel",
  "version": "1.0.0",
  "apiVersion": "1",
  "entry": "./dist/index.js",
  "scope": "project",
  "activationEvents": ["onChannel:slack", "onStartup"],
  "contributes": {
    "channels": [{ "type": "slack", "name": "Slack" }],
    "tools": [{ "name": "slack_send_message" }],
    "configSchema": "./schema.json"
  },
  "permissions": {
    "fs": [{ "mode": "read", "paths": [".vera/channels"] }],
    "network": [{ "host": "slack.com" }],
    "env": ["SLACK_BOT_TOKEN"],
    "secrets": ["slack.bot_token"],
    "tools": ["read_file"]
  }
}
```

必要字段：

| 字段 | 说明 |
|------|------|
| `id` | 全局唯一，反向域名或 npm 包名 |
| `version` | 插件自身版本 |
| `apiVersion` | Vera 插件 API 主版本 |
| `entry` | ESM 入口 |
| `activationEvents` | 懒激活条件 |
| `contributes` | 静态贡献，供 Gateway 和 CLI 在未激活时展示 |
| `permissions` | 权限声明，运行时按声明授权 |

### 2.3 插件入口

```ts
import { definePlugin } from "@open-vera/plugin-runtime";

export default definePlugin({
  async activate(ctx) {
    ctx.provide.tool({
      name: "slack_send_message",
      description: "Send a Slack message",
      parameters: { type: "object", properties: {} },
      async execute(args, toolCtx) {
        const token = await ctx.secrets.get("slack.bot_token");
        return sendSlackMessage(token, args, toolCtx);
      },
    });

    ctx.hooks.observe("tool:after:slack_send_message", async (event) => {
      ctx.logger.info("slack message sent", { sessionId: event.ctx.sessionId });
    });

    ctx.disposables.add(() => closeConnections());
  },

  async deactivate(ctx) {
    await ctx.dispose();
  },
});
```

入口约束：

- import 阶段按 API 契约不得执行副作用；副作用必须放进 `activate()`。P0 同进程无法强制检查，只能通过文档、lint/扫描、审计和用户信任约束；P1 通过 Worker/child process 才能强制隔离。
- 长连接、定时器、watcher、临时文件必须注册到 `ctx.disposables`。
- 插件应通过 `ctx` 访问配置、secret、文件、网络和宿主能力。P0 对第三方插件是约定和审计，P1/P2 才能做到强制代理。

## 3. 插件上下文

建议的 `PluginContext`：

```ts
interface PluginContext {
  readonly pluginId: string;
  readonly scope: "builtin" | "project" | "workspace" | "user";
  readonly logger: PluginLogger;
  readonly signal: AbortSignal;

  config: {
    get<T>(path?: string): T;
    watch<T>(path: string, fn: (value: T) => void): Disposable;
  };

  secrets: {
    get(name: string): Promise<string>;
  };

  storage: {
    kv(namespace?: string): PluginKvStore;
    files(namespace?: string): PluginFileStore;
  };

  provide: CapabilityProvider;
  hooks: HookRegistrar;
  commands: CommandRegistrar;
  disposables: DisposableStore;
}
```

插件私有状态必须命名空间化：

```
.vera/plugins-state/<plugin-id>/
  kv.sqlite
  files/
  logs/
```

## 4. 能力注册模型

所有贡献都归一化为 `CapabilityDescriptor`，Gateway 可以直接展示和操作。

```ts
interface RuntimeCapability<TFactory = unknown> {
  id: string;
  kind:
    | "tool"
    | "llm-adapter"
    | "model-provider"
    | "channel"
    | "mcp-server"
    | "sandbox-provider"
    | "storage-adapter"
    | "rag-provider"
    | "loader"
    | "prompt-block"
    | "memory-strategy"
    | "agent-runner"
    | "flow-planner"
    | "flow-critic"
    | "approval-policy"
    | "gateway-panel";
  ownerPluginId: string;
  scope: "builtin" | "project" | "workspace" | "user";
  status: "available" | "disabled" | "error";
  configSchema?: JsonSchema;
  permissions?: PermissionSpec;
  conflicts?: string[];
  healthCheck?: () => Promise<CapabilityHealth>;
  factory: TFactory;
}
```

### 4.1 冲突规则

必须显式规定冲突行为：

| 场景 | 规则 |
|------|------|
| 同名 tool | 默认拒绝；只有声明 `override: true` 且目标允许覆盖时才替换 |
| 同名 model alias | 项目 > workspace > user > builtin |
| 同类 singleton，如 intent router | 只允许一个 active；按优先级选择，其余进入 shadow 状态 |
| 多个 transform hook | 顺序串行执行 |
| 多个 observe hook | 并发执行，不影响主流程 |
| 多个 policy hook | 全部必须通过，任一拒绝即拒绝 |

推荐排序：

```
Host guardrails
  -> project pre
  -> workspace pre
  -> user pre
  -> builtin pre
  -> project normal
  -> workspace normal
  -> user normal
  -> builtin normal
  -> post
  -> Host audit
```

安全 guardrail 和审计不参与普通插件排序，不能被覆盖。

## 5. Hook 引擎

### 5.1 Hook 类型

保留四类通用 hook，但要强类型化：

```ts
interface HookRegistrar {
  config<T>(fn: ConfigHook<T>): Disposable;
  intercept<K extends InterceptEvent>(event: K, fn: InterceptHook<K>, opts?: HookOptions): Disposable;
  transform<K extends TransformEvent>(event: K, fn: TransformHook<K>, opts?: HookOptions): Disposable;
  observe<K extends ObserveEvent>(event: K, fn: ObserveHook<K>, opts?: HookOptions): Disposable;
}
```

| Hook | 语义 | 可短路 | 执行方式 | 失败策略 |
|------|------|--------|----------|----------|
| `config` | 合并配置默认值和 schema | 否 | 有序串行 | 配置失败则插件不可激活 |
| `intercept` | 拦截并返回最终结果 | 是 | 有序串行，first handled wins | 关键事件 fail-closed |
| `transform` | 修改值并传给下一个 hook | 否 | 有序串行 | 按事件策略 fail-open/fail-closed |
| `observe` | 观测事件 | 否 | 并发 fire-and-forget，可 await flush | fail-open |

### 5.2 Hook 返回值

```ts
type InterceptResult<T> =
  | { handled: true; value: T; reason?: string }
  | { handled: false };

type TransformResult<T> =
  | T
  | { value: T; warnings?: string[] };

interface HookOptions {
  priority?: number;
  enforce?: "pre" | "post";
  timeoutMs?: number;
  critical?: boolean;
}
```

### 5.3 事件命名

使用 `domain:phase[:name]`：

```
tool:before:bash
tool:after:read_file
llm:request
llm:response
flow:step:start
flow:critique:decision
channel:message:receive
```

支持 glob 订阅：

```
tool:before:*
flow:*:error
```

事件 payload 必须：

- 可序列化，用于审计和 replay。
- 带 `traceId`、`sessionId`、`flowId`、`pluginId` 等关联字段。
- 明确哪些字段可变，哪些字段只读。

## 6. Core 扩展面

Core 的目标是“单次 LLM 调用和 Agent loop 所需能力”。推荐开放以下能力：

| 能力 | 说明 | 现有基础 |
|------|------|----------|
| `llm-adapter` | 注册 Anthropic/OpenAI/Gemini 之外的 adapter | `LLMAdapter` |
| `model-provider` | 注册 provider、model alias、headers、base_url | `VeraConfig.providers/models` |
| `intent-router` | 自定义意图分类和模型路由 | `intent` |
| `prompt-block` | 注入 system prompt、tool instruction、project context | `prompt/project-context` |
| `context-provider` | 额外上下文注入 | `memory/project-context/rag` |
| `memory-strategy` | 记忆选择、压缩、注入策略 | `memory` |
| `tool` | 注册工具 | `ToolRegistry` |
| `tool-policy` | 工具执行权限、审批、预算 | `SecurityPlugin` |
| `sandbox-provider` | Docker/Cube/远程 sandbox | `sandbox` |
| `storage-adapter` | object/session/user data 存储 | `storage/session` |
| `channel-adapter` | CLI/API/Webhook/IM 平台 | `channel` |

Core 关键事件：

```
config:load
config:resolved
runtime:start
runtime:stop
session:create
session:write
session:close
turn:start
turn:end
prompt:build
context:select
context:inject
memory:select
memory:inject
llm:request
llm:response
llm:error
tool:register
tool:before:<name>
tool:after:<name>
tool:error:<name>
channel:connect
channel:disconnect
channel:message:receive
channel:message:send
compression:before
compression:after
```

### 6.1 必须重写的 Core 点

| 模块 | 改造 |
|------|------|
| `config/types.ts` | `AdapterType` 不能再固定为 Anthropic/OpenAI/Gemini 三选一，改为 string registry |
| `adapters/index.ts` | 去掉固定导出即完整能力的假设，改为内置 adapter 插件注册 |
| `ToolRegistry` | `use()` / middleware 合并进统一 hook engine，保留 registry 作为 capability store |
| `ChannelPluginRegistry` | 并入统一 CapabilityRegistry，Channel 只是 capability kind |
| `SecurityPlugin` / `AnalyticsPlugin` | 转为内置插件，但最终裁决留给 PolicyEngine |
| `core/src/index.ts` / `main.ts` | 应用启动逻辑迁到 app/CLI，Core 只导出运行时构造器 |

## 7. Harness 扩展面

Harness 的目标是“多步骤任务编排”。推荐开放：

| 能力 | 说明 |
|------|------|
| `flow-planner` | 自然语言目标转 ExecutionPlan |
| `step-scheduler` | 步骤拓扑排序、并发策略、重试策略 |
| `agent-runner` | 本地 core agent、外部 CLI、远程 agent、专用角色 agent |
| `flow-critic` | step critique / cycle critique |
| `replan-strategy` | 根据 critique 生成新计划 |
| `approval-policy` | 高风险步骤审批、自动批准、人工确认 |
| `artifact-store` | 产物持久化和索引 |
| `swarm-sandbox` | swarm 任务运行环境 |

Harness 关键事件：

```
flow:start
flow:plan:generate
flow:plan:resolved
flow:plan:change
flow:step:dispatch
flow:step:start
flow:step:end
flow:step:error
flow:step:critique
flow:critique:decision
flow:replan
flow:pause
flow:resume
flow:checkpoint
flow:complete
flow:fail
agent:assign
agent:start
agent:end
agent:error
self-loop:cycle:start
self-loop:cycle:end
self-loop:decision
swarm:task:queued
swarm:task:started
swarm:task:completed
swarm:task:failed
swarm:sandbox:created
swarm:sandbox:destroyed
```

重点：Harness 插件不能直接调用底层 LLM SDK，必须通过 Core 的 adapter registry 或 injected `LlmService`。

## 8. Gateway 扩展面

Gateway 负责项目发现、能力展示、启停和运维。

| 能力 | 说明 |
|------|------|
| `project-detector` | 自定义项目识别规则 |
| `capability-indexer` | 扫描 `.vera`、MCP、plugin、channel、flow 等资源 |
| `gateway-panel` | UI 面板贡献 |
| `health-check` | 插件和 capability 健康检查 |
| `admin-action` | enable/disable/reload/test/connect/disconnect |

Gateway 事件：

```
gateway:start
gateway:stop
project:discover
project:capability:index
plugin:discover
plugin:install
plugin:enable
plugin:disable
plugin:activate
plugin:deactivate
plugin:error
capability:health
admin:action
```

Gateway 不应该自己解释插件业务能力，只展示 `CapabilityDescriptor` 和调用标准 admin action。

## 9. 配置合成

配置必须从“全局大对象”改为“schema 驱动、插件命名空间化”。

推荐结构：

```json
{
  "providers": {},
  "models": {},
  "plugins": {
    "com.example.slack": {
      "enabled": true,
      "config": {
        "workspace": "vera"
      }
    }
  }
}
```

合并顺序：

```
内置默认值
  -> 插件 manifest 默认值
  -> 用户全局配置 ~/.vera/settings.json
  -> workspace 配置
  -> 项目配置 .vera/settings.json
  -> 环境变量 / CLI flags
  -> config hooks
  -> schema 校验
```

要求：

- 每个插件只能读取自己的 `plugins.<id>.config`，跨插件读取必须显式授权。
- secret 不进入普通 config；通过 `ctx.secrets` 读取。
- config hook 不允许做网络请求和长耗时初始化。
- 最终 resolved config 要能导出，用于 debug 和审计。

## 10. 权限、隔离与供应链

### 10.1 权限模型

在 Vera API 语义上，插件默认无权限。所有能力通过 manifest 声明，由用户或项目策略批准。P0 同进程插件仍可能绕过 Vera API 直接访问 Node 运行时，因此这里的权限模型主要约束插件通过 Host 服务发起的能力调用；强制隔离依赖 P1/P2。

```ts
interface PermissionSpec {
  fs?: Array<{ mode: "read" | "write"; paths: string[] }>;
  network?: Array<{ host: string; ports?: number[] }>;
  env?: string[];
  secrets?: string[];
  process?: { spawn?: boolean; commands?: string[] };
  tools?: string[];
  channels?: string[];
  mcpServers?: string[];
}
```

### 10.2 隔离阶段

| 阶段 | 模式 | 适用 |
|------|------|------|
| P0 | explicit-trust same-process | 内置插件、开发期、用户显式启用的第三方插件 |
| P1 | Worker/child process + RPC | 需要崩溃隔离、热重载、资源限制的插件 |
| P2 | sandbox/container/remote plugin host | 高风险插件、企业环境 |

注意：ESM 模块在同进程内无法可靠卸载。P0 支持第三方插件使用，但不承诺崩溃隔离、强制权限代理或彻底热卸载；真正热重载、资源清理和崩溃隔离需要 Worker 或子进程插件宿主。

### 10.3 供应链控制

必须补：

- 插件 lockfile：记录来源、版本、checksum、启用状态、批准权限。
- 安装 allowlist/denylist。
- npm 插件签名或 checksum 校验。
- 插件运行审计：何时激活、申请了哪些权限、调用了哪些敏感能力。

P0 的供应链控制不阻断用户安装第三方插件，但必须让用户看得见、关得掉、查得到：安装来源、版本、checksum、启用时间、权限声明、最后激活错误都要进入 Gateway/CLI 可见状态。

## 11. 失败策略

插件错误不能默认拖垮宿主。

| 场景 | 策略 |
|------|------|
| observe hook 失败 | 记录错误，继续主流程 |
| transform hook 失败 | 根据事件 `critical` 决定 fail-open/fail-closed |
| intercept hook 失败 | 安全/权限/审批类 fail-closed；普通路由类可 fallback |
| activate 失败 | 插件状态置为 error，capability 不可用 |
| 连续失败 | circuit breaker，进入 quarantined |
| deactivate 超时 | 强制 abort；Worker 模式下 kill worker |
| 健康检查失败 | Gateway 标记 error，可手动 reload |

每个 hook 必须有 timeout，默认建议：

| Hook | 默认超时 |
|------|----------|
| config | 500ms |
| intercept | 2s |
| transform | 2s |
| observe | 1s，后台 flush 可延长 |
| capability healthCheck | 5s |

## 12. 可观测性

每个插件要有独立指标：

- activation time
- hook count / latency / error rate
- capability invocation count
- denied permission count
- network/fs/process access audit
- last health check

日志结构：

```
.vera/logs/plugins/<plugin-id>.jsonl
```

事件最少包含：

```ts
interface PluginTrace {
  traceId: string;
  pluginId: string;
  event: string;
  sessionId?: string;
  flowId?: string;
  capabilityId?: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}
```

## 13. 生命周期节点

插件运行时生命周期：

```
discover manifests
  -> validate manifest
  -> resolve dependencies
  -> compose config schema/defaults
  -> permission approval
  -> activate plugin
  -> register capabilities
  -> run health checks
  -> serve runtime events
  -> deactivate
  -> dispose resources
```

运行中事件不再要求覆盖每个内部函数，只覆盖稳定边界：

| 边界 | 事件 |
|------|------|
| 配置 | `config:load`、`config:resolved` |
| Agent turn | `turn:start`、`turn:end` |
| Prompt/context | `prompt:build`、`context:inject` |
| LLM | `llm:request`、`llm:response`、`llm:error` |
| Tool | `tool:register`、`tool:before:*`、`tool:after:*`、`tool:error:*` |
| Channel | `channel:connect`、`channel:message:receive`、`channel:message:send` |
| Session | `session:create`、`session:write`、`session:close` |
| Flow | `flow:start`、`flow:step:*`、`flow:critique:decision`、`flow:complete` |
| Gateway | `plugin:*`、`capability:health`、`admin:action` |

## 14. 当前实现资产清单与接入推演

这一节按当前仓库实现梳理“已有能力 -> 插件形态 -> 接入方式”。判断标准：

- **Host 保留**：运行时主循环、状态机、权限最终裁决、生命周期管理，不作为普通插件开放。
- **内置插件化**：已有实现重包为内置插件，默认启用，但走同一套 capability/hook 接口。
- **外部插件化**：允许第三方实现同一接口并注册 capability。
- **暂缓插件化**：内部工具函数或协议类型，先保持库能力，不暴露为插件点。

### 14.1 能力分类总表

| Capability kind | 当前实现来源 | 插件化目标 |
|-----------------|--------------|------------|
| `llm-adapter` | `core/src/adapters/*` | Anthropic/OpenAI/Gemini 转内置 adapter 插件；新 provider 不改 Core |
| `model-provider` | `core/src/config/model-tiers.ts`、`providers.ts` | provider/model alias 由插件贡献 schema 和默认配置 |
| `tool` | `core/src/tools/*` | 所有内置 tool 通过内置插件注册；MCP/skill/tool 插件同路接入 |
| `tool-policy` | `security.ts`、`permission-rules.ts`、`tool-budget.ts` | Host PolicyEngine + 内置安全策略插件 |
| `audit-sink` | `analytics.ts`、session JSONL | 审计/统计/成本记录通过 observe hook 和 sink capability 接入 |
| `channel-adapter` | `core/src/channel/*` | CLI/API/Webhook/IM adapter 全部转 channel capability |
| `mcp-server` | `core/src/mcp/*` | MCP server 作为 capability，MCP tool bridge 产出 tool capability |
| `sandbox-provider` | `core/src/sandbox/*` | Docker/CubeSandbox/远程沙箱统一 provider |
| `storage-provider` | `core/src/storage/*` | KV、object store、session backend、artifact uploader 插件化 |
| `rag-provider` | `core/src/rag/*`、`loaders/*` | loader、embedding、vector store、indexer、retriever 分层插件化 |
| `prompt-block` | `core/src/prompt/*`、`project-context/*` | system prompt、profile、project rules、dynamic block 可注册 |
| `context-provider` | `context/*`、`memory/*`、`rag/*` | 上下文注入源独立注册，Host 做预算和排序 |
| `memory-strategy` | `memory/*` | detector、selector、merge、organizer、updater 可替换 |
| `agent-runner` | `harness/src/agent/*` | stream/local CLI/role/remote agent runner 插件化 |
| `flow-planner` | `harness/src/runtime/planner.ts` | 自然语言 -> plan 策略插件化 |
| `flow-critic` | `harness/src/runtime/critique.ts`、`critic/*` | plan/step/cycle critique 策略插件化 |
| `replan-strategy` | `runtime/critique.ts` merge/replan | replan prompt、merge 策略插件化 |
| `approval-policy` | `runtime/approval.ts` | 审批策略插件化，但高风险最终由 Host 裁决 |
| `artifact-store` | `runtime/artifacts.ts`、`checkpoint-store.ts` | flow artifact/checkpoint 存储插件化 |
| `swarm-scheduler` | `harness/src/swarm/*` | scheduler、splitter、merger、sandbox 绑定插件化 |
| `skill-source` | `harness/src/skill/*`、`core/src/skill-evolution/*` | skill loader/resolver/recommender/version/hot reload 插件化 |
| `eval-runner` | `harness/src/eval/*` | GAIA/SWE-bench/WebArena/ToolBench 作为 runner 插件 |
| `benchmark-suite` | `harness/src/benchmark/*` | benchmark case source、reporter、CI gate 插件化 |
| `training-pipeline` | `harness/src/training/*` | data prepare、trainer、eval、skill import 插件化 |
| `strategy-engine` | `harness/src/strategy/*` | AB test、auto tuner、strategy store 插件化 |
| `project-detector` | `gateway/src/project-registry.ts` | 项目识别规则插件化 |
| `capability-indexer` | `gateway/src/capability-registry.ts` | `.vera` 能力扫描由 indexer 插件贡献 |
| `health-check` | `gateway/src/doctor.ts` | capability/plugin 健康检查插件化 |
| `gateway-panel` | `apps/gateway-ui/web/src/views/*` | UI 页面/面板贡献点，先做内置注册表，后续再开放远程 UI |
| `admin-action` | `apps/gateway-ui/server/src/actions.ts` | enable/disable/reload/test/connect 等动作统一 action capability |

### 14.2 Core 当前模块清单

| 当前模块 | 当前职责 | 目标插件形态 | 接入推演 |
|----------|----------|--------------|----------|
| `adapters/anthropic.ts`、`openai.ts`、`gemini.ts` | 具体 LLM SDK 适配 | 内置 `llm-adapter` | 插件 `@open-vera/plugin-provider-*` 调用 `ctx.provide.llmAdapter()`；`buildAdapter()` 改为 registry lookup |
| `adapters/base.ts` | `LLMAdapter` 协议 | Host contract | 保留为共享类型，迁到 `plugin-runtime/contracts` 或 `core/adapters` 稳定导出 |
| `config/types.ts` | provider/model/routing/session/MCP 配置 | `config-schema` + `model-provider` | `AdapterType` 改成 `string`；插件贡献 schema/defaults；ConfigComposer 合并后校验 |
| `config/loader.ts`、`paths.ts`、`setup.ts` | 配置文件加载、路径、首次设置 | Host + config source | loader 保留在 CLI/Host；setup wizard 从 adapter registry 读取可用 provider |
| `config/model-tiers.ts`、`providers.ts` | 默认模型、路由、provider 解析 | `model-router` | 内置路由插件提供默认策略；第三方可注册 intent/model router |
| `agent/loop.ts` | Agent turn loop、LLM 调用、tool call、压缩 | Host runtime | 不整体插件化；只在稳定边界发事件：turn、prompt、llm、tool、compression |
| `agent/subagent.ts`、`subagent-*` | 子 Agent 工具、定义加载、隔离执行 | `agent-runner` + `tool` + `agent-definition-source` | subagent tool 作为内置 tool；定义加载作为 provider；执行走 agent-runner |
| `context/compression.ts`、`idle-compression.ts` | 压缩策略 | `compression-strategy` | Host 管预算，插件只提供压缩实现和触发建议 |
| `context/window.ts`、`tokens.ts` | token 估算和滑窗 | Host policy + `token-estimator` | 默认保留 Host；如要开放只开放 estimator，不开放裁剪最终裁决 |
| `context/tool-budget.ts` | tool 结果预算 | `tool-policy` | 并入 PolicyEngine；插件可提出预算建议，Host 执行裁剪 |
| `prompt/*` | 内置模板、profile、渲染、PromptStore | `prompt-block` + `prompt-profile` | 插件贡献 prompt template/profile；Host 按 intent/scope 排序渲染 |
| `project-context/*` | 加载 CLAUDE.md、`.vera/rules.md` | `context-provider` | 内置 project-context 插件提供上下文块；读取路径受 fs 权限约束 |
| `memory/*` | 记忆扫描、检测、store、merge、organize、updater | `memory-store` + `memory-strategy` + `context-provider` | MemoryStore 作为 provider；detector/merge/topic/updater 可替换；注入通过 context provider |
| `tools/registry.ts` | tool 注册、执行、middleware、hooks、重试、缓存、统计 | Host `ToolHost` + `tool` capability | Registry 变薄：只保存 tool capability；before/after/error 走 EventBus；重试/缓存策略可配置 |
| `tools/security.ts` | allow/deny、readonly、路径、域名、预算、注入检测 | Host PolicyEngine + 内置策略 | 迁成不可绕过 guardrail；普通插件不能覆盖最终拒绝 |
| `tools/analytics.ts` | tool_call/tool_result 写 session | `audit-sink` | observe `tool:*` 和 `session:write`；失败 fail-open |
| `tools/permission-rules.ts` | 持久化工具权限规则 | `policy-source` | 项目/用户规则作为 policy source；Gateway 可编辑 |
| `tools/read-file.ts`、`write-file.ts`、`edit-file.ts`、`list-dir.ts`、`glob.ts`、`grep.ts` | 文件系统工具 | 内置 tool 插件 `core-tools-fs` | 注册 `read_file/write_file/edit_file/list_dir/glob/grep`；权限由 PolicyEngine 检查路径 |
| `tools/bash.ts` | shell 命令 | 内置 tool 插件 `core-tools-shell` | 高风险 tool；命令审批、sandbox 偏好、allowlist 必须走 Host |
| `tools/browser.ts` | 浏览器自动化 | 内置/可选 tool 插件 `browser-use` | 依赖 Playwright/CDP；注册前做 health check；网络权限和截图产物审计 |
| `tools/desktop-*`、`computer-use.ts` | 桌面截图、输入、脚本、可访问性、组合操作 | 可选高风险插件 `computer-use` | 默认禁用或需授权；UI/桌面权限、进程执行、截图敏感数据审计 |
| `tools/visual-analyze.ts` | 图像分析工具 | tool + `llm-service` consumer | 插件声明需要 `llm-adapter` 权限；运行时从 Host 获取受控 LLM service |
| `tools/memory-*` | 记忆读写工具 | tool + `memory-store` consumer | 仅当 memory capability 可用时注册 |
| `tools/knowledge-search.ts` | RAG 检索工具 | tool + `rag-provider` consumer | 仅当 vector store + embedding 可用时注册 |
| `tools/sandbox.ts` | sandbox exec/upload/download | tool + `sandbox-provider` consumer | 工具本身内置；实际 provider 可替换 |
| `tools/storage.ts`、`storage/user-data.ts` | 文件上传/下载/list，用户数据工具 | tool + `object-store`/`user-data-store` | object store 插件可替换，工具按 capability 自动注册 |
| `tools/multi-step-orchestrator.ts` | 工具级多步编排 | 暂缓，或 `tool-orchestrator` | 短期保持库能力；长期作为内部 capability 给复杂 tool 使用 |
| `tools/operation-recorder.ts` | 执行录制/回放 | `audit-sink` + `replay-provider` | 可服务测试和调试；事件必须可序列化 |
| `mcp/client.ts`、`discovery.ts` | MCP 连接和发现 | `mcp-server` + `mcp-transport` | MCP server 配置由插件/config source 贡献；连接由 Host 管生命周期 |
| `mcp/registry.ts` | MCP tool -> Vera tool | `tool-bridge` | 每个 MCP tool 映射为 tool capability，owner 指向 MCP server capability |
| `channel/*` | CLI/API/Webhook/Feishu/WeCom/Telegram/Discord/Slack/WhatsApp | `channel-adapter` | 每个 adapter 由内置插件注册；`ChannelPluginRegistry` 并入统一 CapabilityRegistry |
| `channel/gateway.ts` | 多 channel 连接、消息派发 | Host gateway | 保留 orchestrator；消息 receive/send 发 hook |
| `rag/*` | embedding、vector store、document loader、indexer | `rag-provider` 系列 | loader/embedding/vector/indexer 分开注册；`knowledge_search` 只消费 retriever |
| `loaders/*` | Text/Markdown/TypeScript loader、batch indexer | `document-loader` + `indexer` | loader 按 file extension 注册；BatchIndexer 从 registry 选择 loader |
| `sandbox/docker.ts`、`cubesandbox.ts` | 沙箱 provider | `sandbox-provider` | Docker/CubeSandbox 内置 provider；远程 provider 可插件贡献 |
| `storage/*` | SQLite、FileStore、ObjectStore、OSS/S3/TOS、本地 FS、artifact/content uploader | `storage-provider`/`object-store`/`artifact-store` | session/user-data/object/artifact 分开注册，避免一个存储抽象过大 |
| `session/*` | JSONL/SQLite 会话、分支、fork、cost、title | `session-backend` + hooks | SessionManager 保留 Host；backend/title/cost sink 可插件化 |
| `network/*` | message bus、scheduler、shared memory | 暂缓或 `agent-network` | 目前像实验性多 Agent 组件，先不作为 P0 插件面 |
| `worktree/index.ts` | git worktree 创建/合并/删除 | `workspace-provider`/`isolation-provider` | REPL `/try`、subagent 隔离、swarm 可共用；高风险 git 操作走审批 |
| `repl/*` | 终端 UI、workspace、命令入口 | App host + `repl-command` | REPL 本体不做普通插件；命令、面板、快捷能力可注册 |
| `skill-evolution/*` | skill 自动创建、反思、版本、过滤 | `skill-authoring` | 与 Harness skill 系统合并，作为内置 skill 研发插件 |
| `types/*`、`errors.ts`、`utils/*` | 协议类型、错误、工具函数 | shared contract | 迁出稳定 API 到 `@open-vera/shared` 或 `plugin-runtime/contracts` |

### 14.3 Tool 分组改造清单

| 组 | 当前工具 | 默认状态 | 插件包建议 |
|----|----------|----------|------------|
| 文件读写 | `read_file`、`write_file`、`edit_file`、`list_dir`、`glob`、`grep` | 默认启用，写操作需策略约束 | `@open-vera/plugin-tools-fs` |
| Shell | `bash` | 默认启用但高风险审批 | `@open-vera/plugin-tools-shell` |
| 浏览器 | `browser` | 可选启用 | `@open-vera/plugin-browser` |
| 桌面/Computer Use | `desktop_screenshot`、`desktop_input`、`desktop_script`、`desktop_accessibility`、`computer_use` | 默认禁用或首次授权 | `@open-vera/plugin-computer-use` |
| 视觉 | `visual_analyze` | 有 LLM adapter 时启用 | `@open-vera/plugin-vision-tools` |
| 记忆 | `memory_write`、`memory_search` | 有 memory store 时启用 | `@open-vera/plugin-memory` |
| 知识库 | `knowledge_search` | 有 RAG retriever 时启用 | `@open-vera/plugin-rag` |
| 沙箱 | `sandbox_exec`、`sandbox_upload`、`sandbox_download` | 有 sandbox provider 时启用 | `@open-vera/plugin-sandbox-tools` |
| 对象存储 | `file_upload`、`file_download`、`file_list` | 有 object store 时启用 | `@open-vera/plugin-storage-tools` |
| 用户数据 | `data_save`、`data_load`、`data_list`、`data_delete` | 有 user data store 时启用 | `@open-vera/plugin-user-data` |
| 子 Agent | `agent` / subagent tool | 有 agent definition source 时启用 | `@open-vera/plugin-subagent` |
| MCP | 来自 MCP server 的动态工具 | server connected 后启用 | `@open-vera/plugin-mcp` |

工具注册流程应从当前 `createToolRegistry(opts)` 改成：

```
PluginHost.activateBuiltins()
  -> collect tool capabilities
  -> ToolHost.buildSchemas(policy.filteredTools)
  -> Agent loop receives schemas
  -> tool call
     -> PolicyEngine.preflight
     -> EventBus.intercept("tool:before:<name>")
     -> tool.execute()
     -> EventBus.transform("tool:after:<name>")
     -> audit/stats/session write
```

### 14.4 Harness 当前模块清单

| 当前模块 | 当前职责 | 目标插件形态 | 接入推演 |
|----------|----------|--------------|----------|
| `runtime/runtime.ts` | Flow 主状态机、dispatch、agent run、critique、replan、loop | Host runtime | 保留状态机；planner/runner/critic/replan/approval/artifact 都从 capability registry 获取 |
| `runtime/flow-state.ts`、`flow.ts` | 状态转换、TaskFlow 创建 | Host contract | 不开放普通插件；只开放事件和策略接口 |
| `runtime/planner.ts`、`plan-parser.ts` | goal -> ExecutionPlan、解析 | `flow-planner` | 默认 planner 内置；插件可注册 planner 并按 domain/risk 选择 |
| `runtime/critique.ts`、`critic/*` | plan/step critique、replan prompt、retrospective | `flow-critic` + `replan-strategy` | CritiqueRunner 和 prompt builder 内置；插件可覆盖 judge 或 merge 策略 |
| `runtime/approval.ts` | ApprovalRecord、暂停判断 | `approval-policy` | 插件可建议 approve/reject/ask_human；Host 对高风险 fail-closed |
| `runtime/artifacts.ts`、`checkpoint-store.ts`、`timeline.ts` | artifact、checkpoint、timeline 写盘 | `artifact-store` + `checkpoint-store` + `timeline-sink` | 默认本地 FS；Gateway/云端存储可替换 |
| `runtime/failure-attributor.ts` | 失败归因与 replay plan | `failure-attributor` | 内置策略；评估/训练插件可消费结果 |
| `runtime/output-truncator.ts` | 输出截断 | Host policy + `output-transform` | 预算相关留 Host，格式化可走 transform |
| `agent/types.ts` | AgentRunner 接口和 Registry | `agent-runner` capability | 现有接口可直接成为插件 contract |
| `agent/stream-runner.ts` | Core streamAgent runner | 内置 `agent-runner` | 默认 runner，依赖 Core LLM/tool/prompt service |
| `agent/external-cli-runner.ts` | 外部 CLI agent | `agent-runner` | 进程权限、命令 allowlist、工作目录隔离走 PolicyEngine |
| `agent/role-runners.ts` | pm/architect/engineer/tester/reviewer | `agent-runner` + `prompt-profile` | 角色作为 runner preset，也可拆成 prompt profile |
| `agent/critique-runner.ts` | 专用 critique runner | `flow-critic` 或 `agent-runner` | 更适合注册为 critic capability |
| `flow/self-loop.ts` | 自循环 critique/replan/停止条件 | `self-loop-policy` | 终止条件、duplicate critique、budget 策略可插件化 |
| `skill/*` | Skill loader/resolver/recommender/hot reload/version/extraction | `skill-source`、`skill-resolver`、`skill-recommender` | skill 目录变成一种插件来源；Skill 本身可编译为 prompt/tool/context capability |
| `flow-config/*` | Markdown/YAML flow 配置解析 | `flow-source` | `.md/.yaml` plan loader 作为插件注册 |
| `swarm/*` | task scheduler、splitter、result merger | `swarm-scheduler`、`task-splitter`、`result-merger` | scheduler Host 化，split/merge 策略插件化，sandbox provider 外接 |
| `eval/*` | EvalHarness、GAIA/SWE-bench/WebArena/ToolBench runner、reporter | `eval-runner` + `eval-reporter` | 每个 benchmark runner 是插件；case source 可配置 |
| `benchmark/*` | benchmark harness、CI gate、regression detector、reporter | `benchmark-suite` + `quality-gate` | 回归检测和阈值策略插件化 |
| `training/*` | data prepare、skill opt、trainer、eval runner、skill importer、monitor | `training-pipeline` | pipeline stages 注册，训练产物转 skill/plugin |
| `dreaming/*` | 从经验生成 improvement proposal | `proposal-source` | DreamingRunner 作为 proposal source 插件 |
| `proposal/*` | proposal store、rollout pipeline | `proposal-store` + `rollout-policy` | rollout 前必须走审批和测试 gate |
| `strategy/*` | strategy store、AB test、auto tuner | `strategy-engine` | 策略选择作为 flow/core 配置输入，实验结果写 audit |
| `tracking/*` | change tracker/store | `change-tracker` | 供 rollout、benchmark、training 消费 |
| `cli/*`、`runner.ts` | 命令行入口、run/repl/flow/sync/init | App host | CLI 创建 PluginHost，加载插件，构造 Core/Harness/Gateway runtime |

Harness 执行链路改造后应是：

```
HarnessRuntime.start(goal)
  -> flow-planner.plan()
  -> step-scheduler.nextBatch()
  -> agent-runner.select()
  -> agent-runner.run()
  -> flow-critic.reviewStep()
  -> approval-policy.decide()
  -> replan-strategy.replan()
  -> artifact-store.write()
  -> timeline-sink.observe()
```

### 14.5 Gateway 和 UI 当前模块清单

| 当前模块 | 当前职责 | 目标插件形态 | 接入推演 |
|----------|----------|--------------|----------|
| `gateway/src/project-registry.ts` | 根据 `.vera`/`package.json` 发现项目 | `project-detector` | 默认 detector 保留；插件可识别 mono repo、非 JS 项目、远程项目 |
| `gateway/src/capability-registry.ts` | 静态扫描 config/prompt/memory/rag/skill/plugin/mcp/channel/sandbox/flow 等 | `capability-indexer` | 每类 capability 由对应插件贡献 indexer，不再硬编码列表 |
| `gateway/src/doctor.ts` | 项目和 capability 健康检查 | `health-check` | 每个 capability 可提供 healthCheck；Doctor 只聚合 |
| `apps/gateway-ui/server/src/actions.ts` | 管理动作入口 | `admin-action` | action id -> capability action；权限检查后调用插件 |
| `apps/gateway-ui/server/src/chat-runtime.ts` | Web Chat runtime | `runtime-endpoint` | 消费 Core/Harness runtime service，不直接组装内部对象 |
| `mcp-runtime.ts`、`rag-runtime.ts` | MCP/RAG 操作后端 | `admin-action` + capability service | MCP connect/test、RAG reindex/search 走标准 action |
| `runtime-store.ts`、`operations-store.ts`、`timeline-stream.ts` | run/operation/timeline 状态读取 | `runtime-store` + `timeline-sink` | 作为 Host 管理服务；插件可贡献 timeline 事件 |
| `conversation-store.ts` | 会话读取 | `session-backend` consumer | 从 session capability 读取，避免 UI 绑定存储细节 |
| `web/src/views/*` | 项目、能力、Doctor、执行、Chat、MCP、RAG、Cost、Operations、Run tabs | 内置 `gateway-panel` | P0 先注册内置面板；P2 再考虑外部插件 UI |

Gateway 能力扫描应从当前固定列表：

```
createProjectCapabilityInventory(project)
  -> hardcoded capability("config" ...)
```

改成：

```
PluginHost.capabilityIndexers()
  -> configIndexer.index(project)
  -> promptIndexer.index(project)
  -> ragIndexer.index(project)
  -> pluginIndexer.index(project)
  -> ...
  -> CapabilityRegistry.registerMany()
```

### 14.6 Apps 和非核心业务代码

| 路径 | 判断 | 处理建议 |
|------|------|----------|
| `apps/gateway-ui/*` | Vera 管理面，属于插件系统管理入口 | 纳入 Gateway 插件化改造 |
| `apps/audio-label/*` | 独立业务应用，当前不是 Vera runtime 核心 | 不作为 P0 插件化对象；可作为未来“业务应用接入 Vera 插件 Host”的样例 |
| `packages/logger` | 日志基础设施 | Host/shared 依赖，不作为普通插件 |
| `packages/shared` | 共享类型 | 扩展 `CapabilityKind`、`CapabilityDescriptor`、Doctor 类型，为插件系统提供稳定 DTO |

### 14.7 内置插件拆分建议

初期不一定真的拆成多个 npm 包，但代码边界应按插件拆。

| 内置插件 | 包含实现 | 默认启用 |
|----------|----------|----------|
| `builtin-provider-anthropic` | Anthropic adapter、provider schema | 是 |
| `builtin-provider-openai` | OpenAI adapter、OpenAI-compatible provider schema | 是 |
| `builtin-provider-gemini` | Gemini adapter、provider schema | 是 |
| `builtin-tools-fs` | read/write/edit/list/glob/grep | 是 |
| `builtin-tools-shell` | bash | 是，但高风险策略控制 |
| `builtin-security` | path/domain/tool/readonly/budget policy | 是，且不可被禁用 |
| `builtin-analytics` | session JSONL audit、tool stats | 是 |
| `builtin-browser` | browser tool | 可选 |
| `builtin-computer-use` | desktop/computer use tools | 默认禁用 |
| `builtin-memory` | MemoryStore、memory tools、memory context | 可选 |
| `builtin-rag` | loaders、embedding、vector store、knowledge_search | 可选 |
| `builtin-mcp` | MCP discovery/client/tool bridge | 可选 |
| `builtin-storage` | local/OSS/S3/TOS object store、user data tools | 可选 |
| `builtin-sandbox` | Docker/CubeSandbox provider、sandbox tools | 可选 |
| `builtin-channels` | CLI/API/Webhook/IM adapters | 按配置启用 |
| `builtin-session` | JSONL/SQLite session backend、cost/title | 是 |
| `builtin-worktree` | git worktree isolation | 可选 |
| `builtin-harness-flow` | default planner/critic/replan/approval/artifact | 是 |
| `builtin-agent-runners` | stream/external-cli/role runners | 是 |
| `builtin-skills` | skill loader/resolver/recommender/hot reload | 可选 |
| `builtin-swarm` | scheduler/splitter/merger | 可选 |
| `builtin-eval-benchmark` | eval runners、benchmark、CI gate | 开发/CI 场景启用 |
| `builtin-training-strategy` | training、dreaming、proposal、strategy | 实验场景启用 |
| `builtin-gateway-management` | project detector、capability indexer、doctor、admin actions | Gateway 启用 |

### 14.8 端到端接入链路

插件系统要覆盖从启动到执行的完整路径：

```
CLI/Gateway 启动
  -> create PluginHost
  -> discover manifests
  -> validate apiVersion + permissions
  -> compose config schemas/defaults
  -> resolve enabled plugins
  -> activate builtins
  -> activate user/workspace/project plugins
  -> collect capabilities
  -> run health checks

Core runtime 构造
  -> resolve model-provider + llm-adapter
  -> build prompt/context/memory providers
  -> collect tools and policies
  -> create SessionManager/ToolHost/ChannelGateway

Agent turn
  -> prompt/context providers 输出候选上下文
  -> Host 按 token budget 裁剪
  -> llm:request transform/intercept
  -> LLM adapter complete/stream
  -> llm:response transform/observe
  -> tool call 进入 PolicyEngine + ToolHost
  -> session/audit/timeline observe

Harness flow
  -> flow-planner 生成 plan
  -> step scheduler dispatch
  -> agent-runner 执行
  -> flow-critic 审查
  -> approval/replan 策略决策
  -> artifact/checkpoint/timeline 写入

Gateway 管理
  -> project-detector 发现项目
  -> capability-indexer 汇总静态和运行时能力
  -> health-check 聚合状态
  -> admin-action 调用 enable/disable/reload/test/connect/reindex
```

### 14.9 每类功能的改造深度

| 功能 | P0 改造深度 | P1/P2 改造深度 |
|------|-------------|----------------|
| LLM provider | registry 化，内置和用户启用的第三方 adapter 可同进程 | 可选隔离运行第三方 provider 插件 |
| Tool | 全部通过 capability 注册，执行仍在主进程 | 可选 Worker/RPC；高风险 tool 可 sandbox |
| Security | PolicyEngine 接管最终裁决 | 细粒度 capability token 和审计回放 |
| Prompt/context | prompt block/context provider 注册 | 按 scope、intent、预算动态排序 |
| Memory/RAG | provider 化，工具按依赖启用 | 多后端、多租户、远程检索 |
| Channel | adapter capability 替代 ChannelPluginRegistry | 热插拔、独立进程 adapter |
| Harness | planner/runner/critic 先 registry 化 | 全策略插件化、远程 runner |
| Gateway | indexer/action/health 注册 | 外部 UI panel 和插件市场 |

### 14.10 Host 构造责任分界

当前实现里很多依赖通过手工参数传递：

- `createToolRegistry({ cwd, sessionStore, memoryStore, vectorStore, embeddingAdapter, llmAdapter, sandboxProvider, objectStore })`
- `HarnessRuntime(adapter, model, { agents, artifactsRootDir, checkpointsDir })`
- `ChannelPluginRegistry.registerPlugin()` / `loadAdapter()`
- Gateway `createProjectCapabilityInventory(project)` 固定扫描路径

插件化后，应用入口不再手工拼这些依赖，而是从 PluginHost 解析一组 runtime services：

| Runtime service | 当前由谁拼 | 改造后来源 | Host 是否保留最终控制 |
|-----------------|------------|------------|------------------------|
| `LlmService` | `main.ts buildAdapter()` | `llm-adapter` + `model-provider` + config | 是，负责路由、限流、审计 |
| `ToolHost` | `createToolRegistry()` | `tool` capability + `tool-policy` + audit sink | 是，负责权限、schema 过滤、执行策略 |
| `PromptComposer` | `PromptStore` + project context 拼接 | `prompt-block` + `prompt-profile` + `context-provider` | 是，负责顺序和 token budget |
| `ContextComposer` | memory/project-context/RAG 分散注入 | `context-provider` + `memory-strategy` + `rag-provider` | 是，负责裁剪和敏感信息过滤 |
| `SessionService` | `SessionStore`/`SessionManager` | `session-backend` + audit/cost/title hooks | 是，负责生命周期和一致性 |
| `ChannelService` | `ChannelGateway` + `ChannelPluginRegistry` | `channel-adapter` capability | 是，负责连接管理和消息派发 |
| `SandboxService` | tool opts 注入 `sandboxProvider` | `sandbox-provider` capability | 是，负责资源和风险控制 |
| `StorageService` | object/user-data/session 各自创建 | `storage-provider`/`object-store`/`artifact-store` | 是，负责命名空间和配额 |
| `HarnessServices` | `HarnessRuntime` 构造函数参数 | planner/runner/critic/replan/approval/artifact capabilities | 是，负责状态机和 checkpoint |
| `GatewayServices` | Gateway server 手工创建 registry/store | project detector/indexer/health/action/panel capabilities | 是，负责权限和管理 API |

建议新增两个构造层：

```ts
const host = await PluginHost.create({
  cwd,
  configFiles,
  builtinPlugins,
});

const coreRuntime = await createCoreRuntime({
  cwd,
  services: host.services.core(),
});

const harnessRuntime = await createHarnessRuntime({
  services: host.services.harness(),
});
```

这样插件只注册能力，不参与“宿主对象怎么拼装”。Host 负责把 capability 转为运行时可用 service。

### 14.11 当前代码阻断点

下面这些是从当前仓库推导出的实现阻断点，必须进入改造任务，而不能只在概念上说“registry 化”。

| 阻断点 | 当前情况 | 必须补的迁移动作 |
|--------|----------|------------------|
| LLM 构造分散 | `packages/core/src/main.ts`、`apps/gateway-ui/server/src/chat-runtime.ts`、`packages/harness/src/cli/adapter.ts` 都各自 `switch` Anthropic/OpenAI/Gemini | 先抽 `LlmService`，统一 provider/model/adapter/env key 解析；所有入口只依赖 `LlmService` |
| `AdapterType` 固定 union | `config/types.ts` 仍是 Anthropic/OpenAI/Gemini 三选一 | 改成 string capability，并用 config schema 校验具体 provider |
| Tool 单体构造 | `createToolRegistry()` 硬注册内置工具，并通过函数参数注入 memory/RAG/vision/sandbox/storage 依赖 | 引入 `ToolHost`，旧 `ToolDef` 先通过 adapter 转成 tool capability；optional dependency 由 capability dependency 解析 |
| Tool hook 语义不一致 | `ToolRegistry` 的 lifecycle hook、middleware、stats、retry/cache 混在一起，失败会直接影响主流程 | 新 EventBus 先接管 before/after/error；保留 retry/cache/stats 行为作为 Host execution policy |
| Agent loop 双路径 | `runAgent` 和 `streamAgent` 各自构造 request、调用 adapter、执行 tool、追加 result | 在两个路径都插入 `llm:*`、`tool:*`、`context:*` 事件，或抽共享 turn executor |
| Compression LLM 调用 | proactive/reactive compact 会走 adapter，但不等同普通主模型调用 | `LlmService` 要支持 purpose，如 `chat`、`routing`、`compression`、`vision`，方便审计和策略 |
| Harness 直接持有 adapter/model | `HarnessRuntime(adapter, model, ...)` 内部直接默认 `StreamAgentRunner`、调用 `planFromPrompt`/`critiquePlan` | 改为 `HarnessServices`，planner/runner/critic/replan/approval 都通过 capability selector 获取 |
| Gateway DTO 过薄 | `@open-vera/shared` 的 `CapabilityDescriptor` 只是展示 DTO，kind 粗粒度，不能承载 runtime factory | 拆 `RuntimeCapability` 和 `CapabilityDescriptor`：前者留在 runtime，后者序列化给 Gateway |
| Channel 卸载不完整 | `ChannelPluginRegistry.unloadAllByPlugin()` 只删 map，不断开连接 | 新 ChannelService 必须把 deactivate/dispose 作为强约束，测试 unload 后无连接残留 |
| REPL/subagent 工具分发 | REPL 和 skill provider 仍直接依赖 `registry.execute()` | 通过 `ToolHost.execute()` 兼容层替换，确保安全确认、ToolResult metadata 和审计不丢 |

### 14.12 Core 全功能改造推演

这一节以 `packages/core/src` 当前目录为准，推演每组功能在最终插件化方向下的落点。判断优先级：

- **Host service**：运行时主控、最终裁决、状态一致性，不交给普通插件。
- **Builtin plugin**：当前内置能力重包成插件，默认或按配置启用。
- **External capability**：允许第三方插件注册同类能力，P0 same-process，P1/P2 可隔离。
- **Contract/shared**：稳定类型、错误、DTO、工具函数，作为插件 API 或内部 contract。
- **Deferred**：实验性或内部耦合较深，先不作为 P0 插件面。

| 目录/文件组 | 当前功能 | 最终形态 | 改造方案 |
|-------------|----------|----------|----------|
| `adapters/*` | Anthropic/OpenAI/Gemini SDK 适配和 `LLMAdapter` 协议 | `LlmService` Host + builtin `llm-adapter` 插件 + external `llm-adapter` | `base.ts` 迁到 contract；三家 provider 变内置插件；所有 `new Adapter()` 入口改查 `LlmService` |
| `agent/loop.ts` | `runAgent`/`streamAgent`、turn loop、LLM 调用、tool call、compression | Host runtime | 不开放内部循环；插入 `turn:*`、`llm:*`、`tool:*`、`context:*`、`compression:*` 稳定事件；长期抽共享 turn executor |
| `agent/subagent*` | Subagent tool、定义加载、池化、共享上下文、编排 | builtin `agent-runner` + `tool` + `agent-definition-source` | subagent tool 走 `ToolHost`；定义来源注册为 capability；subagent 执行走 `AgentRunner` selector |
| `channel/*-channel.ts` | CLI/API/Webhook/IM adapter | builtin/external `channel-adapter` | 每个平台 adapter 作为 capability 注册；连接生命周期交给 `ChannelService`；第三方 channel P0 可同进程启用 |
| `channel/gateway.ts` | 多 channel 连接、消息派发、session binding | Host `ChannelService` | 保留 orchestrator；发送/接收发 `channel:*` 事件；统一 connect/disconnect/test/admin action |
| `channel/plugin-registry.ts` | Channel 专用插件注册表 | 兼容层后删除 | P0 用 adapter 转接到统一 `CapabilityRegistry`；修复 unload 必须 disconnect；迁完后移除专用 registry |
| `config/types.ts` | provider/model/routing/session/MCP 配置类型 | `ConfigComposer` + config schema capability | `AdapterType` 改 string；插件贡献 schema/defaults；resolved config 可导出审计 |
| `config/loader.ts`、`paths.ts` | 配置文件路径和加载 | Host config source | 加载留 Host；支持全局/workspace/project/env/CLI 合并；插件只能读自身 namespace |
| `config/model-tiers.ts`、`providers.ts` | 默认 provider/model、routing target 解析 | Host `ModelRegistry` + builtin router | provider/model alias 由 capability 提供；routing 使用 `LlmService` purpose 和 selector |
| `config/setup.ts`、`resource-sync.ts`、`claude-code-migration.ts` | 初始化、外部资源同步、迁移 | builtin setup/migration command | 作为 CLI/Gateway admin action 暴露；不进普通 runtime hook |
| `context/compression.ts`、`idle-compression.ts` | progressive/reactive/micro compact | Host budget + builtin `compression-strategy` | Host 保留 token budget 和最终裁剪；策略实现可替换；compression LLM 调用走 `LlmService(purpose: compression)` |
| `context/tokens.ts`、`window.ts`、`tool-budget.ts` | token 估算、窗口裁剪、tool result 预算 | Host policy + optional estimator capability | P0 保持内置；可开放 `token-estimator`，但裁剪最终决策留 Host |
| `intent/*` | 意图分类和模型路由 | builtin/external `intent-router` | 分类器变 capability；router 只返回建议，Host 决定最终 model/provider |
| `loaders/*` | text/markdown/typescript loader、chunk、batch indexer | `document-loader` + `indexer` capability | loader 按扩展名注册；BatchIndexer 从 registry 选择 loader；第三方可加语言 loader |
| `mcp/client.ts`、`discovery.ts` | MCP server 连接和发现 | builtin/external `mcp-transport` + `mcp-server` | server 配置由 config/plugin 贡献；连接生命周期由 Host 管；MCP auth/health 进 Gateway |
| `mcp/registry.ts` | MCP tool 映射为 Vera tool | builtin `tool-bridge` | 每个 MCP tool 产出 tool capability，owner 指向 server；权限按 server/tool 双层裁决 |
| `memory/*` | 记忆扫描、检测、store、merge、topic、tracker/updater | builtin/external `memory-store`、`memory-strategy`、`context-provider` | Store/provider/strategy 拆分；注入走 `ContextComposer`；写入工具走 `ToolHost` |
| `network/*` | message bus、scheduler、shared memory | Deferred 或 `agent-network` | 当前更像实验性内部多 Agent 基础设施，P0 只保持库能力；等 swarm/runtime 稳定后再开放 |
| `plan/*` | plan generation、REPL plan runner | builtin `flow-planner` bridge + app command | 简单计划生成迁入 Harness planner capability；REPL plan executor 走 HarnessServices |
| `project-context/*` | CLAUDE.md、项目规则加载 | builtin `context-provider` | project rules 作为 context block；读取路径受 Host path policy 约束；支持第三方 project detector/context source |
| `prompt/*` | 内置 prompt、模板加载、渲染、PromptStore | `PromptComposer` Host + builtin/external `prompt-block`/`prompt-profile` | 模板来源 capability 化；Host 负责排序、intent scope、token budget 和最终 system prompt |
| `rag/*` | document loader、embedding、vector store、incremental indexer、retriever | builtin/external `rag-provider`、`embedding-provider`、`vector-store`、`indexer` | RAG 分层注册；`knowledge_search` 只消费 retriever capability；Gateway action 触发 reindex/test |
| `repl/commands/*` | slash commands：model/provider/session/branch/try/transcript 等 | App host + `repl-command` capability | REPL 本体保留 app；命令注册开放；高风险命令如 worktree/merge 走 Host approval |
| `repl/ui/*` | Ink UI、状态、controller、tool projection | App host，不作为普通插件 | P0 不开放 UI 插件；只允许 command/status/panel 数据贡献；Gateway UI panel 另行处理 |
| `repl/ui/hooks/useToolCallHandler.ts` | REPL tool/subagent/ask-user 分发 | `ToolHost` integration | registry 直接调用替换为 `ToolHost.execute()`；保留 `needsConfirm`、metadata、stream output |
| `sandbox/*` | Docker/CubeSandbox provider | builtin/external `sandbox-provider` | provider 注册 capability；Host 管资源、路径、网络、配额、cleanup；sandbox tools 消费 provider |
| `session/*` | JSONL/SQLite backend、manager、branch/fork/list、title/cost | Host `SessionService` + `session-backend` capability + audit sink | Session lifecycle 留 Host；backend 可替换；title/cost 作为 observe/strategy；schema 保持稳定 |
| `skill-evolution/*` | skill 反思、过滤、自动创建、版本 | builtin `skill-authoring` / `proposal-source` | 与 Harness skill/proposal 合并；训练/评估产物可生成 skill 或 plugin scaffold |
| `storage/*` | object store、S3/OSS/TOS/local、user data、artifact/content uploader、export/filter | `StorageService` Host + storage/object/artifact capability | 存储后端插件化；Host 管 namespace、配额、secret、路径；user-data tools 走 ToolHost |
| `tools/*` | read/write/edit/bash/browser/desktop/memory/RAG/sandbox/storage/ask-user 等工具 | builtin/external `tool` capability + Host `ToolHost` | 所有工具注册为 capability；Security/Analytics 迁 policy/audit；P0 第三方 tool 可用但视为用户信任代码 |
| `tools/registry.ts`、`types.ts`、`executor.ts`、`tool-stats.ts` | 注册、执行、hook、middleware、timeout、stats、ToolDef/ToolResult | Host `ToolHost` + compatibility adapter | 保留旧行为作为兼容层；EventBus 接管 hook；retry/cache/stats 变 execution policy |
| `tools/utils/*`、`utils/*`、`errors.ts`、`types/*` | 路径、截断、diff、git diff、错误、消息/模型/runtime 类型 | Contract/shared | 稳定 DTO 迁到 `@open-vera/shared` 或 `plugin-runtime/contracts`；内部工具不做插件 |
| `main.ts`、`index.ts` | Core CLI 入口、库导出 | App host / side-effect-free export | `main.ts` 启动逻辑迁到 `@open-vera/openvera` CLI；Core 只导出 runtime builder 和 contracts |
| `worktree/index.ts` | git worktree 隔离、合并、删除 | builtin `workspace-provider` / `isolation-provider` | 给 REPL `/try`、subagent、swarm 共用；git destructive action 必须走 approval policy |

Core 改造切入顺序：

1. 先建 `LlmService` 和 `ToolHost` 兼容层，替换所有入口直接 `buildAdapter()` / `registry.execute()`。
2. 再把内置 adapter/tool/channel/sandbox/storage/RAG/memory 注册改成 builtin plugins。
3. 然后在 `agent/loop.ts` 两条路径补齐事件，不把内部函数暴露给插件。
4. 最后处理 REPL/UI、skill-evolution、network 等边缘能力，避免先改 UI 造成主链路不稳。

### 14.13 Harness 全功能改造推演

这一节以 `packages/harness/src` 当前目录为准，推演 Harness 所有功能如何接入最终插件系统。

| 目录/文件组 | 当前功能 | 最终形态 | 改造方案 |
|-------------|----------|----------|----------|
| `agent/types.ts` | `AgentRunner`、capabilities、readiness、registry | `agent-runner` contract | 作为插件 contract 提升到 runtime contracts；补 priority/scope/owner/fallback metadata |
| `agent/stream-runner.ts` | 默认 Core streamAgent runner | builtin `agent-runner` | 依赖 `LlmService`、`ToolHost`、`PromptComposer`，不能直接持有裸 adapter/model |
| `agent/external-cli-runner.ts` | 外部 CLI agent | external/builtin `agent-runner` | process 权限、命令 allowlist、cwd/worktree 隔离由 PolicyEngine 管 |
| `agent/role-runners.ts` | pm/architect/engineer/tester/reviewer 角色 runner | `agent-runner` preset + `prompt-profile` | 角色拆成 prompt profile + runner preset；第三方可注册新角色 |
| `agent/critique-runner.ts`、`critic/*` | critique 专用 agent 和批判逻辑 | `flow-critic` capability | critique prompt/judge 可替换；结果必须归一化为 Host contract |
| `runtime/runtime.ts` | Flow 主状态机、planner、dispatch、agent run、critique、replan、checkpoint | Host `HarnessRuntime` | 状态机保留 Host；planner/runner/critic/replan/approval/artifact/checkpoint 都从 services 获取 |
| `runtime/flow-state.ts`、`flow.ts`、`internal.ts` | Flow 状态、结构、内部运行参数 | Host contract | 不开放普通插件修改状态机；只通过 event 和 strategy 接口影响决策 |
| `runtime/planner.ts`、`plan-parser.ts`、`json.ts` | goal -> plan、解析 JSON/Markdown | builtin/external `flow-planner` + `plan-parser` | 默认 planner 内置；第三方按 domain/tags 注册；parser 作为 loader/source 能力 |
| `runtime/critique.ts`、`failure-attributor.ts` | plan/step critique、失败归因、replan 输入 | builtin/external `flow-critic`、`failure-attributor` | Host 调用多个 critic/attributor 后合并；高风险 replan 走 approval |
| `runtime/approval.ts` | ApprovalRecord、人审/自动审批 | Host approval gate + `approval-policy` capability | 插件可建议 approve/reject/ask_human；Host 对高风险 fail-closed |
| `runtime/artifacts.ts`、`checkpoint-store.ts`、`timeline.ts` | artifact、checkpoint、timeline 持久化 | Host service + `artifact-store`、`checkpoint-store`、`timeline-sink` | 默认本地 FS 内置；可替换云端/DB；timeline observe 供 Gateway |
| `runtime/output-truncator.ts` | 输出截断 | Host budget policy + output transform | 截断最终裁决留 Host；插件可提供 formatter/summary transform |
| `flow/self-loop.ts` | 自循环 critique/replan/停止条件 | builtin/external `self-loop-policy` | stop condition、duplicate critique、budget、max cycles 可策略化 |
| `flow-config/*` | Markdown/YAML flow config 解析 | `flow-source` / `flow-template-loader` capability | `.md/.yaml` loader 内置；第三方可提供企业模板/远程 flow source |
| `skill/*` | skill loader/resolver/recommender/hot reload/version/registry provider/auto extract | `skill-source`、`skill-resolver`、`skill-recommender`、`skill-authoring` | skill 目录变插件来源之一；Skill 可编译为 prompt/context/tool capability；hot reload 走 PluginHost |
| `swarm/*` | task splitter、scheduler、result merger、types | Host swarm orchestrator + `task-splitter`、`swarm-scheduler`、`result-merger` | Host 管并发、隔离、资源；策略插件只决定拆分、调度建议、合并方式 |
| `eval/*` | EvalHarness、GAIA/SWE/WebArena/ToolBench runners、reporter | `eval-runner`、`eval-case-source`、`eval-reporter` | 每个 benchmark runner 变插件；case source 可本地/远程；报告输出可扩展 |
| `benchmark/*` | benchmark harness、CI gate、regression detector、GAIA runner、reporter | `benchmark-suite`、`quality-gate`、`regression-detector` | CI gate 和阈值策略插件化；结果写 audit/timeline；P0 内置测试保持 |
| `training/*`、`training/webui/*` | data prepare、trainer、skill import、skill opt、eval runner、monitor UI | `training-pipeline`、`trainer`、`training-monitor-panel` | pipeline stage 注册；训练产物转 skill/plugin/proposal；Web UI 先作为 Gateway panel 内置 |
| `dreaming/*` | 从历史经验生成 improvement proposal、scheduler | `proposal-source` + scheduled job | DreamingRunner 作为 proposal source；调度由 Host 控制频率、预算、权限 |
| `proposal/*` | proposal store、rollout pipeline | `proposal-store`、`rollout-policy` | rollout 前必须过 benchmark/approval；proposal 可来自 dreaming/training/manual |
| `strategy/*` | strategy store、AB test、auto tuner | `strategy-engine`、`experiment-runner` | 策略选择作为 Core/Harness config 输入；实验结果写 audit 和 cost |
| `tracking/*` | change tracker/store | `change-tracker` capability | 供 rollout、benchmark、training、swarm 消费；Host 控制 repo path 和 git 权限 |
| `cli/*` | openvera CLI、flow/repl/init/sync、adapter 构造 | App host | CLI 创建 PluginHost 和 runtime services；不直接 new adapter/registry/runtime |
| `runner.ts`、`evaluator.ts` | 简易 runner/evaluator facade | compatibility facade | 改为调用 HarnessServices；保留旧 API 一段时间用于测试和外部调用 |
| `index.ts`、`types.ts` | 包导出和公共类型 | Contract/export surface | 只导出稳定 contracts、runtime builder、capability 类型；内部模块减少直接暴露 |

Harness 改造切入顺序：

1. 抽 `HarnessServices`，先让 `HarnessRuntime` 从 services 获取 `LlmService`、planner、runner、critic、artifact store。
2. 把 `AgentRunnerRegistry` 升级为 capability selector，支持 scope、priority、readiness、tags、fallback。
3. 把 planner/critic/replan/approval/artifact/checkpoint 逐个改成 capability，但 Flow 状态机仍留 Host。
4. 再改 skill/swarm/eval/benchmark/training/proposal/strategy，这些功能都消费同一套 timeline/audit/cost 服务。
5. 最后收敛 CLI，所有命令从 PluginHost 构造 runtime，第三方插件从 P0 就可被用户启用。

### 14.14 Core/Harness 能力依赖图

最终运行时建议按下面的依赖方向拼装，避免插件直接穿透内部模块：

```
PluginHost
  -> ConfigComposer
  -> CapabilityRegistry
  -> PolicyEngine
  -> LlmService
  -> ToolHost
  -> PromptComposer / ContextComposer
  -> SessionService / StorageService / ChannelService / SandboxService
  -> CoreAgentRuntime
  -> HarnessServices
  -> HarnessRuntime
```

关键约束：

- Core Agent 只知道 `LlmService`、`ToolHost`、prompt/context/session 服务，不知道具体 provider/tool/plugin。
- Harness 只知道 planner/runner/critic/approval/artifact/checkpoint selector，不知道具体实现来自内置还是第三方插件。
- 第三方插件 P0 可注册任意公开 capability；Host 对通过服务层的调用做策略、审计和冲突处理。
- 内部类型向插件暴露前必须进入 contracts；不能让插件 import `loop.ts`、`runtime.ts`、`registry.ts` 的私有函数。

### 14.15 示例：当前实现如何重包成插件

文件工具内置插件：

```ts
export default definePlugin({
  activate(ctx) {
    ctx.provide.tool(readFileTool);
    ctx.provide.tool(writeFileTool);
    ctx.provide.tool(editFileTool);
    ctx.provide.tool(listDirTool);
    ctx.provide.tool(globTool);
    ctx.provide.tool(grepTool);
  },
});
```

Provider 内置插件：

```ts
export default definePlugin({
  activate(ctx) {
    ctx.provide.configSchema("providers.anthropic", anthropicProviderSchema);
    ctx.provide.llmAdapter("anthropic", ({ apiKey, baseUrl, headers }) => {
      return new AnthropicAdapter(apiKey, baseUrl, headers);
    });
  },
});
```

MCP 插件：

```ts
export default definePlugin({
  async activate(ctx) {
    const servers = ctx.config.get<Record<string, McpServerConfig>>("servers");
    const client = new McpClient();

    for (const [serverId, config] of Object.entries(servers)) {
      const server = await ctx.provide.mcpServer(serverId, { client, config });
      const tools = await server.listTools();
      for (const tool of tools) {
        ctx.provide.tool(convertMcpTool(serverId, tool, client));
      }
    }

    ctx.disposables.add(() => client.disconnectAll());
  },
});
```

Harness planner 插件：

```ts
export default definePlugin({
  activate(ctx) {
    ctx.provide.flowPlanner("default", {
      async plan(input, services) {
        return planFromPrompt(input.goal, services.llm.adapter, {
          model: services.llm.model,
        });
      },
    });
  },
});
```

Gateway indexer 插件：

```ts
export default definePlugin({
  activate(ctx) {
    ctx.provide.capabilityIndexer("rag", {
      async index(project) {
        return [{
          kind: "rag",
          name: "RAG index",
          source: join(project.rootDir, ".vera/rag"),
          actions: ["view", "reindex", "test"],
        }];
      },
    });
  },
});
```

## 15. 改造路线

### Phase 0：插件运行时骨架

新增：

```
packages/plugin-runtime/
  src/manifest.ts
  src/plugin-host.ts
  src/plugin-loader.ts
  src/event-bus.ts
  src/capability-registry.ts
  src/policy-engine.ts
  src/config-composer.ts
  src/context.ts
```

改造：

- 支持加载用户显式启用的本地/用户/npm/workspace 第三方插件，P0 同进程执行。
- 生成并维护插件 lockfile，记录来源、版本、checksum、启用状态和批准权限。
- Runtime capability 与 Gateway descriptor 分层：runtime 保存 factory，Gateway 只拿可序列化 DTO。
- EventBus 实现 hook 顺序、glob、timeout、critical fail-open/fail-closed。
- `ctx.disposables` 成为 activate/deactivate 的强制资源清理入口。

验收：

- 可以加载一个本地插件。
- 可以加载用户显式启用的第三方插件，并在 CLI/Gateway 展示“同进程信任代码”提示。
- 插件可以注册 capability。
- hook 支持 intercept/transform/observe。
- 插件 activate/deactivate 可清理资源。
- Gateway 能看到插件状态。
- lockfile 能记录插件来源、checksum、启用状态和权限声明。

### Phase 0.5：Runtime service 收敛

改造：

- 抽 `LlmService`：替换 Core CLI、Gateway Chat、Harness CLI 中分散的 `buildAdapter()`。
- 抽 `ToolHost`：先兼容现有 `ToolRegistry`，统一工具 schema、execute、确认、审计入口。
- 抽 `PromptComposer` / `ContextComposer`：把 PromptStore、project context、memory/RAG 注入收敛到服务层。
- 抽 `HarnessServices` / `GatewayServices`：应用入口通过 `PluginHost.services.*()` 获取运行时服务。

验收：

- 新 provider 插件只改注册，不改 Core/Gateway/Harness 入口代码。
- 旧内置工具仍能通过 `ToolHost.execute()` 完整保留 `needsConfirm`、metadata、retry/cache/stats。
- Gateway Chat 和 Harness CLI 不再直接 import Anthropic/OpenAI/Gemini adapter。
- `RuntimeCapability` 不会被直接序列化给前端，Gateway 只暴露 descriptor。

### Phase 1：Tool 和 Channel 收敛

改造：

- `ToolRegistry.use()` 和 middleware 改接统一 EventBus。
- 内置 tools 通过内置插件注册。
- `SecurityPlugin`、`AnalyticsPlugin` 迁为内置插件/策略模块。
- `ChannelPluginRegistry` 删除或变薄，Channel adapter 走 CapabilityRegistry。
- 第三方 tool P0 同进程执行；Host 仍对通过 `ToolHost` 的调用做权限、schema 过滤、确认、审计。
- Channel unload/deactivate 必须断开连接并清理 watcher/timer。

验收：

- 内置 tool 行为不变。
- 第三方插件能注册新 tool。
- 同名 tool 冲突能被拒绝或显式 override。
- Channel adapter 可启停。
- `observe` hook 失败不影响主流程，`intercept/transform` 按 critical 策略处理。
- 卸载 Channel 插件后旧连接不残留。

### Phase 2：LLM Provider、配置、Prompt

改造：

- `AdapterType` 从 union 改为 string capability。
- `buildAdapter(provider, model)` 改为 adapter registry 查找。
- Prompt template/project context/memory injection 接入 capability 和 transform hook。
- 配置 schema 由插件贡献，最终统一校验。
- `LlmService` 标记调用 purpose：`chat`、`routing`、`compression`、`vision`、`tool`。
- `llm:request` / `llm:response` / `llm:error` 覆盖 streaming、non-streaming、compression、routing 调用。

验收：

- 新 provider 不需要改 Core 源码。
- model alias 可由插件注册。
- prompt block 可按项目启停。
- reactive/proactive compression 使用的 LLM 调用也能被审计和限流。
- Core CLI、Gateway Chat、Harness CLI 都走同一套 provider 解析。

### Phase 3：Harness 策略插件化

改造：

- planner、critic、replan、approval、agent runner 全部 registry 化。
- Flow runtime 只依赖策略接口，不直接 new 具体实现。
- Self-loop decision 和 Swarm sandbox provider 接入插件能力。
- `HarnessRuntime` 不再直接持有裸 `adapter/model`，改用 `HarnessServices` 和 selector。
- runner/planner/critic 的冲突、fallback、readiness 和标签匹配规则进入 capability metadata。

验收：

- 可以用插件替换 planner。
- 可以用插件新增 agent runner。
- critique decision 可被策略插件覆盖或约束。
- 默认 StreamAgentRunner 仍可作为内置 runner 运行原有测试。
- 插件 runner 不得直接绕过 Host 的 tool/policy 服务。

### Phase 4：Gateway 管理面

改造：

- CapabilityRegistry 合并插件静态贡献和运行时状态。
- 增加 enable/disable/reload/test/admin action。
- 插件权限审批和健康检查 UI。

验收：

- Gateway 展示插件、capability、权限、健康状态。
- 能从 UI 启停插件或触发 reload/test。

### Phase 5：隔离和热重载

改造：

- same-process 继续保留给内置插件和用户选择信任的第三方插件。
- 提供 Worker/child process 模式供用户或企业策略选择，而不是阻断第三方插件使用。
- Hook/capability 通过 RPC 调用。
- 支持真正 unload、reload、kill、resource limit。

验收：

- 插件崩溃不导致主进程崩溃。
- reload 后旧定时器/连接不残留。
- 权限代理生效。
- 同一个第三方插件可在 P0 same-process 和 P1 isolated 两种模式下运行，manifest/API 不变。

## 16. 最小 P0 API 草案

```ts
export interface VeraPlugin {
  activate(ctx: PluginContext): Promise<void> | void;
  deactivate?(ctx: PluginContext): Promise<void> | void;
}

export function definePlugin(plugin: VeraPlugin): VeraPlugin {
  return plugin;
}

export interface CapabilityProvider {
  configSchema(path: string, schema: JsonSchema): Disposable;
  tool(def: ToolDef): Disposable;
  llmAdapter(name: string, factory: LlmAdapterFactory): Disposable;
  modelProvider(name: string, provider: ModelProviderFactory): Disposable;
  promptBlock(name: string, block: PromptBlockProvider): Disposable;
  contextProvider(name: string, provider: ContextProvider): Disposable;
  memoryStrategy(name: string, strategy: MemoryStrategy): Disposable;
  channel(type: string, factory: ChannelAdapterFactory): Disposable;
  mcpServer(name: string, server: McpServerProvider): Disposable;
  sandboxProvider(name: string, provider: SandboxProvider): Disposable;
  storageProvider(name: string, provider: StorageProvider): Disposable;
  agentRunner(name: string, runner: AgentRunner): Disposable;
  flowPlanner(name: string, planner: FlowPlanner): Disposable;
  flowCritic(name: string, critic: FlowCritic): Disposable;
  approvalPolicy(name: string, policy: ApprovalPolicy): Disposable;
  capabilityIndexer(kind: string, indexer: CapabilityIndexer): Disposable;
  adminAction(name: string, action: AdminAction): Disposable;
}

export interface EventBus {
  intercept<K extends keyof EventMap>(
    event: K,
    value: EventMap[K]["value"],
    ctx: RuntimeEventContext,
  ): Promise<InterceptResult<EventMap[K]["result"]>>;

  transform<K extends keyof EventMap>(
    event: K,
    value: EventMap[K]["value"],
    ctx: RuntimeEventContext,
  ): Promise<EventMap[K]["value"]>;

  observe<K extends keyof EventMap>(
    event: K,
    value: EventMap[K]["value"],
    ctx: RuntimeEventContext,
  ): Promise<void>;
}
```

## 17. 当前方案遗漏清单

原生命周期梳理有价值，但需要补齐以下内容才可进入实现：

- [ ] 插件 manifest 和 lockfile。
- [ ] 插件来源、安装、启用、激活、禁用、卸载状态机；P0 允许用户显式启用第三方插件。
- [ ] P0 第三方插件风险提示和审计：同进程执行是用户信任代码，不承诺强沙箱。
- [ ] Runtime capability 与 Gateway descriptor 分层，避免把 factory/内部对象暴露给 UI/API。
- [ ] 能力注册模型，避免所有扩展都依赖 hook。
- [ ] 冲突解决和排序规则。
- [ ] 权限模型、secret broker、路径/网络/process 代理；P0 是受控 API 层约束，P1/P2 才是强制隔离。
- [ ] 插件隔离策略，同进程是 P0 默认模式，Worker/child process 是可选增强。
- [ ] ESM 热重载限制和 Worker/child process 方案。
- [ ] 配置 schema、默认值、合并顺序和校验。
- [ ] 失败策略、timeout、circuit breaker、quarantine。
- [ ] 健康检查、指标、审计日志。
- [ ] Gateway 管理面和 admin action。
- [ ] 测试策略：contract tests、fixture plugins、fault injection。
- [ ] 现有 Core/Harness/Gateway 模块逐项映射到 capability kind 和内置插件拆分。
- [ ] 入口收敛：Core CLI、Gateway Chat、Harness CLI 都必须通过 `LlmService` / `ToolHost` / runtime services。
- [ ] Agent loop 双路径事件覆盖：`runAgent`、`streamAgent`、compression、routing、tool result 都不能漏。
- [ ] Harness selector/fallback/readiness 规则，避免 planner/runner/critic 只停在接口定义。
- [ ] 迁移路线：Plugin runtime -> Runtime services -> Tool/Channel -> LLM/Prompt -> Harness -> Gateway -> Isolation。

## 18. 测试策略

必须为插件系统单独建 contract test，而不只测具体插件。

| 测试 | 覆盖 |
|------|------|
| manifest validation | 缺字段、权限声明、apiVersion 不兼容 |
| third-party P0 loading | 用户显式启用的本地/用户/npm/workspace 插件可加载，CLI/Gateway 显示同进程信任风险 |
| lockfile | 来源、版本、checksum、启用状态、批准权限可记录和复现 |
| capability registration | 注册、冲突、override、禁用 |
| descriptor serialization | Runtime capability 的 factory 不会泄漏到 Gateway DTO |
| hook ordering | scope、priority、pre/post、glob |
| policy enforcement | fs/network/env/secrets/tools 权限 |
| failure injection | hook 抛错、超时、activate 失败、deactivate 超时 |
| reload | dispose 是否调用、旧 capability 是否移除、Channel/worker/timer 是否残留 |
| replay/audit | 事件 payload 可序列化，traceId 完整 |
| LLM service integration | Core CLI、Gateway Chat、Harness CLI 统一走 adapter registry |
| tool host compatibility | 旧 `ToolDef` 经兼容层保留 `needsConfirm`、metadata、retry/cache/stats |
| agent loop events | streaming/non-streaming/compression/routing/tool result 都触发正确事件 |
| harness capability selection | planner/runner/critic fallback、readiness、标签匹配可测 |
| integration fixture | 示例插件注册 tool/channel/adapter/flow planner/admin action |

## 19. 结论

这次重构建议直接把“插件系统”提升为 Vera 的横切运行时，而不是 Core 里的一个 registry。最终形态应该是：

- Core/Harness/Gateway 都通过同一套 PluginHost 接入扩展。
- 插件主要贡献 capability，hook 只处理横切拦截和变换。
- 安全、权限、冲突、失败、可观测性从第一版就纳入设计。
- 不兼容旧 API，可以把现有内置 tool、adapter、channel、安全/审计模块全部重包成内置插件。
- 第三方插件从 P0 就允许用户显式启用；P0 是信任执行和审计，不是强沙箱。后续 P1/P2 提供隔离模式给需要的人使用。

这样改造成本较高，但方向正确；如果继续沿用当前零散 hook/registry，会很快变成多个互不兼容的小插件系统。

# Vera 插件生命周期

> 梳理 Vera 运行时实际存在的生命周期节点，作为插件系统 hook 设计的依据。

## 概览：三大运行时层级

```
Gateway   ── 启停、项目发现、能力注册
Harness   ── Flow 编排、Critique、Replan、Swarm
Core      ── Agent 循环、工具执行、Channel、Session
```

---

## 一、Core 层

### 1.1 启动流程 (main.ts)

```
loadConfig()                     ← config 加载
  ├─ isConfigEmpty? → 向导      ← 首次运行
  └─ 正常加载
buildAdapter(provider, model)    ← switch: anthropic/openai/gemini
resolveDefaultTarget()
loadTemplates()                  ← prompt 模板
intentRouting?                   ← 可选：单次 intent 分类
  ├─ resolveModel()
  └─ 失败回退 default
↓
单次模式 / REPL 模式分流
```

**插件可挂点**：

| 节点 | 类型 | 说明 |
|---|---|---|
| config 加载后 | `transform` | 修改/注入配置（模型、provider、路径） |
| buildAdapter | `intercept` | 替换 adapter 工厂，消除 switch |
| 模板加载后 | `transform` | 注入自定义 prompt 模板 |
| intent routing | `intercept` | 自定义路由逻辑 |
| 模式分流 | `observe` | 知道进了单次还是 REPL |

### 1.2 Agent 循环 (loop.ts)

这是最核心的运行时，每轮 turn 的完整管线：

```
一轮 turn 的完整顺序：

proactiveCompress()              ← OC1: insert-then-compress / LLM压缩
  └─ onCompression hook
selectAndRecordMemories()        ← 选择+注入记忆
  └─ onMemorySelected callback
reapplyReplacements()            ← 预算裁剪
enforcePerTurnBudget()
microCompact()                   ← 微压缩
trimToWindow()                   ← 滑动窗口
injectMemoryContext()            ← 注入 <dynamic-memory-context>
onTurnStart hook                 ← 通知：新一轮开始
────────────────────────────────────────
API call (adapter.complete)      ← LLM 调用
  └─ reactive compact            ← prompt 太长时触发
     └─ onRetry hook
────────────────────────────────────────
handleToolCalls()                ← 解析工具调用
  for each tool_call:
    parse args                   ← JSON 解析（可能失败 → 错误注入）
    onToolCall callback          ← 执行前回调
    toolRegistry.execute()       ← 实际执行（见 1.3）
    processToolResult()          ← 结果→消息，预算扣减
onTurnEnd hook                   ← 通知：本轮结束
────────────────────────────────────────
empty assistant retry?           ← 空响应重试（最多3次）
OC1 resolve?                     ← 单 API 压缩
再次循环 / 终止
```

**插件可挂点**：

| 节点 | 类型 | 说明 |
|---|---|---|
| 压缩前/后 | `observe` | 知道压缩发生了 |
| 记忆选择 | `transform` | 自定义记忆选择策略 |
| 窗口裁剪 | `observe` | 知道哪些消息被裁掉了 |
| turn 开始 | `observe` | 审计、日志 |
| LLM 请求前 | `intercept` | 修改消息、换模型、加 header |
| LLM 请求前 | `transform` | 修改 system prompt / user message |
| LLM 响应后 | `transform` | 后处理响应内容 |
| LLM 响应后 | `observe` | 记录 token 用量 |
| tool 调用解析失败 | `intercept` | 恢复畸形的 tool call |
| tool 调用前 | `intercept` | 拦截特定工具、替换参数 |
| tool 调用后 | `transform` | 修改工具返回结果 |
| turn 结束 | `observe` | 统计、审计 |
| 空响应重试 | `observe` | 知道 agent "卡住"了 |
| 重试/错误 | `observe` | 知道发生了错误 |

### 1.3 工具执行 (registry.ts)

```
registry.execute(toolName, args, ctx)
  ├─ 查找工具                     ← unknown tool → errorResult
  ├─ dryRun 检查                  ← 模拟模式短路
  ├─ 弃用警告                     ← deprecated tool
  ├─ 生命周期钩子 onBeforeToolCall ← 任意 hook 可返回 ToolResult 短路
  ├─ 中间件 before                 ← 每个 mw 可改 args 或 skip
  ├─ 幂等缓存检查                  ← 命中 → 直接返回缓存结果
  ├─ 重试循环 (最多3次)            ← 超时、退避
  │    ├─ executeWithTimeout
  │    └─ mw.onError              ← 中间件可恢复错误
  ├─ 中间件 after                  ← 每个 mw 可转换结果
  ├─ 生命周期钩子 onAfterToolCall  ← 通知：执行完成
  ├─ 幂等缓存写入                  ← idempotent 工具缓存结果
  └─ 统计记录                      ← fire-and-forget
```

**现有内置 Hook 实例**：
- `SecurityPlugin` — deny/allow list、readonly 模式、预算、路径边界、域名白名单、注入检测、危险命令确认
- `AnalyticsPlugin` — 记录 tool_call 和 tool_result 到 JSONL

**插件可挂点**（tool 是 hook 最密集的地方）：

| 节点 | 类型 | 说明 |
|---|---|---|
| 执行前 | `intercept` | 安全策略、权限检查、短路拒绝 |
| 执行前 | `transform` | 修改参数（脱敏、路径标准化） |
| 执行后 | `transform` | 修改结果（格式化、截断、翻译） |
| 执行后 | `observe` | 记录日志、统计 |
| 错误时 | `intercept` | 错误恢复、降级处理 |

### 1.4 Channel 生命周期 (channel/)

**ChannelGateway 事件**：

```
adapter added
  → connect()
    → channel_connected
    → message_received    ← 收到消息
    → message_sent        ← 发出消息
    → channel_error
    → channel_disconnected
    → reconnecting        ← 自动重连
  → disconnect()
adapter removed
```

**ChannelPluginRegistry 生命周期**：

```
registerPlugin()    → 插件注册
loadAdapter()       → 创建适配器实例
unloadAdapter()     → 断开连接 + 移除
unregisterPlugin()  → 卸载全部适配器 + 移除插件
```

**插件可挂点**：

| 节点 | 类型 | 说明 |
|---|---|---|
| 消息接收 | `intercept` | 过滤/阻断消息 |
| 消息接收 | `transform` | 预处理消息内容 |
| 消息发送 | `transform` | 后处理回复内容 |
| 连接状态变化 | `observe` | 监控通道健康 |
| adapter 创建 | `intercept` | 替换 adapter 实现 |

### 1.5 Session 生命周期 (session/)

```
session:create          写入 session_start (model, provider, cwd)
  ├─ user message       写入 user 条目
  ├─ assistant response 写入 assistant 条目 (+ usage, model)
  ├─ tool_call          写入 tool_call 条目 (+ tool name, args)
  ├─ tool_result        写入 tool_result 条目
  └─ session:end        写入 session_end (+ total usage, cost, turn count)

辅助操作:
  session:fork       分叉会话
  session:branch     创建分支
  session:merge      合并会话
  session:cleanup    TTL 过期清理
  autoCompress       SS1: 超阈值自动压缩
```

**插件可挂点**：

| 节点 | 类型 | 说明 |
|---|---|---|
| 创建 | `observe` | 知道新会话开始了 |
| 每条 JSONL 写入 | `observe` | 全量审计 |
| 分叉 | `intercept` | 自定义分叉逻辑 |
| 压缩 | `transform` | 自定义压缩策略 |
| 结束 | `observe` | 成本统计、通知 |

---

## 二、Harness 层

### 2.1 Flow 状态机

```
intaking → planning → dispatching → executing → critiquing
                ↑           ↑  ↓           ↓
                │      replanning  waiting_tool
                │           │           ↓
                │           │     waiting_approval
                │           │           ↓
                │           └────── paused
                │                       ↓
                ├───────────────────────┘
                ↓
          completed / failed (终态)
```

**11 个状态，约 20 条合法转换**，见 `flow-state.ts:5-17`。

### 2.2 Flow 编排循环 (runtime.ts)

```
planAndStart(goal)                       ← 从自然语言生成 plan
  → startFlow(input)                     ← 创建 TaskFlow + artifact store
    └─ runFlowLoop()
      loop:
        ├─ 找下一个待执行 step           ← 按依赖图拓扑排序
        ├─ 并行批次 dispatch             ← 最多 maxParallel 个 step
        │    └─ dispatchStep()
        │         └─ runAgentAssignment() ← 分配 agent runner 执行
        │              └─ agent.run()     ← 实际执行（内部是 core 的 agent 循环）
        ├─ runStepCritique()              ← LLM 评审 step 结果
        │    ├─ complete     → 标记完成，retrospective，继续
        │    ├─ ask_human    → [waiting_approval] → checkpoint → 暂停
        │    ├─ replan       → [replanning] → replanFlow() → 修改 plan
        │    └─ retry        → 重置 step 状态，重试
        │
        └─ 无待执行 step → completeFlow()
```

**决策分叉点（最值得挂 hook 的地方）**：

| 节点 | 状态转换 | 插件能力 |
|---|---|---|
| plan 生成 | intaking→planning | `intercept` 替换 plan 生成器 |
| step 分配 | dispatching→executing | `intercept` 选择 agent runner |
| agent 执行完成 | executing→critiquing | `transform` 修改 step 输出 |
| critique 判定 | critiquing→complete/replan/retry/ask_human | `intercept` 覆盖 LLM 判定 |
| replan | replanning→dispatching | `intercept` 审查 plan 变更 |
| human approval | waiting_approval→dispatching | `intercept` 自动审批 |
| 完成 | →completed | `observe` 通知 |

### 2.3 Self-Loop (self-loop.ts)

```
run(handle)
  cycle loop:
    ├─ runFlowLoop()              ← 执行一轮 flow
    ├─ cycleCritique()            ← LLM 评审整体结果
    ├─ evaluateDecision()         ← 决策树
    │    ├─ high_confidence?      → stop
    │    ├─ max_cycles?           → stop
    │    ├─ budget_exceeded?      → stop
    │    ├─ duplicate_critique?   → stop
    │    ├─ critique 建议 replan  → replan
    │    └─ otherwise             → continue
    └─ replanForNextCycle()       ← 修改 plan 再跑
```

**插件可挂点**：

| 节点 | 类型 | 说明 |
|---|---|---|
| 每周期开始/结束 | `observe` | 进度监控 |
| cycle critique | `intercept` | 替换评审逻辑 |
| 决策 | `intercept` | 自定义终止条件 |
| replan | `transform` | 修改新 plan |

### 2.4 Agent Runner (agent/)

```
AgentRunnerRegistry
  ├─ register(name, runner)
  ├─ getAvailable(name, fallbacks[])    ← 可用性检查 + 回退链
  └─ findByCapabilities(required)       ← 能力匹配

AgentRunner.run(assignment, options)
  ├─ hooks.onStart?()
  ├─ [实际执行]                          ← streamAgent / CLI 进程 / 远程
  ├─ hooks.onComplete?()
  └─ hooks.onError?()
```

### 2.5 Swarm (swarm/)

```
submit(task)
  → task:queued
  → tryAssign()              ← 分配空闲 sandbox
    → sandbox:created?       ← 无空闲则创建新 sandbox
    → task:assigned
    → task:started
    → executeTask()
        ├─ upload files
        ├─ execute command   ← 重试逻辑
        └─ emit result
    → task:completed / failed / cancelled
    → sandbox:destroyed / 回收
  → scheduler:drained        ← 全部完成
```

---

## 三、Gateway 层

### 3.1 启动与发现

```
Gateway 启动
  ├─ ProjectRegistry.discover()
  │    └─ 扫描 roots → 找到 .vera / package.json → GatewayProject[]
  ├─ createProjectCapabilityInventory()
  │    └─ 扫描 .vera/ 目录 → CapabilityDescriptor[]
  │         ├─ config     → .vera/settings.json
  │         ├─ prompt     → CLAUDE.md
  │         ├─ memory     → .vera/memory
  │         ├─ rag        → .vera/rag
  │         ├─ skill      → .claude/skills
  │         ├─ plugin     → .vera/plugins      ← ★ 插件发现
  │         ├─ mcp        → .cursor/projects
  │         ├─ channel    → .vera/channels
  │         ├─ sandbox    → .vera/sandbox
  │         ├─ flow       → .vera/flows
  │         └─ ...
  └─ CapabilityRegistry.register() → 每个 capability 注册
```

---

## 四、完整事件清单

基于以上分析，整理出插件系统需要覆盖的事件全集：

### Core 事件

```
config:load          配置加载完成
config:merge         所有 plugin.config() 合并完成
plugin:install       插件安装
plugin:activate      插件激活
plugin:deactivate    插件停用
session:create       会话创建
session:close        会话关闭
session:fork         会话分叉
turn:start           Agent 新一轮开始
turn:end             Agent 本轮结束
prompt:system        System prompt 组装（可 transform）
prompt:user          User message 组装（可 transform）
memory:select        记忆选择
memory:inject        记忆注入
llm:request          LLM 请求前
llm:response         LLM 响应后
tool:before:*        工具执行前（* 为工具名，可 intercept 短路）
tool:after:*         工具执行后（可 transform 结果）
tool:error:*         工具执行出错
message:receive      收到 channel 消息
message:send         发送 channel 消息
channel:connect      通道连接
channel:disconnect   通道断开
channel:error        通道错误
channel:reconnect    通道重连
compression:*        压缩事件（progressive / insert-compress / micro）
error:*              任意错误
```

### Harness 事件

```
flow:start              Flow 启动
flow:plan:generate      Plan 生成（自然语言 → Plan）
flow:plan:change        Plan 变更（replan / merge）
flow:step:start         Step 开始执行
flow:step:end           Step 执行完成（含 agent 输出）
flow:step:dispatch      Step 被分配 agent runner
flow:step:critique      Step 评审完成
flow:step:retry         Step 被重试
flow:critique:decision  评审决策（complete/replan/retry/ask_human）
flow:replan             Re-plan 触发
flow:pause              流程暂停（等待人工审批）
flow:resume             流程恢复
flow:checkpoint         检查点保存
flow:complete           Flow 成功结束
flow:fail               Flow 失败
flow:error              Flow 异常
agent:assign            Agent 被分配到 step
agent:start             Agent 开始执行
agent:end               Agent 执行完成
agent:error             Agent 执行出错
self-loop:cycle:start   自循环周期开始
self-loop:cycle:end     自循环周期结束
self-loop:decision      自循环终止决策
swarm:task:queued       Swarm 任务入队
swarm:task:started      Swarm 任务开始
swarm:task:completed    Swarm 任务完成
swarm:task:failed       Swarm 任务失败
swarm:sandbox:created   Sandbox 创建
swarm:sandbox:destroyed Sandbox 销毁
swarm:drained           Swarm 全部完成
```

---

## 五、Hook 类型定义

基于上述所有事件，只需要四种 hook：

```ts
interface VeraPlugin {
  name: string;
  enforce?: "pre" | "post";

  // —— 声明式：我提供什么能力 ——
  provides?: Partial<Record<ContractType, Record<string, unknown>>>;

  // —— 四个通用 hook ——
  config?(config, env): PartialConfig | null;
  intercept?(event: string, ctx: EventCtx): { handled: boolean; data?: unknown } | null;
  transform?(event: string, value: unknown, ctx: EventCtx): unknown;
  observe?(event: string, ctx: EventCtx): void;
}
```

**四种 Hook 的语义**：

| Hook | 类比 | 执行方式 | 能否短路 | 典型场景 |
|---|---|---|---|---|
| `config` | Vite config | sequential (pre→post) | 是 | 注册模型、修改 system prompt |
| `intercept` | Vite resolveId | sequential (pre→post) | 是 (返回 {handled:true}) | 拒绝 tool、替换 adapter、审批 |
| `transform` | Vite transform | sequential 管道 | 否 | 改 prompt、改 tool result、后处理 |
| `observe` | Vite buildEnd | parallel | 否 | 日志、审计、统计、监控 |

**事件匹配**：glob 模式 `tool:before:*` 匹配 `tool:before:echo`、`tool:before:read_file`。

**执行顺序**：pre → normal → post，同类 hook 按安装顺序。

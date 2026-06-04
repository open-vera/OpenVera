# Vera 插件生命周期

> 梳理 Vera 运行时中存在的生命周期节点，作为插件系统 Hook 设计的基础。

## 概述：三层运行时

```
Gateway   -- 启动/停止、项目发现、能力注册
Harness   -- Flow 编排、Critique、Replan、Swarm
Core      -- Agent 循环、工具执行、Channel、Session
```

---

## 1. Core 层

### 1.1 启动流程（main.ts）

```
loadConfig()                     <- 加载配置
  +-- isConfigEmpty? -> wizard   <- 首次运行
  +-- 正常加载
buildAdapter(provider, model)    <- 切换: anthropic/openai/gemini
resolveDefaultTarget()
loadTemplates()                  <- 提示词模板
intentRouting?                   <- 可选：单次意图分类
  +-- resolveModel()
  +-- 失败时回退到默认
|
single-run 模式 / REPL 模式分支
```

**插件 Hook 点**：

| 节点 | 类型 | 描述 |
|------|------|------|
| 配置加载后 | `transform` | 修改/注入配置（model、provider、paths） |
| buildAdapter | `intercept` | 替换 adapter 工厂，消除 switch |
| 模板加载后 | `transform` | 注入自定义提示词模板 |
| intent routing | `intercept` | 自定义路由逻辑 |
| 模式分支 | `observe` | 感知进入 single-run 还是 REPL |

### 1.2 Agent 循环（loop.ts）

核心运行时，每轮完整流水线：

```
一轮完整序列：

proactiveCompress()              <- OC1: insert-then-compress / LLM 压缩
  +-- onCompression hook
selectAndRecordMemories()        <- 选择 + 注入记忆
  +-- onMemorySelected 回调
reapplyReplacements()            <- 预算裁剪
enforcePerTurnBudget()
microCompact()                   <- 微压缩
trimToWindow()                   <- 滑动窗口
injectMemoryContext()            <- 注入 <dynamic-memory-context>
onTurnStart hook                 <- 通知：新轮次开始
----------------------------------------
API 调用 (adapter.complete)      <- LLM 调用
  +-- reactive compact           <- 提示词过长时触发
     +-- onRetry hook
----------------------------------------
handleToolCalls()                <- 解析工具调用
  对每个 tool_call:
    parse args                   <- JSON 解析（可能失败 -> 注入错误）
    onToolCall 回调              <- 执行前回调
    toolRegistry.execute()       <- 实际执行（见 1.3）
    processToolResult()          <- 结果 -> 消息，预算扣减
onTurnEnd hook                   <- 通知：轮次结束
----------------------------------------
空 assistant 重试？              <- 空响应重试（最多 3 次）
OC1 解决？                       <- 单次 API 压缩
再次循环 / 终止
```

**插件 Hook 点**：

| 节点 | 类型 | 描述 |
|------|------|------|
| 压缩前/后 | `observe` | 感知压缩发生 |
| 记忆选择 | `transform` | 自定义记忆选择策略 |
| 窗口裁剪 | `observe` | 感知哪些消息被裁剪 |
| 轮次开始 | `observe` | 审计、日志 |
| LLM 请求前 | `intercept` | 修改消息、切换模型、添加 headers |
| LLM 请求前 | `transform` | 修改 system prompt / 用户消息 |
| LLM 响应后 | `transform` | 后处理响应内容 |
| LLM 响应后 | `observe` | 记录 token 用量 |
| 工具调用解析失败 | `intercept` | 恢复格式错误的工具调用 |
| 工具调用前 | `intercept` | 拦截特定工具、替换参数 |
| 工具调用后 | `transform` | 修改工具结果 |
| 轮次结束 | `observe` | 统计、审计 |
| 空响应重试 | `observe` | 感知 agent "卡住" |
| 重试/错误 | `observe` | 感知发生错误 |

### 1.3 工具执行（registry.ts）

```
registry.execute(toolName, args, ctx)
  +-- find tool                     <- 未知工具 -> errorResult
  +-- dryRun 检查                   <- 模拟模式短路
  +-- 废弃警告                      <- 已废弃的工具
  +-- 生命周期 hook onBeforeToolCall <- 任意 hook 可返回 ToolResult 短路
  +-- middleware before             <- 每个 mw 可修改 args 或跳过
  +-- 幂等缓存检查                  <- 命中 -> 直接返回缓存结果
  +-- 重试循环（最多 3 次）         <- 超时、退避
  |    +-- executeWithTimeout
  |    +-- mw.onError               <- middleware 可从错误中恢复
  +-- middleware after              <- 每个 mw 可转换结果
  +-- 生命周期 hook onAfterToolCall  <- 通知：执行完成
  +-- 幂等缓存写入                  <- 为幂等工具缓存结果
  +-- 统计记录                      <- fire-and-forget
```

**现有内置 Hook 实例**：
- `SecurityPlugin` —— 拒绝/允许列表、只读模式、预算、路径边界、域名允许列表、注入检测、危险命令确认
- `AnalyticsPlugin` —— 记录 tool_call 和 tool_result 到 JSONL

**插件 Hook 点**（工具是最密集的 Hook 区域）：

| 节点 | 类型 | 描述 |
|------|------|------|
| 执行前 | `intercept` | 安全策略、权限检查、短路拒绝 |
| 执行前 | `transform` | 修改参数（清理、路径标准化） |
| 执行后 | `transform` | 修改结果（格式化、截断、翻译） |
| 执行后 | `observe` | 日志、统计 |
| 出错时 | `intercept` | 错误恢复、降级 |

### 1.4 Channel 生命周期（channel/）

**ChannelGateway 事件**：

```
adapter added
  -> connect()
    -> channel_connected
    -> message_received    <- 收到消息
    -> message_sent        <- 发送消息
    -> channel_error
    -> channel_disconnected
    -> reconnecting        <- 自动重连
  -> disconnect()
adapter removed
```

**ChannelPluginRegistry 生命周期**：

```
registerPlugin()    -> 插件注册
loadAdapter()       -> 创建 adapter 实例
unloadAdapter()     -> 断开 + 移除
unregisterPlugin()  -> 卸载所有 adapter + 移除插件
```

**插件 Hook 点**：

| 节点 | 类型 | 描述 |
|------|------|------|
| 消息收到 | `intercept` | 过滤/阻止消息 |
| 消息收到 | `transform` | 预处理消息内容 |
| 消息发送 | `transform` | 后处理回复内容 |
| 连接状态变化 | `observe` | 监控 channel 健康 |
| Adapter 创建 | `intercept` | 替换 adapter 实现 |

### 1.5 Session 生命周期（session/）

```
session:create          写入 session_start（model、provider、cwd）
  +-- user message       写入 user 条目
  +-- assistant response 写入 assistant 条目（+ usage、model）
  +-- tool_call          写入 tool_call 条目（+ 工具名、参数）
  +-- tool_result        写入 tool_result 条目
  +-- session:end        写入 session_end（+ 总用量、费用、轮次）

辅助操作：
  session:fork       派生 session
  session:branch     创建分支
  session:merge      合并 session
  session:cleanup    TTL 过期清理
  autoCompress       SS1：超过阈值自动压缩
```

**插件 Hook 点**：

| 节点 | 类型 | 描述 |
|------|------|------|
| 创建 | `observe` | 感知新 session 开始 |
| 每次 JSONL 写入 | `observe` | 完整审计 |
| Fork | `intercept` | 自定义 fork 逻辑 |
| 压缩 | `transform` | 自定义压缩策略 |
| 结束 | `observe` | 费用统计、通知 |

---

## 2. Harness 层

### 2.1 Flow 状态机

```
intaking -> planning -> dispatching -> executing -> critiquing
                ^           ^  |           |
                |      replanning  waiting_tool
                |           |           |
                |           |     waiting_approval
                |           |           |
                |           +------ paused
                |                       |
                +-----------------------+
                |
          completed / failed（终态）
```

**11 个状态，约 20 个有效转换**，详见 `flow-state.ts:5-17`。

### 2.2 Flow 编排循环（runtime.ts）

```
planAndStart(goal)                       <- 从自然语言生成计划
  -> startFlow(input)                    <- 创建 TaskFlow + artifact store
    +-- runFlowLoop()
      循环:
        +-- 找到下一个待执行步骤          <- 按依赖图拓扑排序
        +-- 并行批次派发                  <- 最多 maxParallel 个步骤
        |    +-- dispatchStep()
        |         +-- runAgentAssignment() <- 分配 agent runner 执行
        |              +-- agent.run()     <- 实际执行（内部为 core 的 agent loop）
        +-- runStepCritique()            <- LLM 审查步骤结果
        |    +-- complete     -> 标记完成，回顾，继续
        |    +-- ask_human    -> [waiting_approval] -> checkpoint -> 暂停
        |    +-- replan       -> [replanning] -> replanFlow() -> 修改计划
        |    +-- retry        -> 重置步骤状态，重试
        |
        +-- 无待执行步骤 -> completeFlow()
```

**决策分叉点（最值得 Hook 的地方）**：

| 节点 | 状态转换 | 插件能力 |
|------|---------|----------|
| 计划生成 | intaking->planning | `intercept` 替换计划生成器 |
| 步骤分配 | dispatching->executing | `intercept` 选择 agent runner |
| Agent 执行完成 | executing->critiquing | `transform` 修改步骤输出 |
| Critique 裁决 | critiquing->complete/replan/retry/ask_human | `intercept` 覆盖 LLM 裁决 |
| 重新计划 | replanning->dispatching | `intercept` 审计计划变更 |
| 人工审批 | waiting_approval->dispatching | `intercept` 自动批准 |
| 完成 | ->completed | `observe` 通知 |

### 2.3 Self-Loop（self-loop.ts）

```
run(handle)
  循环:
    +-- runFlowLoop()              <- 执行一轮 flow
    +-- cycleCritique()            <- LLM 审查整体结果
    +-- evaluateDecision()         <- 决策树
    |    +-- high_confidence?      -> 停止
    |    +-- max_cycles?           -> 停止
    |    +-- budget_exceeded?      -> 停止
    |    +-- duplicate_critique?   -> 停止
    |    +-- critique 建议重规划    -> replan
    |    +-- 否则                  -> 继续
    +-- replanForNextCycle()       <- 修改计划并重新运行
```

**插件 Hook 点**：

| 节点 | 类型 | 描述 |
|------|------|------|
| 每轮开始/结束 | `observe` | 进度监控 |
| 循环 Critique | `intercept` | 替换审查逻辑 |
| 决策 | `intercept` | 自定义终止条件 |
| 重新计划 | `transform` | 修改新计划 |

### 2.4 Agent Runner（agent/）

```
AgentRunnerRegistry
  +-- register(name, runner)
  +-- getAvailable(name, fallbacks[])    <- 可用性检查 + 回退链
  +-- findByCapabilities(required)       <- 能力匹配

AgentRunner.run(assignment, options)
  +-- hooks.onStart?()
  +-- [实际执行]                         <- streamAgent / CLI 进程 / 远程
  +-- hooks.onComplete?()
  +-- hooks.onError?()
```

### 2.5 Swarm（swarm/）

```
submit(task)
  -> task:queued
  -> tryAssign()              <- 分配空闲 sandbox
    -> sandbox:created?       <- 若无空闲则创建新 sandbox
    -> task:assigned
    -> task:started
    -> executeTask()
        +-- 上传文件
        +-- 执行命令           <- 重试逻辑
        +-- 发出结果
    -> task:completed / failed / cancelled
    -> sandbox:destroyed / recycled
  -> scheduler:drained        <- 全部完成
```

---

## 3. Gateway 层

### 3.1 启动与发现

```
Gateway 启动
  +-- ProjectRegistry.discover()
  |    +-- 扫描根目录 -> 查找 .vera / package.json -> GatewayProject[]
  +-- createProjectCapabilityInventory()
  |    +-- 扫描 .vera/ 目录 -> CapabilityDescriptor[]
  |         +-- config     -> .vera/settings.json
  |         +-- prompt     -> CLAUDE.md
  |         +-- memory     -> .vera/memory
  |         +-- rag        -> .vera/rag
  |         +-- skill      -> .claude/skills
  |         +-- plugin     -> .vera/plugins      <- 插件发现
  |         +-- mcp        -> .cursor/projects
  |         +-- channel    -> .vera/channels
  |         +-- sandbox    -> .vera/sandbox
  |         +-- flow       -> .vera/flows
  |         +-- ...
  +-- CapabilityRegistry.register() -> 注册每项能力
```

---

## 4. 完整事件清单

基于以上分析，插件系统需要覆盖的完整事件集：

### Core 事件

```
config:load          配置加载完成
config:merge         所有 plugin.config() 合并完成
plugin:install       插件已安装
plugin:activate      插件已激活
plugin:deactivate    插件已停用
session:create       Session 已创建
session:close        Session 已关闭
session:fork         Session 已派生
turn:start           Agent 新轮次开始
turn:end             Agent 轮次结束
prompt:system        System prompt 组装（可转换）
prompt:user          用户消息组装（可转换）
memory:select        记忆选择
memory:inject        记忆注入
llm:request          LLM 请求前
llm:response         LLM 响应后
tool:before:*        工具执行前（* = 工具名，可拦截）
tool:after:*         工具执行后（结果可转换）
tool:error:*         工具执行错误
message:receive      Channel 消息收到
message:send         Channel 消息发送
channel:connect      Channel 已连接
channel:disconnect   Channel 已断开
channel:error        Channel 错误
channel:reconnect    Channel 重连
compression:*        压缩事件（渐进式 / insert-compress / 微压缩）
error:*              任意错误
```

### Harness 事件

```
flow:start              Flow 已启动
flow:plan:generate      计划已生成（自然语言 -> Plan）
flow:plan:change        计划已变更（replan / merge）
flow:step:start         步骤开始执行
flow:step:end           步骤执行完成（含 agent 输出）
flow:step:dispatch      步骤已分配给 agent runner
flow:step:critique      步骤审查完成
flow:step:retry         步骤已重试
flow:critique:decision  审查决策（complete/replan/retry/ask_human）
flow:replan             重新计划已触发
flow:pause              Flow 已暂停（等待人工审批）
flow:resume             Flow 已恢复
flow:checkpoint         检查点已保存
flow:complete           Flow 成功完成
flow:fail               Flow 失败
flow:error              Flow 异常
agent:assign            Agent 已分配步骤
agent:start             Agent 开始执行
agent:end               Agent 执行完成
agent:error             Agent 执行错误
self-loop:cycle:start   Self-loop 循环开始
self-loop:cycle:end     Self-loop 循环结束
self-loop:decision      Self-loop 终止决策
swarm:task:queued       Swarm 任务已入队
swarm:task:started      Swarm 任务已开始
swarm:task:completed    Swarm 任务已完成
swarm:task:failed       Swarm 任务失败
swarm:sandbox:created   Sandbox 已创建
swarm:sandbox:destroyed Sandbox 已销毁
swarm:drained           Swarm 全部完成
```

---

## 5. Hook 类型定义

基于以上所有事件，只需要四种 Hook 类型：

```ts
interface VeraPlugin {
  name: string;
  enforce?: "pre" | "post";

  // -- 声明式：我提供什么能力 --
  provides?: Partial<Record<ContractType, Record<string, unknown>>>;

  // -- 四个通用 Hook --
  config?(config, env): PartialConfig | null;
  intercept?(event: string, ctx: EventCtx): { handled: boolean; data?: unknown } | null;
  transform?(event: string, value: unknown, ctx: EventCtx): unknown;
  observe?(event: string, ctx: EventCtx): void;
}
```

**四种 Hook 语义**：

| Hook | 类比 | 执行方式 | 可短路 | 典型用例 |
|------|------|---------|--------|----------|
| `config` | Vite config | 顺序执行（pre->post） | 是 | 注册模型、修改 system prompt |
| `intercept` | Vite resolveId | 顺序执行（pre->post） | 是（返回 {handled:true}） | 拒绝工具、替换 adapter、审批 |
| `transform` | Vite transform | 顺序流水线 | 否 | 修改 prompt、修改工具结果、后处理 |
| `observe` | Vite buildEnd | 并行执行 | 否 | 日志、审计、统计、监控 |

**事件匹配**：glob 模式如 `tool:before:*` 匹配 `tool:before:echo`、`tool:before:read_file`。

**执行顺序**：pre -> normal -> post；同类型 Hook 按安装顺序执行。

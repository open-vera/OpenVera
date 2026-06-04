# Agent 设计模式 — Harness 优先、自循环、自审视、自进化

> Vera 的目标不是追赶现有 Agent，而是构建一个以 Harness 为内核的 Agent 运行时——能够自规划、自循环、自审视、自进化。

---

## 0. 终极能力全景

术语定义：

- `Flow`（流程）：一个完整任务的受控执行实例
- `Plan`（计划）：Flow 的结构化执行方案
- `Step`（步骤）：Plan 内的最小执行单元
- `Critique`（审视）：结构化的结果批评
- `Proposal`（提案）：策略改进建议
- `Checkpoint`（检查点）：关键状态快照

精确定义参见 [harness.md](../harness/design.md#2-unified-terminology)。

本文中的无限上下文、记忆、梦境、规划、子代理等概念只是核心骨架。Vera 的目标不仅仅是勾选这些功能，成为"接近成熟的 Agent"，而是重新定义一种更强的 Agent 运行模式：**以 Harness 驱动的自进化系统**。

### 0.1 能力分层

一个可用的通用 Agent 至少需要覆盖以下 8 层能力：

| 层级 | 能力 | 解决什么问题 |
|---|---|---|
| **L1 感知与理解** | 意图识别、任务分类、复杂度评估 | 决定直接回答、ReAct 还是 Plan |
| **L2 执行与工具** | 文件、Shell、网络、编辑器、浏览器、MCP | 让 Agent 能真正做事，不只是说话 |
| **L3 上下文管理** | 滑动窗口、压缩、检索召回 | 解决长任务和大仓库的上下文溢出 |
| **L4 记忆系统** | 会话记忆、长期记忆、用户偏好 | 解决跨轮次、跨任务的连续性 |
| **L5 规划与协作** | Plan、Subagent、Critique | 解决复杂任务分解和并发 |
| **L6 Harness 内核** | 审批门、权限边界、注入防御、运行时控制 | 让 Agent 在边界内自循环，而不是失控 |
| **L7 可观测与恢复** | 追踪、Checkpoint、Resume、Replay | 让长任务可追踪、可中断、可恢复 |
| **L8 自进化** | Critique、Benchmark、Dreaming、Proposal Pipeline | 实现持续自我修正和进化 |

### 0.2 我们的目标是超越，不是追赶

如果我们只加"上下文、记忆、工具、规划"，结果仍然只是一个更完整的助手。Vera 的目标是成为一个更高层次的系统：

> Harness 是内核，Agent 是运行在其上的策略体。

真正的精髓不在于某个模型有多聪明，而在于 Harness 是否能同时支撑这四种能力：

- **自规划 Flow**：先构建 Plan，按状态推进，偏离时重新规划
- **自循环**：一次响应结束后，必要时自动进入下一轮执行，而不是等待用户下一条指令
- **自审视**：Agent 或审视 Agent 对当前结果进行批评，发现差距，提出修正
- **自进化**：将失败模式固化到记忆/策略/基准案例中，并转化为 Proposal

成熟系统的共性不是"更强的模型"，而是闭环。Vera 要走得更远，追求**自驱动闭环**：

```
理解任务
  -> 评估风险和范围
  -> 选择模型/模式/工具/Flow
  -> 执行
  -> 自检
  -> 观察结果
  -> 失败恢复/重新规划
  -> 沉淀为记忆
  -> 进入评估和策略优化
  -> 在边界内继续下一轮
```

此后 Vera 的所有设计都必须围绕这个自循环、自审视、自进化的闭环展开——而不是孤立地堆砌功能。

### 0.3 当前推荐能力清单

#### P0：必备——没有这些，就不是我们需要的系统

- 意图识别和模型路由
- 工具注册表 + 基础工具：`read_file`、`write_file`、`bash`、`web_search`
- 无限上下文管理
- Plan 模式
- Harness：权限、审批、作用域边界、运行时控制
- 追踪 / 用量 / 工具调用记录
- 基础 benchmark 框架
- 基础 Critique 循环

#### P1：补全自循环和自修正能力

- Checkpoint / Resume：中断后继续长任务
- 工具重试、超时、幂等控制
- Subagent 并发和聚合
- 情节记忆 / 语义记忆
- Prompt 模板化和版本化
- 失败归因和自动回放
- 审视 Agent（Critic Agent）
- Plan 偏离检测

#### P2：形成真正的自进化能力

- Dreaming：离线总结和策略优化
- Computer Use / Browser Use
- MCP 生态集成
- 自动生成测试用例
- 自适应 prompt / 工具策略优化
- Proposal + 门控 Rollout
- 失败到 benchmark 的自动固化

### 0.4 Vera 应从 Hermes 架构中学到什么

Hermes 的价值不止于提出"梦境"概念。它将 Agent 从"单模型调用循环"提升为"具有前台、后台、记忆整合和策略演进的持续运行系统"。这是当前很多 Agent 设计容易缺失的。

#### 精髓 1：分离前台路径和后台路径

Hermes 式系统不会把所有事都堆在用户请求路径上，而是拆成两个通道：

```
前台路径（热路径）
用户请求 -> 理解 -> 执行 -> 回复

后台路径（冷路径）
事件累积 -> 总结 -> 记忆整合 -> 策略更新
```

这意味着：

- 用户请求路径只做当前任务必需的计算，保证响应速度
- 记忆整理、失败归因、模式发现等异步在后台完成
- Agent 不再是"请求来了才活过来"，而是一个持续运行的系统

#### 精髓 2：事件驱动，而不只是消息驱动

普通 Agent 通常只有 `messages[]`。Hermes 式设计更像一个运行时：系统围绕事件流运转。

```ts
type AgentEvent =
  | { type: "user_message"; sessionId: string; content: string }
  | { type: "tool_succeeded"; tool: string; metadata?: Record<string, unknown> }
  | { type: "tool_failed"; tool: string; error: string; retryable: boolean }
  | { type: "plan_created"; planId: string }
  | { type: "plan_step_completed"; planId: string; stepId: string }
  | { type: "session_completed"; sessionId: string }
  | { type: "dream_cycle_started"; batchId: string };
```

好处：

- 追踪、Checkpoint、梦境、benchmark 都消费同一事件流
- 失败恢复不依赖于"猜测上轮发生了什么"
- 后台任务可以订阅事件，不侵入主循环

#### 精髓 3：记忆是分层整合，不是日志归档

Hermes 式的梦境本质上是记忆整合：

```
原始对话 / 工具输出
  ->
会话摘要（情节）
  ->
跨会话知识（语义）
  ->
策略层调整（prompt / 工具策略 / 工作流）
```

这比"全部存下来"高了一层。真正重要的是把经验蒸馏成可复用的结构，而不是堆积消化不了的日志。

#### 精髓 4：制品是一等公民，不只最终回复

在 Hermes 式系统中，需要长期保留的不只是助手最终文本，还有：

- plan
- 步骤执行记录
- 工具结果
- 情节摘要
- 梦境报告
- benchmark 报告
- Proposal

这些制品后续会进入恢复、回放、评估、策略优化等 pipeline。没有制品体系，梦境和自优化就无法落地。

#### 精髓 5：自进化必须经过人类审核和回归验证

正确的 Hermes 方向不是"Agent 自动改自己"，而是：

```
发现模式
  -> 生成改进提案
  -> 人类审核
  -> 小范围灰度
  -> Benchmark / 回归验证
```

即梦境是一个建议系统，不是自改写系统。Vera 应保留这个边界，防止 Agent 直接修改核心策略而失控。

### 0.5 Vera 运行时应该长什么样

吸收 Hermes 精髓后，Vera 的整体运行时应该是以下结构，而不是单个 `runAgent()`：

```
                   +--------------------------+
用户输入 / API ->   | 前台运行时               |
                   | 意图 -> 计划 -> 执行      |
                   +------------+-------------+
                                | 事件
                   +--------------------------+
                   | 事件总线 / 追踪           |
                   +--------+--------+--------+
                            |        |
              +-----------------+  +----------------------+
              | 记忆 Worker     |  | 评估 / 梦境          |
              | 总结            |  | 反思 / 修复          |
              +-----------------+  +----------------------+
```

前台运行时只管完成任务；后台 Worker 管整合经验。两者通过事件和制品解耦。

---

## 1. 无限上下文

### 问题

LLM 上下文窗口有限（200K tokens）。长任务、长对话、大文件都会导致溢出，造成截断或报错。

### 设计思路

不把"无限"交给模型，而是在 Agent 层管理上下文生命周期：

```
完整历史
  ->
[工作上下文]    <- 在当前窗口内，模型可见
[情节摘要]      <- 溢出部分的压缩摘要
[长期存储]      <- 向量检索，按需召回
```

### 策略分层

| 策略 | 触发条件 | 做什么 |
|---|---|---|
| **滑动窗口** | Token 超过阈值 80% | 丢弃最早轮次，保留 system + 最近 N 轮 |
| **渐进压缩** | 超过阈值 | 用轻量模型将早期对话压缩为摘要，注入 system |
| **分段存储** | 任务完成 | 将会话关键信息写入长期记忆 |
| **按需召回** | 新任务开始 | 从长期存储检索相关片段，注入上下文 |

### 实施要点

- **压缩摘要**必须保留：决策记录、已完成的步骤、发现的重要事实
- **不要压缩**：工具调用和工具结果的原始数据（模型需要关联这些）
- **Token 计数**必须在每次 API 调用前进行，而不是等 API 返回错误后再补救
- Anthropic 的 `compact` beta 可以作为服务端压缩的补充，但不应该单独依赖

---

## 2. 记忆系统

### 三层架构

```
工作记忆        对话历史，在当前上下文窗口内
      | 压缩
情节记忆        会话级摘要，本次任务的过程
      | 蒸馏
语义记忆        跨会话持久知识（用户偏好、领域事实、历史结论）
```

### 工作记忆

即 `messages[]`，由 Agent 循环直接操作。超过窗口时触发压缩。

### 情节记忆

每个任务完成后，让模型生成结构化摘要：

```json
{
  "session_id": "xxx",
  "timestamp": "2026-04-11T10:00:00Z",
  "task": "修复登录页 CSRF 漏洞",
  "outcome": "success",
  "key_findings": ["Token 未绑定 IP", "中间件顺序错误"],
  "files_modified": ["src/middleware/csrf.ts"],
  "decisions": ["选择 double-submit cookie 方案"]
}
```

### 语义记忆

长期存储，两种实现：

| 实现 | 适用场景 | 特点 |
|---|---|---|
| **文件 KV**（`.vera/memory/`） | 轻量场景 | 零依赖，人类可读，适合早期 |
| **向量数据库**（本地 sqlite-vec / 远程 Pinecone） | 大规模 | 语义检索，支持模糊匹配 |

记忆写入由 Agent 主动驱动（通过 `memory_write` 工具），不做自动全量存储，避免噪音。

### 记忆召回

每个新任务开始时，用任务描述做相似度搜索，将 top-k 片段注入 system prompt：

```
You are working on: {task}

Relevant historical memories:
- {memory_1}
- {memory_2}
```

---

## 3. 梦境系统

### 概念来源

Hermes 中的"梦境"指 Agent 在空闲时的离线思考和知识整合，类比人类睡眠期间的记忆巩固。

### Vera 中的实现

梦境是一个**后台异步任务**，在主 Agent 不处理用户请求时运行：

```
触发条件：
  - 显式调用 vera.dream()
  - 定时触发（如每日午夜）
  - 一批任务完成后

做什么：
  1. 整合情节记忆 -> 将高价值知识蒸馏到语义记忆
  2. 发现跨会话模式（"用户频繁询问 X 类型问题"）
  3. 自我评估：回顾失败案例，生成改进建议
  4. 更新 prompt 策略（如某类任务的 system prompt 表现不佳）
```

### 梦境报告输出

```json
{
  "type": "dream_report",
  "insights": [
    "用户倾向于提供不完整的需求——主动澄清",
    "Bash 工具失败率 23%，考虑添加重试逻辑"
  ],
  "memory_updates": [...],
  "suggested_prompt_patches": [...]
}
```

梦境报告需人类审核后才应用到系统配置。

### Hermes 式梦境的关键约束

为防止梦境变成"离线胡言乱语"，强制执行 3 条硬约束：

- **输入必须来自真实制品**：会话摘要、工具失败记录、benchmark 失败、用户反馈
- **输出必须结构化**：记忆更新、Proposal、工作流建议——不是散文
- **变更必须经过验证**：人类审核后才能进入 benchmark / 回归

这让梦境成为工程体系的一部分，而非概念演示。

---

## 4. Plan 模式

### 与 ReAct 的区别

| 模式 | 特点 | 适用场景 |
|---|---|---|
| **ReAct**（当前） | 边想边做，每次工具调用后立即继续 | 探索性任务，步骤不确定 |
| **Plan-then-Execute** | 先生成完整计划，确认后逐步执行 | 长任务、破坏性操作 |
| **Plan + Reflect** | 执行后对比计划，偏离时重新规划 | 高精度任务 |

### Plan 模式流程

```
用户输入
  ->
[规划阶段] 生成结构化执行计划（不调用工具）
  ->
[人类确认或自动批准]
  ->
[执行阶段] 按计划逐步执行，记录进度
  ->
[反思阶段] 对比计划与实际，生成回顾
```

### 计划格式

```json
{
  "goal": "修复登录 CSRF 漏洞",
  "steps": [
    { "id": 1, "action": "read_file", "target": "src/middleware/csrf.ts", "reason": "了解现有实现" },
    { "id": 2, "action": "analyze", "depends_on": [1], "reason": "定位根因" },
    { "id": 3, "action": "write_file", "depends_on": [2], "reason": "应用修复" },
    { "id": 4, "action": "bash", "target": "npm test", "depends_on": [3], "reason": "验证修复" }
  ],
  "risk": "low",
  "estimated_turns": 6
}
```

### 何时触发 Plan 模式

- 任务复杂度评分超过阈值（由意图识别判定，参见 [intent-routing.md](./intent-routing.md)）
- 涉及破坏性操作（删除、覆盖、部署）
- 用户显式指定 `--plan`

---

## 5. Subagent 系统

### 设计目标

主 Agent（编排器 Orchestrator）负责任务分解和结果整合。专项 Agent（Worker）负责具体执行。它们通过标准消息协议通信，互不知晓对方的内部实现。

### 消息协议

```ts
interface AgentTask {
  task_id: string;
  parent_agent_id: string;
  instruction: string;
  tools: string[];          // 允许使用的工具白名单
  context?: string;         // 必要的上下文片段
  timeout_ms?: number;
}

interface AgentResult {
  task_id: string;
  status: "success" | "failure" | "partial";
  output: string;
  tool_calls: ToolCallRecord[];
  usage: Usage;
}
```

### 典型模式

**并行扇出**：主 Agent 将大任务分解为 N 个独立子任务，并发分发给 N 个子 Agent：

```
Orchestrator
  +-- SubAgent A: 分析前端代码
  +-- SubAgent B: 分析后端代码
  +-- SubAgent C: 查询相关文档
         | (全部完成后)
  整合结果 -> 最终答案
```

**串行流水线**：一个子 Agent 的输出成为下一个的输入：

```
研究员 -> 分析员 -> 写手 -> 审核员
```

**递归子 Agent**：子 Agent 发现自己的子任务仍然太大，可进一步分解（有递归深度限制）。

### 实施要点

- 子 Agent 是独立的 `runAgent` 调用，共享 adapter 但各自拥有独立的消息历史
- 编排器只传递必要的上下文片段，不传完整历史（控制 token 消耗）
- 设置全局 `maxDepth` 防止无限递归
- 子 Agent 的 token 消耗计入父任务的用量汇总

### 何时使用 Subagent

**应该使用 Subagent 的情况：**
- 多文件/模块分析（并行扇出）
- 代码审查（安全/性能/质量可并行检查）
- 调研 + 写作（串行流水线）
- 探索性任务（避免污染主上下文）
- 大任务分解（超出单上下文窗口）

**不应使用 Subagent 的情况：**
- 单文件读取/编辑（单步操作，无并行价值）
- 简单命令执行（无需上下文隔离）
- 高度依赖主会话的任务（上下文传递成本过高）
- Token 预算充足的小任务（过度分解增加开销）

---

## 6. 工具与环境交互能力

没有扎实的工具系统，Agent 就只是会聊天的助手，不是能干活的工作者。Codex、Claude 等产品的核心竞争力，底层都是建立在"稳定的工具执行"之上。

### 必需的基础工具层

| 分类 | 最低能力 | 备注 |
|---|---|---|
| **文件工具** | `read_file`、`write_file`、`edit_file`、`list_dir`、`glob` | `edit_file` 比全文件覆写更安全 |
| **搜索工具** | `grep_text`、`code_search` | 大仓库中结构化搜索必不可少 |
| **命令工具** | `bash` | 需要 timeout、cwd、env、stdout/stderr 捕获 |
| **网络工具** | `web_search`、`fetch_url` | 需要域名白名单和内容净化 |
| **记忆工具** | `memory_write`、`memory_search` | 不应直接暴露底层存储细节 |
| **协作工具** | `delegate_task`、`wait_task` | 统一接口对接子 Agent |

### 必需的执行语义

```ts
interface ToolExecutionOptions {
  timeoutMs?: number;
  retries?: number;
  cwd?: string;
  env?: Record<string, string>;
  idempotencyKey?: string;
  dryRun?: boolean;
}
```

必须支持：

- **超时控制**：防止 Shell/网络调用卡死
- **重试策略**：区分可重试和不可重试错误
- **结构化错误**：不要只返回字符串 error
- **幂等键**：避免重复执行高成本或高风险动作
- **标准化输出**：工具结果必须能被模型稳定消费

### 推荐的工具结果格式

```ts
interface ToolResult {
  ok: boolean;
  content: string;
  metadata?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}
```

---

## 7. Harness 与安全边界

Agent 越强，越需要外壳。没有 Harness，Agent 在真实环境里迟早会搞出提权、误删、误执行、prompt 注入。

详细设计参见 [harness.md](../harness/design.md)。这里强调它在整体能力全景中的位置：**Harness 不是辅助模块，而是 Agent 运行时的第一层。**

### Harness 必须处理的事

- 工具白名单和参数校验
- 工作目录 / 域名 / 预算范围约束
- 高风险操作审批门
- Prompt 注入防御
- 审计日志
- Subagent 权限继承

### 成熟 Agent 必须做到的

- 能解释"为什么不能做"
- 越权时能停下
- 能视外部内容为数据，不作为指令
- 能把高风险操作显式上报人类决策

---

## 8. 可观测性、恢复与长运行任务

这是当前文档中最显眼缺失的领域。一旦进入生产或日常高频使用，问题往往不是"能不能做"，而是"做一半崩溃了怎么办"、"刚才为什么失败"、"能不能接着跑"。

### 8.1 必需的运行时可观测性

每轮至少记录：

```json
{
  "session_id": "sess_xxx",
  "turn": 4,
  "model": "claude-sonnet-4-6",
  "tokens_in": 3200,
  "tokens_out": 740,
  "latency_ms": 1840,
  "tool_calls": ["read_file", "bash"],
  "plan_step": 3,
  "status": "ok"
}
```

### 8.2 必需的恢复能力

| 能力 | 用途 |
|---|---|
| **checkpoint** | 关键步骤后保存 Agent 状态 |
| **resume** | 进程退出或 API 侧挂起后的恢复执行 |
| **replay** | 重放任务以复现失败链路 |
| **fork** | 从检查点分支尝试不同策略 |

### 8.3 推荐保存的状态

- 当前 messages / summaries
- 当前 Plan 和 Step 状态
- 已执行的工具调用记录
- 当前预算消耗
- Subagent 树结构
- 最近一次用户审批结果

没有这些能力，长任务只能"从头再来"——与成熟 Agent 的体验差距巨大。

---

## 9. 评估、回归与持续进化

向 Codex / Claude / OpenClaw 学习的不仅是能力设计，更是它们底层的评估和进化机制。

### 9.1 评估必须覆盖三类

| 类别 | 示例 | 度量什么 |
|---|---|---|
| **结果正确性** | 任务是否完成 | 通过率 |
| **过程正确性** | 工具是否选对/用对 | 工具准确率 |
| **系统稳定性** | 多次运行是否一致 | 方差 / 抖动率 |

### 9.2 必需的案例类型

- 纯问答案例：验证路由和直接回答
- 单工具案例：验证参数生成
- 多步代码案例：验证读/改/测闭环
- 高风险案例：验证 Harness 正确拦截
- 长任务案例：验证压缩、checkpoint、resume

### 9.3 梦境的真正位置

梦境不是一个"酷炫的附加功能"，而是评估闭环的一部分：

```
生产任务 / benchmark 失败
  -> 聚合失败案例
  -> 蒸馏模式
  -> 生成 prompt / 工具策略改进建议
  -> 人类审核
  -> 回归评估验证改进
```

如果梦境没有和 benchmark、回归接在一起，它就只是一个总结报告，价值有限。

---

## 10. Vera 的结语

现阶段，我们不应该把目标定义为"做出几个看着高级的 Agent 功能"，而应该是：

> 构建一个具备执行闭环、权限边界、可恢复性、持续评估能力的通用 Agent 运行时。

换言之，未来的 Vera 必须同时具备：

- **能做**：工具、执行、编辑、搜索
- **能想**：规划、反思、子任务拆分
- **能记**：上下文管理、长期记忆
- **不越界**：Harness、安全、审批
- **可追溯**：追踪、Checkpoint、Resume
- **能进化**：Benchmark、Dreaming、回归优化

这 6 类能力必须同时成立，才能真正逼近 Codex / Claude 级别的 Agent 系统。

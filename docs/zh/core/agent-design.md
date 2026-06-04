# Agent 设计模式 — Harness First · 自循环 · 自我批判 · 自我进化

> Vera 的目标不是追赶已有 agent，而是以 Harness 为内核，做一个可自规划、自循环、自我批判、自我进化的 agent runtime。

---

## 0. 我们最终要支持的能力版图

术语约定：

- `Flow`：一个完整任务的受控运行实例
- `Plan`：Flow 的结构化执行方案
- `Step`：Plan 中的最小执行单元
- `Critique`：结构化结果批判
- `Proposal`：策略改进提案
- `Checkpoint`：关键状态快照

具体定义以 [harness.md](../harness/design.md#2-统一术语) 为准。

当前文档里的无限上下文、记忆、梦境、规划、Subagent 只是核心骨架。Vera 的目标不是补齐这些 feature 后“接近成熟 agent”，而是重新定义更强的 agent operating model：**Harness 驱动的自演化系统**。

### 0.1 能力分层

一个可用的通用 agent，至少要覆盖下面 8 层能力：

| 层级 | 能力 | 解决什么问题 |
|---|---|---|
| **L1 感知与理解** | 意图识别、任务分类、复杂度判断 | 决定该走直接回答、ReAct 还是 Plan |
| **L2 执行与工具** | 文件、shell、网络、编辑器、浏览器、MCP | 让 agent 真正能做事，而不是只会说 |
| **L3 上下文管理** | 滑动窗口、压缩、检索召回 | 解决长任务和大仓库上下文溢出 |
| **L4 记忆系统** | 会话记忆、长期记忆、用户偏好 | 解决跨轮、跨任务连续性 |
| **L5 规划与协作** | Plan、Subagent、Critique | 解决复杂任务拆解与并发 |
| **L6 Harness 内核** | 审批门、权限边界、注入防御、运行控制 | 让 agent 在边界内自循环，而不是失控 |
| **L7 观测与恢复** | tracing、Checkpoint、Resume、回放 | 解决长任务可追踪、可中断、可恢复 |
| **L8 自我演化** | Critique、benchmark、dreaming、Proposal Pipeline | 让系统持续自我修正和进化 |

### 0.2 我们的目标不是追赶，而是超出已有 agent 设计

如果只是补“上下文、记忆、工具、规划”，我们做出来的仍然只是更完整的 assistant。Vera 要做的是更高一层的系统：

> Harness 是内核，agent 是运行在其上的策略体。

也就是说，真正的精髓不是某个模型多聪明，而是 harness 是否能支撑下面这 4 个能力同时成立：

- **自我规划 Flow**：先建 Plan，再按状态推进，再根据偏差重规划
- **自循环**：一次回复结束后，必要时自动进入下一轮执行，而不是等用户重新发令
- **自我批判**：由 agent 自己或 critic agent 对当前结果做 Critique，找漏洞、提修正
- **自我进化**：把失败模式沉淀成 memory / policy / benchmark case，并转成 Proposal

成熟系统的共同点不是“模型更强”，而是具备闭环；Vera 的目标是在闭环之上，进一步做到**自驱式闭环**：

```
理解任务
  → 判断风险与范围
  → 选择模型 / 模式 / 工具 / Flow
  → 执行
  → 自我检查
  → 观测结果
  → 失败恢复 / 重新规划
  → 沉淀记忆
  → 进入评测与策略优化
  → 在边界内继续下一轮
```

Vera 后续设计必须围绕这个“可自循环、可自批判、可自进化”的闭环展开，而不是孤立地堆 feature。

### 0.3 现阶段建议支持的能力清单

#### P0：必须有，否则还不是我们要的系统

- 意图识别与模型路由
- Tool registry + 基础 tool：`read_file`、`write_file`、`bash`、`web_search`
- 无限上下文管理
- Plan Mode
- Harness：权限、审批、范围边界、runtime control
- Trace / usage / tool call 记录
- 基础 benchmark harness
- 基础 Critique 回路

#### P1：补齐自循环和自我修正能力

- Checkpoint / Resume：长任务中断后继续
- Tool 重试、超时、幂等控制
- Subagent 并发与汇总
- Episodic / Semantic Memory
- Prompt 模板化和版本化
- 失败归因与自动回放
- critic agent
- plan deviation detection

#### P2：形成真正的自我进化能力

- Dreaming：离线总结与策略优化
- Computer Use / Browser Use
- MCP 生态接入
- 自动生成测试 case
- 自适应 prompt / tool policy 优化
- Proposal + gated Rollout
- failure-to-benchmark 自动沉淀

### 0.4 Hermes 架构设计的精华，Vera 应该学什么

Hermes 的价值不只是提出了 dreaming，而是把 agent 从“一次模型调用循环”提升成“有前台、后台、记忆固化和策略演化的持续运行系统”。这部分是当前很多 agent 设计最容易遗漏的。

#### 精华 1：前台路径和后台路径分离

Hermes 风格系统不是所有事都在用户请求路径里完成，而是拆成两条通路：

```
前台路径（hot path）
用户请求 → 理解 → 执行 → 回复

后台路径（cold path）
事件沉淀 → 总结 → 记忆固化 → 策略更新
```

这意味着：

- 用户请求路径只做对当前任务必要的计算，保证响应速度
- 记忆整理、失败归因、模式发现放到后台异步做
- agent 不再是“请求来了才活一下”，而是持续运行的系统

#### 精华 2：事件驱动，而不是只有 message 驱动

普通 agent 往往只有 `messages[]`。Hermes 风格设计更像 runtime：系统围绕事件流运转。

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

这样做的好处：

- tracing、Checkpoint、dreaming、benchmark 都能消费同一套事件
- 失败恢复不依赖“猜上一轮发生了什么”
- 后台任务可以订阅事件，而不是侵入主 loop

#### 精华 3：记忆不是日志归档，而是分层固化

Hermes 的 dreaming 本质上是在做 memory consolidation：

```
原始对话 / tool 输出
  ↓
会话摘要（episodic）
  ↓
跨会话知识（semantic）
  ↓
策略级调整（prompt / tool policy / workflow）
```

这比“把历史都存起来”高一个层级。真正重要的是把经验提炼成可复用结构，而不是积累一堆不可消费的日志。

#### 精华 4：产物是一等公民，不只是最终回复

Hermes 风格系统里，需要长期保留的不只是 assistant 最后一段文本，还包括：

- plan
- step 执行记录
- tool result
- episodic summary
- dream report
- benchmark report
- Proposal

这些产物后续会进入恢复、回放、评测和策略优化链路。没有 artifact 体系，dreaming 和自我优化就无法落地。

#### 精华 5：自我演化必须经过人工审核和回归验证

Hermes 的正确方向不是“agent 自动改自己”，而是：

```
发现模式
  → 生成改进提案
  → 人工审核
  → 小范围应用
  → benchmark / 回归验证
```

也就是说，dreaming 是建议系统，不是自我重写系统。Vera 应该保留这个边界，避免让 agent 直接修改核心策略后失控。

### 0.5 Vera 的运行时应该长什么样

如果吸收 Hermes 的精华，Vera 的整体运行时应是下面这个结构，而不是单一 `runAgent()`：

```
                   ┌──────────────────────┐
用户输入 / API  →  │ Foreground Runtime   │
                   │ intent → plan → act  │
                   └─────────┬────────────┘
                             ↓ events
                   ┌──────────────────────┐
                   │ Event Bus / Trace    │
                   └──────┬────────┬──────┘
                          ↓        ↓
              ┌────────────────┐  ┌──────────────────┐
              │ Memory Worker  │  │ Eval / Dreaming  │
              │ summarize      │  │ reflect / patch  │
              └────────────────┘  └──────────────────┘
```

前台 runtime 只负责把任务做完；后台 worker 负责把经验沉淀下来。两者通过事件和 artifact 解耦。

---

## 1. 无限上下文（Infinite Context）

### 问题

LLM 的 context window 是有限的（200K token）。长任务、长对话、大文件都会超出，导致截断或报错。

### 设计思路

不把"无限"交给模型，而是在 agent 层管理上下文生命周期：

```
完整历史
  ↓
[Working Context]   ← 当前 window 内，模型能看到的
[Episodic Summary]  ← 超出部分的压缩摘要
[Long-term Store]   ← 向量检索，按需召回
```

### 策略分层

| 策略 | 触发时机 | 做什么 |
|---|---|---|
| **滑动窗口** | token 超过阈值的 80% | 丢弃最早的几轮，保留 system + 最近 N 轮 |
| **渐进压缩** | 超过阈值 | 用轻量模型把早期对话压缩成摘要，注入 system |
| **分段存储** | 任务结束 | 把本次会话的关键信息写入长期记忆 |
| **按需召回** | 新任务开始 | 从长期存储里检索相关片段，注入上下文 |

### 实现要点

- **压缩摘要**要保留：决策记录、已完成的步骤、发现的重要事实
- **不能压缩**的内容：tool call 和 tool result 的原始数据（模型需要对照）
- **token 计数**要在每次 API 调用前计算，不要等到 API 报错再处理
- Anthropic 的 `compact` beta 可作为服务端压缩的补充，但不能完全依赖

---

## 2. 记忆系统（Memory System）

### 三层架构

```
Working Memory       对话历史，当前 context window 内
      ↓ 压缩
Episodic Memory      会话级摘要，本次任务的经过
      ↓ 提炼
Semantic Memory      跨会话的持久知识（用户偏好、领域事实、过去结论）
```

### Working Memory

就是 `messages[]`，agent loop 直接操作。超出 window 时触发压缩。

### Episodic Memory

每次任务结束后，让模型生成一段结构化摘要：

```json
{
  "session_id": "xxx",
  "timestamp": "2026-04-11T10:00:00Z",
  "task": "修复登录页的 CSRF bug",
  "outcome": "success",
  "key_findings": ["token 未绑定 IP", "中间件顺序有误"],
  "files_modified": ["src/middleware/csrf.ts"],
  "decisions": ["选择 double-submit cookie 方案"]
}
```

### Semantic Memory

长期存储，两种实现：

| 实现 | 适用 | 特点 |
|---|---|---|
| **文件 KV**（`.vera/memory/`） | 轻量场景 | 零依赖，人可读，适合早期 |
| **向量数据库**（本地 sqlite-vec / 远程 Pinecone） | 大规模 | 语义检索，支持模糊匹配 |

记忆的写入由 agent 主动决策（通过 `memory_write` tool），而不是自动全量存储，避免噪声。

### 记忆召回

每次新任务开始时，用任务描述做相似度检索，把 top-k 片段注入 system prompt：

```
你在处理：{task}

相关历史记忆：
- {memory_1}
- {memory_2}
```

---

## 3. 梦境系统（Dreaming）

### 概念来源

Hermes 中的 dreaming 指 agent 在"空闲时"进行的离线思考和知识整合，类比人类睡眠时的记忆巩固。

### 在 Vera 中的实现

Dreaming 是一个**后台异步任务**，在主 agent 不处理用户请求时运行：

```
触发时机：
  - 显式调用 vera.dream()
  - 定时触发（如每天凌晨）
  - 一批任务完成后

做什么：
  1. 整合 Episodic Memory → 提炼高价值知识写入 Semantic Memory
  2. 发现跨会话的模式（"用户经常问 X 类问题"）
  3. 自我评估：回顾失败的 case，生成改进建议
  4. 更新 prompt 策略（如发现某类任务的 system prompt 效果差）
```

### 梦境产物

```json
{
  "type": "dream_report",
  "insights": [
    "用户倾向于提供不完整的需求，需要主动澄清",
    "bash 工具失败率 23%，建议增加重试逻辑"
  ],
  "memory_updates": [...],
  "suggested_prompt_patches": [...]
}
```

梦境报告供人工审核，审核通过后应用到系统配置。

### Hermes 风格 dreaming 的关键约束

为了避免把 dreaming 做成“离线胡思乱想”，建议加 3 个硬约束：

- **输入必须来自真实 artifact**：session summary、tool failure、benchmark failure、user feedback
- **输出必须结构化**：memory update、Proposal、workflow suggestion，而不是大段散文
- **变更必须经过验证**：人工审核后再进入 benchmark / 回归

这样 dreaming 才是工程系统的一部分，而不是概念展示。

---

## 4. Plan 模式（Plan Mode）

### 与 ReAct 的区别

| 模式 | 特点 | 适用 |
|---|---|---|
| **ReAct**（当前） | 边想边做，每步工具调用后立即继续 | 探索性任务、步骤不确定 |
| **Plan-then-Execute** | 先生成完整计划，确认后逐步执行 | 长任务、有破坏性操作 |
| **Plan + Reflect** | 执行后对比计划，偏差时重新规划 | 高精度任务 |

### Plan Mode 流程

```
用户输入
  ↓
[规划阶段] 生成结构化执行计划（不调任何工具）
  ↓
[人工确认 or 自动审批]
  ↓
[执行阶段] 按计划逐步执行，记录进度
  ↓
[反思阶段] 对比计划 vs 实际，生成复盘
```

### 计划格式

```json
{
  "goal": "修复登录 CSRF 漏洞",
  "steps": [
    { "id": 1, "action": "read_file", "target": "src/middleware/csrf.ts", "reason": "了解现有实现" },
    { "id": 2, "action": "analyze", "depends_on": [1], "reason": "定位问题根因" },
    { "id": 3, "action": "write_file", "depends_on": [2], "reason": "应用修复" },
    { "id": 4, "action": "bash", "target": "npm test", "depends_on": [3], "reason": "验证修复" }
  ],
  "risk": "low",
  "estimated_turns": 6
}
```

### 触发 Plan Mode 的时机

- 任务复杂度评分 > 阈值（由意图识别决定，见 [intent-routing.md](./intent-routing.md)）
- 涉及破坏性操作（删除、覆写、部署）
- 用户显式要求 `--plan`

---

## 5. Subagent 系统

### 设计目标

主 agent（Orchestrator）负责任务分解和结果整合，专项 agent（Worker）负责具体执行。两者通过标准消息协议通信，互相不感知内部实现。

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

**并行扇出**：主 agent 把大任务拆成 N 个独立子任务，并发给 N 个 subagent：
```
Orchestrator
  ├── SubAgent A: 分析 frontend 代码
  ├── SubAgent B: 分析 backend 代码
  └── SubAgent C: 查询相关文档
         ↓（全部完成后）
  整合结果 → 最终回答
```

**串行流水线**：上一个 subagent 的输出是下一个的输入：
```
Researcher → Analyzer → Writer → Reviewer
```

**递归 subagent**：subagent 发现子任务过大时，可以再次拆分（需要设置递归深度上限）。

### 实现要点

- Subagent 是独立的 `runAgent` 调用，共享 adapter 但各自独立 message history
- Orchestrator 只传递必要的上下文片段，不传完整历史（控制 token）
- 设置全局 `maxDepth` 防止无限递归
- Subagent 的 token 消耗计入父任务的 usage 汇总

---

## 6. Tool 与环境交互能力

如果没有扎实的 tool system，agent 只是会说话的 assistant，不是能执行任务的 worker。Codex、Claude 类产品的核心竞争力，本质上都建立在“稳定工具执行”之上。

### 需要支持的基础工具层

| 类别 | 最小能力 | 备注 |
|---|---|---|
| **文件工具** | `read_file`、`write_file`、`edit_file`、`list_dir`、`glob` | `edit_file` 比整文件覆写更安全 |
| **搜索工具** | `grep_text`、`code_search` | 大仓库里必须有结构化检索能力 |
| **命令工具** | `bash` | 需要 timeout、cwd、env、stdout/stderr 捕获 |
| **网络工具** | `web_search`、`fetch_url` | 需要域名白名单与内容清洗 |
| **记忆工具** | `memory_write`、`memory_search` | 不应直接暴露底层存储细节 |
| **协作工具** | `delegate_task`、`wait_task` | 为 subagent 提供统一接口 |

### 需要支持的执行语义

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

- **超时控制**：防止 shell / 网络调用卡死
- **重试策略**：区分可重试错误和不可重试错误
- **结构化错误**：不要只返回字符串报错
- **幂等标识**：避免重复执行高成本或高风险动作
- **标准化输出**：工具结果要能被模型稳定消费

### 推荐的工具返回格式

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

### 为什么这层重要

- Codex 强在代码仓库操作闭环
- Claude 强在长上下文 + 工具使用稳定性
- OpenClaw / Harness 类系统强调外部环境约束和可验证执行

Vera 要学习的是这些系统的“执行模型”，不是简单复制 UI 或 prompt。

---

## 7. Harness 与安全边界

Agent 越强，越需要壳。没有 harness 的 agent，在真实环境里迟早会出现越权、误删、误执行和 prompt injection。

这部分详细设计见 [harness.md](../harness/design.md)，这里强调它在整体能力版图里的地位：**Harness 不是附属模块，而是 agent runtime 的第一层。**

### Harness 必须负责的事情

- 工具白名单与参数校验
- 工作目录 / 域名 / 预算范围约束
- 高风险操作审批门
- Prompt injection 防御
- 审计日志
- Subagent 权限继承

### 一个成熟 agent 必须做到

- 能解释“为什么不能做”
- 能在超出授权时停下来
- 能把外部内容当数据，不当指令
- 能把高风险操作显式升级为人工决策

---

## 8. 观测、恢复与长任务运行

这是目前文档里缺失最明显的一块。真正进入生产或日常高频使用后，问题往往不是“会不会做”，而是“做了一半挂了怎么办”“为什么刚才失败了”“能不能接着跑”。

### 8.1 需要支持的运行时观测

每个 turn 至少记录：

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

### 8.2 需要支持的恢复能力

| 能力 | 作用 |
|---|---|
| **checkpoint** | 在关键步骤后保存 agent 状态 |
| **resume** | 进程退出或 API 端挂起后恢复执行 |
| **replay** | 回放一次任务，复现失败链路 |
| **fork** | 从某个 checkpoint 分叉，尝试不同策略 |

### 8.3 建议保存的状态

- 当前 messages / summaries
- 当前 Plan 与 Step 状态
- 已执行 tool call 记录
- 当前预算消耗
- subagent 树结构
- 最近一次用户审批结果

没有这些能力，长任务只能“从头再来”，这和成熟 agent 的体验差距会非常大。

---

## 9. 评测、回归与持续进化

要向 Codex / Claude / OpenClaw 学，不只是学能力设计，更要学它们背后的评测与演化机制。

### 9.1 评测必须覆盖三类问题

| 类别 | 例子 | 衡量什么 |
|---|---|---|
| **结果正确性** | 有没有完成任务 | pass rate |
| **过程正确性** | 工具有没有选错 / 乱调 | tool accuracy |
| **系统稳定性** | 多跑几次是否一致 | variance / flaky rate |

### 9.2 需要支持的 case 类型

- 纯问答 case：验证路由与直接回答
- 单工具 case：验证参数生成
- 多步代码 case：验证 read/edit/test 闭环
- 高风险 case：验证 harness 是否正确拦截
- 长任务 case：验证压缩、checkpoint、resume

### 9.3 Dreaming 的真正位置

Dreaming 不是“酷炫附加功能”，而是评测闭环的一部分：

```
线上任务 / benchmark 失败
  → 聚合失败案例
  → 提炼模式
  → 生成 prompt / tool policy 改进建议
  → 人工审核
  → 回归评测验证是否变好
```

如果 dreaming 不接入 benchmark 和回归，它就只是一份总结报告，价值有限。

---

## 10. 对 Vera 的结论

现阶段我们不应把目标定义为“做出几个看起来高级的 agent feature”，而应定义为：

> 做出一个具备执行闭环、权限边界、可恢复性和持续评测能力的通用 agent runtime。

也就是说，未来 Vera 需要同时具备：

- **会做事**：工具、执行、编辑、搜索
- **会思考**：规划、反思、子任务拆解
- **记得住**：上下文管理、长期记忆
- **不越界**：harness、安全、审批
- **可追踪**：trace、checkpoint、resume
- **能进化**：benchmark、dreaming、回归优化

这 6 类能力一起成立，才算真正接近 Codex / Claude 级别的 agent 系统。

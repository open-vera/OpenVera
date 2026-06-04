# Harness Runtime 实现

> 本文档描述 `packages/harness/src/runtime/` 的 v1 实现边界，以及它如何继承 `multi-agent-mvp` 的运行模型。

---

## 1. 当前目标（已完成）

从 MVP 运行模型到当前 `@vera/harness` 的迁移已完成。核心目标是建立一个可工作的 Plan -> Act -> Critique -> Replan 闭环：

- `Plan Challenge`
- `Step Challenge`
- `Approval`
- `Timeline / Artifact`
- `Proposal` 入口

迁移原则：

1. 迁移的是运行模型，而不是旧的类型
2. 使用 `@vera/core/src/types/runtime.ts` 作为统一协议
3. `.vera/flows` Markdown 仅作为输入配置层
4. Retrospective / challenger 经验最终进入 Proposal Pipeline

---

## 2. 新模块结构

位于 `packages/harness/src/runtime`：

- `runtime.ts`
  V1 `HarnessRuntime` 类
- `critique.ts`
  `Plan` / `Step` critique 执行与旧 challenge 结果适配
- `flow-config/parser.ts`
  `.vera/flows/flow/<name>/main.md`、`stages/*/main.md`、`agents/*/main.md` 输入解析
- `flow.ts`
  `TaskFlow` / `Checkpoint` 组装
- `approval.ts`
  审批记录抽象
- `timeline.ts`
  timeline.ndjson 写入
- `artifacts.ts`
  产物持久化
- `proposal.ts`
  Proposal 生成入口

---

## 3. 已实现的能力

### 3.1 `HarnessRuntime`

`runtime.ts` 目前提供：

- `loadFlowDefinition(flowDir)`
- `startFlow(input)`
- `dispatchStep(handle, stepId?)`
- `runAgentAssignment(handle, assignment, options?)`
- `runPlanCritique(handle, input)`
- `runStepCritique(handle, input)`
- `replanFlow(handle, input)`
- `runFlowLoop(handle, options?)`
- `recordApproval(handle, action, decision)`
- `checkpointFlow(handle, checkpointId)`
- `createProposal(handle, rationale, input)`
- `completeFlow(handle)`
- `failFlow(handle)`

### 3.2 运行模型迁移状态

| MVP 能力 | 新实现状态 |
|---------------|--------------------------|
| `planFlow -> challengePlan` | 已迁移到 `runPlanCritique()` |
| `executeStep -> challengeStep` | 已迁移到 `runStepCritique()` |
| `step dispatch -> agent run` | 已迁移到 `dispatchStep()` + `runAgentAssignment()` |
| 最小自动闭环 | 已迁移到 `runFlowLoop()` |
| `critique -> replan` | 已迁移到 `replanFlow()` 并集成到 `runFlowLoop()` |
| 人工审批 | 已迁移到 `recordApproval()` |
| `timeline.ndjson` | 已迁移到 `appendTimeline()` |
| 产物持久化 | 已迁移到 `writeArtifact()` |
| retrospective -> lesson | 有 `createProposal()` 入口 |

---

## 4. 与 MVP 的关系

### 4.1 保留了什么

- 对抗性审查哲学
- 先计划 challenge、后步骤 challenge
- 产物持久化
- Timeline 事件记录
- 人工审批插入点

### 4.2 放弃了什么

- 旧的 `FSMStateName`
- `Blackboard` 作为主要运行时状态
- `BusinessMessage` 作为通用协议中心
- Markdown 直接驱动执行状态机

新版本的核心聚合根是 `TaskFlow`，不是 `BlackboardState`。

---

## 5. P0 结论与后续步骤

### P0 已实现

- `planFromPrompt` + `HarnessRuntime.runFlowLoop` 已就位，支持 Plan -> Act -> Critique -> Replan。
- `FlowHandle` 包含执行状态字段，在运行时中持续更新。
- `waiting_approval`、依赖循环检测、步骤 critique 低置信度 replan 均已集成。

### P1（下一阶段）

- 让 `dispatchStep()` 生成更丰富的 `contextSlices`
- 让 `runStepCritique()` 消费结构化输出，而非单一文本
- 为 `replanFlow()` 添加更强的 plan diff / merge 策略

### P2（中期）

- 自动将 retrospective / challenger 经验转化为 `Proposal`
- 将 Proposals 连接到 Rollout / benchmark 验证管道

---

## 6. 当前结论

v1 已完成了最关键的步骤：

> 我们不再依赖 MVP 的旧类型系统，但已将其最有价值的运行模型迁移到了新的 `@vera/harness` 中。

未来的工作应围绕 `HarnessRuntime` 展开，而非回归旧的 `blackboard/session` 结构。

# Harness Runtime 实现说明

> 这份文档描述 `packages/harness/src/runtime/` 的第一版实现边界，以及它如何承接 `multi-agent-mvp` 的运行模式。

---

## 1. 当前目标（已完成）

已完成从 MVP 运行模式向当前 `@vera/harness` 的迁移，核心目标是建立可运行的 Plan → Act → Critique → Replan 闭环：

- `Plan Challenge`
- `Step Challenge`
- `Approval`
- `Timeline / Artifact`
- `Proposal` 入口

迁移原则：

1. 迁运行模式，不迁旧类型
2. 用 `@vera/core/src/types/runtime.ts` 作为统一协议
3. `.vera/flows` Markdown 只作为输入配置层
4. retrospective / challenger lesson 最终进入 Proposal Pipeline

---

## 2. 新模块结构

位于 [packages/harness/src/runtime](/Users/yang.zhou/workspace/open-vera/packages/harness/src/runtime)：

- `runtime.ts`
  第一版 `HarnessRuntime` 类
- `critique.ts`
  `Plan` / `Step` 批判执行与旧 challenge 结果适配
- `flow-config/parser.ts`
  `.vera/flows/flow/<name>/main.md`、`stages/*/main.md`、`agents/*/main.md` 输入解析
- `flow.ts`
  `TaskFlow` / `Checkpoint` 组装
- `approval.ts`
  审批记录抽象
- `timeline.ts`
  timeline.ndjson 写入
- `artifacts.ts`
  artifact 持久化
- `proposal.ts`
  Proposal 生成入口

---

## 3. 已实现能力

### 3.1 `HarnessRuntime`

[runtime.ts](/Users/yang.zhou/workspace/open-vera/packages/harness/src/runtime/runtime.ts:1) 当前提供：

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

### 3.2 运行模式迁移情况

| MVP 能力 | 新实现状态 |
|---|---|
| `planFlow -> challengePlan` | 已迁成 `runPlanCritique()` |
| `executeStep -> challengeStep` | 已迁成 `runStepCritique()` |
| `step dispatch -> agent run` | 已迁成 `dispatchStep()` + `runAgentAssignment()` |
| 最小自动闭环 | 已迁成 `runFlowLoop()` |
| `critique -> replan` | 已迁成 `replanFlow()` 并接入 `runFlowLoop()` |
| 人工审批 | 已迁成 `recordApproval()` |
| `timeline.ndjson` | 已迁成 `appendTimeline()` |
| artifact 落盘 | 已迁成 `writeArtifact()` |
| retrospective -> lesson | 已有 `createProposal()` 入口 |

---

## 4. 和 MVP 的关系

### 4.1 保留的东西

- adversarial review 思路
- 计划先挑战、步骤后挑战
- artifact 落盘
- timeline 事件记录
- 人工审批插入点

### 4.2 丢弃的东西

- 旧 `FSMStateName`
- `Blackboard` 作为主运行时状态
- `BusinessMessage` 作为通用协议中心
- Markdown 直接驱动执行状态机

新版本的核心聚合根是 `TaskFlow`，不是 `BlackboardState`。

---

## 5. P0 结论与后续

### P0 已实现

- `planFromPrompt` + `HarnessRuntime.runFlowLoop` 已落地，支持 Plan→Act→Critique→Replan。
- `FlowHandle` 已包含执行态字段并在 runtime 中持续更新。
- `waiting_approval`、依赖环检测、step critique 低置信度 replan 均已接入。

### P1（下一阶段）

- 让 `dispatchStep()` 生成更丰富的 `contextSlices`
- 让 `runStepCritique()` 消费结构化 outputs，而不只是单一文本
- 给 `replanFlow()` 增加更强的 plan diff / merge 策略

### P2（中期）

- 将 retrospective / challenger lesson 自动转为 `Proposal`
- Proposal 接入 Rollout / benchmark 验证链路

---

## 6. 当前结论

第一版已经完成了最关键的一步：

> 我们不再依赖 MVP 的旧类型体系，但已经把它最有价值的运行模式迁进了新的 `@vera/harness`。

后续工作应围绕 `HarnessRuntime` 继续扩展，而不是再回到旧的 `blackboard/session` 结构。

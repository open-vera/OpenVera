# Plan Mode — 实现指南

> 本文档对齐 [roadmap.md P0.7](../roadmap.md) 和 [agent-design.md §4](./agent-design.md#4-plan-模式plan-mode)，描述 Plan Mode 的**当前状态**、**缺失环节**和**实现路径**。

---

## 1. 当前状态（已有什么）

### `@vera/core`

| 文件 | 内容 | 状态 |
|---|---|---|
| `src/types/runtime.ts` | `ExecutionPlan`、`PlanStep`、`TaskFlow`、`StepResult`、`CritiqueResult` 等类型 | ✅ |
| `src/plan/generator.ts` | `generatePlan` — 简单 LLM 规划器（REPL 用） | ✅ |
| `src/plan/repl-runner.ts` | `defaultPlanExecutor` — REPL 环境按 Step 执行 | ✅ |
| `src/agent/loop.ts` | `runAgent` / `streamAgent` — ReAct 裸循环 | ✅ |

### `@vera/harness`

| 文件 | 内容 | 状态 |
|---|---|---|
| `src/runtime/flow.ts` | `createTaskFlow`、`checkpointFromFlow`、`updateFlowState` | ✅ |
| `src/runtime/critique.ts` | `critiquePlan`、`critiqueStep`、`replanWithCritique`、`generateRetrospective`、`diffPlans`、`mergePlans` | ✅ |
| `src/runtime/approval.ts` | `shouldPauseForApproval`、`createApprovalRecord` | ✅ |
| `src/runtime/planner.ts` | `planFromPrompt` — LLM 生成结构化 `ExecutionPlan`，含重试逻辑 | ✅ |
| `src/runtime/runtime.ts` | `HarnessRuntime` — Flow 生命周期、`runFlowLoop`（Plan→Act→Critique→Replan 闭环）、`planAndStart` 入口 | ✅ |
| `src/runtime/markdown.ts` | `readMarkdownFlow` — 从 Markdown 文件解析 Flow | ✅ |
| `src/agent/stream-runner.ts` | `StreamAgentRunner` — 默认 AgentRunner 实现 | ✅ |

### 小结

Plan Mode 的核心链路已就位：

- **CLI / Batch**：`planFromPrompt` → `startFlow` → `runFlowLoop`（HarnessRuntime 全链路）
- **REPL**：`App.tsx` intent 判定 → `createHarnessPlanExecutor`（planFromPrompt + streamAgent + critique + state machine）

两个执行路径都已接入 Harness planner、critique 和 flow state machine。

---

## 2. 当前链路

```
用户输入 → intent classifier (needs_planning?)
  ├── false → 直接 streamAgent (ReAct)
  └── true  → App.tsx 调用 planExecutor
                └── createHarnessPlanExecutor (REPL)
                      ├── planFromPrompt()      ← Harness planner
                      ├── streamAgent() per step ← 保留 streaming
                      ├── critiqueStep()         ← Harness critique
                      ├── replan via planFromPrompt ← 低置信度自动修正
                      └── flow state transitions ← assertTransition() 校验

  CLI/Batch:
  planFromPrompt → startFlow → runFlowLoop
    ├── dispatchStep → runAgentAssignment → StreamAgentRunner
    ├── runStepCritique → replanWithCritique (if low confidence)
    └── completeFlow / failFlow
```

---

## 3. 缺失的实现

### 3.1 Plan 确认交互（P1）

P0 跳过——LLM 生成 Plan 后直接执行。P1 可加入用户确认环节：展示 Plan → 用户确认/修改 → 开始执行。

### 3.2 REPL 中展示 ExecutionPlan 详情（P1）

当前 REPL 只展示 `PlanStepDef`（id + description），不展示 step type、dependsOn、risk 等 ExecutionPlan 字段。P1 可以增强 UI 展示完整 Plan 结构。

---

## 4. 触发条件

| 条件 | 触发 Plan Mode |
|---|---|
| `complexity >= L2`（意图识别） | 是 |
| 任务包含破坏性操作（delete/overwrite） | 是 |
| 用户显式传 `--plan` flag | 是 |
| 估计 turns > 6 | 是 |
| L0 / L1 纯问答任务 | 否，直接 ReAct |

---

## 5. 验收标准（对应 P0 验收）

- [x] ~~给定中等复杂任务，agent 先输出 Plan，用户确认后按 Step 执行~~（Plan 生成已实现，用户确认待 P1）
- [x] 每个 Step 执行后写入 timeline.ndjson，可回放
- [x] Step Critique 置信度低时，自动触发 replan，不直接报错
- [ ] 超出 `scope.workdir` 的操作被 harness 拦截，Plan 执行中止
- [ ] 破坏性操作（risk: high）在执行前触发 `waiting_approval` 状态
- [x] REPL 中 intent classifier 返回 `needs_planning: true` 时自动走 Plan Mode

---

## 6. 文件分工（当前）

```
packages/harness/src/runtime/
  planner.ts      ← 新增：planFromPrompt（LLM → ExecutionPlan）
  flow.ts         ← 已有：TaskFlow 管理
  critique.ts     ← 已有：Step/Plan Critique + replan
  approval.ts     ← 已有：审批门
  runtime.ts      ← 已有：HarnessRuntime + runFlowLoop + planAndStart
  markdown.ts     ← 已有：Markdown Flow 解析（用于预定义复杂流程）

packages/core/src/
  plan/generator.ts    ← 已有：简单 REPL 规划器
  plan/repl-runner.ts  ← 已有：REPL 环境 Plan 执行器
  agent/loop.ts        ← 已有：runAgent / streamAgent
  types/runtime.ts     ← 已有：所有 Runtime 类型定义
```

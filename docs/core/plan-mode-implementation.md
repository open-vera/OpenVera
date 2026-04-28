# Plan Mode — 当前实现说明

> 本文档对齐 [roadmap.md P0.7](../roadmap.md) 和 [agent-design.md §4](./agent-design.md#4-plan-模式plan-mode)，聚焦 Plan Mode 在 2026-04-28 的实际实现状态。

---

## 1. 结论

Plan Mode 的 P0 目标能力已实现：系统可以在 `needs_planning: true` 时进入 Plan 执行链路，完成 `Plan → Act → Critique → Replan` 闭环，并通过 Harness Flow 状态机管理执行状态。

---

## 2. 当前能力

### Core 层

| 文件 | 能力 |
|---|---|
| `packages/core/src/types/runtime.ts` | `ExecutionPlan` / `PlanStep` / `TaskFlow` / `StepResult` / `CritiqueResult` 协议 |
| `packages/core/src/agent/loop.ts` | `runAgent` / `streamAgent`（作为 step 执行引擎） |
| `packages/core/src/intent/classifier.ts` | `needs_planning` 触发判定 |

### Harness 层

| 文件 | 能力 |
|---|---|
| `packages/harness/src/runtime/planner.ts` | `planFromPrompt`（LLM → `ExecutionPlan`，含重试） |
| `packages/harness/src/runtime/plan-parser.ts` | JSON fence/编号列表解析与降级 |
| `packages/harness/src/runtime/runtime.ts` | `HarnessRuntime`、`runFlowLoop`、`dispatchStep`、`runAgentAssignment`、`replanFlow` |
| `packages/harness/src/runtime/flow-state.ts` | Flow 状态机 + 合法迁移校验 |
| `packages/harness/src/runtime/approval.ts` | `shouldPauseForApproval` / `createApprovalRecord` |
| `packages/harness/src/runtime/critique.ts` | `critiquePlan` / `critiqueStep` / `replanWithCritique` |

### REPL/CLI 接入

| 文件 | 能力 |
|---|---|
| `packages/harness/src/cli/repl-plan-executor.ts` | REPL 中使用 Harness planner + critique 执行计划 |
| `packages/harness/src/cli/repl-run.ts` | REPL 挂接 `createHarnessPlanExecutor` |
| `packages/harness/src/cli/flow-run.ts` | CLI/Batch 入口，驱动 HarnessRuntime |

---

## 3. 执行链路

```text
用户输入
  → intent classifier (needs_planning?)
    ├─ false: 直接走 streamAgent (ReAct)
    └─ true:
       REPL: createHarnessPlanExecutor
         planFromPrompt → step 执行(streamAgent) → critiqueStep → 低置信度 replan

       CLI/Batch: HarnessRuntime
         planFromPrompt → startFlow → runFlowLoop
           dispatchStep → runAgentAssignment → runStepCritique → (必要时) replanFlow
```

---

## 4. P0 验收对齐

- [x] 中等复杂任务进入 Plan 模式并按 step 执行
- [x] step 执行后可写入 timeline，支持回放
- [x] 低置信度 critique 可触发 replan
- [x] Flow 状态迁移有合法性校验
- [x] 高风险步骤可进入 `waiting_approval` / `paused` 路径

说明：Plan 确认交互（执行前人工确认计划）不属于 P0，保留到 P1。

---

## 5. 剩余工作（P1 与对齐项）

- Plan 执行前人工确认与编辑（human-in-the-loop UX）
- REPL 展示完整 `ExecutionPlan` 字段（type/dependsOn/risk）
- 子 agent、权限策略、session 体验等对齐项见 [capability-gaps.md](./capability-gaps.md)


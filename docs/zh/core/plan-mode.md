# Plan 模式 — 当前实现说明

> 本文档与 [roadmap.md P0.7](../roadmap.md) 和 [agent-design.md 第 4 节](./agent-design.md#4-plan-mode) 对齐，聚焦于 2026-04-28 时间点 Plan 模式的实际实现状态。

---

## 1. 概述

Plan 模式的 P0 目标已达成：系统在 `needs_planning: true` 时可进入 Plan 执行管线，完成 `Plan -> Act -> Critique -> Replan` 闭环，执行状态由 Harness Flow 状态机管理。

---

## 2. 当前能力

### Core 层

| 文件 | 能力 |
|---|---|
| `packages/core/src/types/runtime.ts` | `ExecutionPlan` / `PlanStep` / `TaskFlow` / `StepResult` / `CritiqueResult` 协议 |
| `packages/core/src/agent/loop.ts` | `runAgent` / `streamAgent`（作为步骤执行引擎） |
| `packages/core/src/intent/classifier.ts` | `needs_planning` 触发判定 |

### Harness 层

| 文件 | 能力 |
|---|---|
| `packages/harness/src/runtime/planner.ts` | `planFromPrompt`（LLM -> `ExecutionPlan`，带重试） |
| `packages/harness/src/runtime/plan-parser.ts` | JSON fence / 编号列表解析和降级 |
| `packages/harness/src/runtime/runtime.ts` | `HarnessRuntime`、`runFlowLoop`、`dispatchStep`、`runAgentAssignment`、`replanFlow` |
| `packages/harness/src/runtime/flow-state.ts` | Flow 状态机 + 合法转换校验 |
| `packages/harness/src/runtime/approval.ts` | `shouldPauseForApproval` / `createApprovalRecord` |
| `packages/harness/src/runtime/critique.ts` | `critiquePlan` / `critiqueStep` / `replanWithCritique` |

### REPL/CLI 集成

| 文件 | 能力 |
|---|---|
| `packages/harness/src/cli/repl-plan-executor.ts` | REPL 端 Plan 执行，使用 harness planner + critique |
| `packages/harness/src/cli/repl-run.ts` | REPL 接入 `createHarnessPlanExecutor` |
| `packages/harness/src/cli/flow-run.ts` | CLI/批处理入口，驱动 `HarnessRuntime` |

---

## 3. 执行管线

```text
用户输入
  -> 意图分类器 (needs_planning?)
    +- false: 直接使用 streamAgent (ReAct)
    +- true:
       REPL: createHarnessPlanExecutor
         planFromPrompt -> 步骤执行 (streamAgent) -> critiqueStep -> 低置信度时 replan

       CLI/Batch: HarnessRuntime
         planFromPrompt -> startFlow -> runFlowLoop
           dispatchStep -> runAgentAssignment -> runStepCritique -> (如有必要) replanFlow
```

---

## 4. P0 验收标准

- [x] 中等复杂度任务进入 Plan 模式并按步骤执行
- [x] 步骤执行后能写入 timeline，支持回放
- [x] 低置信度审视能触发重新规划
- [x] Flow 状态转换有合法性校验
- [x] 高风险步骤能进入 `waiting_approval` / `paused` 路径

注意：Plan 确认交互（执行前人类确认计划）不属于 P0，留给 P1。

---

## 5. 剩余工作（P1 和对齐项）

- 执行前人类确认和编辑计划（人机交互 UX）
- REPL 显示完整 `ExecutionPlan` 字段（type/dependsOn/risk）
- Sub-agent、权限策略、会话体验等对齐项——参见 [capability-gaps.md](./capability-gaps.md)

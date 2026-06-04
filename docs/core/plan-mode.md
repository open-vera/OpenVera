# Plan Mode — Current Implementation Notes

> This document aligns with [roadmap.md P0.7](../roadmap.md) and [agent-design.md section 4](./agent-design.md#4-plan-mode), focusing on the actual implementation state of Plan Mode as of 2026-04-28.

---

## 1. Summary

The P0 goals for Plan Mode have been achieved: the system can enter a Plan execution pipeline when `needs_planning: true`, completing the `Plan -> Act -> Critique -> Replan` closed loop, with execution state managed by the Harness Flow state machine.

---

## 2. Current Capabilities

### Core Layer

| File | Capability |
|---|---|
| `packages/core/src/types/runtime.ts` | `ExecutionPlan` / `PlanStep` / `TaskFlow` / `StepResult` / `CritiqueResult` protocols |
| `packages/core/src/agent/loop.ts` | `runAgent` / `streamAgent` (as step execution engine) |
| `packages/core/src/intent/classifier.ts` | `needs_planning` trigger determination |

### Harness Layer

| File | Capability |
|---|---|
| `packages/harness/src/runtime/planner.ts` | `planFromPrompt` (LLM -> `ExecutionPlan`, with retries) |
| `packages/harness/src/runtime/plan-parser.ts` | JSON fence / numbered list parsing and degradation |
| `packages/harness/src/runtime/runtime.ts` | `HarnessRuntime`, `runFlowLoop`, `dispatchStep`, `runAgentAssignment`, `replanFlow` |
| `packages/harness/src/runtime/flow-state.ts` | Flow state machine + valid transition validation |
| `packages/harness/src/runtime/approval.ts` | `shouldPauseForApproval` / `createApprovalRecord` |
| `packages/harness/src/runtime/critique.ts` | `critiquePlan` / `critiqueStep` / `replanWithCritique` |

### REPL/CLI Integration

| File | Capability |
|---|---|
| `packages/harness/src/cli/repl-plan-executor.ts` | REPL-side Plan execution using harness planner + critique |
| `packages/harness/src/cli/repl-run.ts` | REPL hooks into `createHarnessPlanExecutor` |
| `packages/harness/src/cli/flow-run.ts` | CLI/Batch entry point, drives `HarnessRuntime` |

---

## 3. Execution Pipeline

```text
User input
  -> intent classifier (needs_planning?)
    +- false: directly use streamAgent (ReAct)
    +- true:
       REPL: createHarnessPlanExecutor
         planFromPrompt -> step execution (streamAgent) -> critiqueStep -> replan on low confidence

       CLI/Batch: HarnessRuntime
         planFromPrompt -> startFlow -> runFlowLoop
           dispatchStep -> runAgentAssignment -> runStepCritique -> (if needed) replanFlow
```

---

## 4. P0 Acceptance Criteria

- [x] Medium-complexity tasks enter Plan mode and execute step by step
- [x] Steps can write to timeline after execution, supporting replay
- [x] Low-confidence critique can trigger replanning
- [x] Flow state transitions have validity checks
- [x] High-risk steps can enter `waiting_approval` / `paused` path

Note: Plan confirmation interaction (human confirms plan before execution) is not part of P0 and is reserved for P1.

---

## 5. Remaining Work (P1 and Alignment Items)

- Pre-execution human confirmation and editing of plans (human-in-the-loop UX)
- REPL display of full `ExecutionPlan` fields (type/dependsOn/risk)
- Sub-agent, permission policies, session experience alignment items — see [capability-gaps.md](./capability-gaps.md)

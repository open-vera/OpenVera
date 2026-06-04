# Harness Runtime Implementation

> This document describes the v1 implementation boundary of `packages/harness/src/runtime/` and how it inherits the operating model of `multi-agent-mvp`.

---

## 1. Current Goals (Completed)

The migration from the MVP operating model to the current `@vera/harness` is complete. The core goal was establishing a working Plan -> Act -> Critique -> Replan closed loop:

- `Plan Challenge`
- `Step Challenge`
- `Approval`
- `Timeline / Artifact`
- `Proposal` entry point

Migration principles:

1. Migrate the operating model, not the old types
2. Use `@vera/core/src/types/runtime.ts` as the unified protocol
3. `.vera/flows` Markdown serves only as the input configuration layer
4. Retrospective / challenger lessons ultimately enter the Proposal Pipeline

---

## 2. New Module Structure

Located in `packages/harness/src/runtime`:

- `runtime.ts`
  V1 `HarnessRuntime` class
- `critique.ts`
  `Plan` / `Step` critique execution and old challenge result adaptation
- `flow-config/parser.ts`
  `.vera/flows/flow/<name>/main.md`, `stages/*/main.md`, `agents/*/main.md` input parsing
- `flow.ts`
  `TaskFlow` / `Checkpoint` assembly
- `approval.ts`
  Approval record abstraction
- `timeline.ts`
  timeline.ndjson writing
- `artifacts.ts`
  Artifact persistence
- `proposal.ts`
  Proposal generation entry point

---

## 3. Implemented Capabilities

### 3.1 `HarnessRuntime`

`runtime.ts` currently provides:

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

### 3.2 Operating Model Migration Status

| MVP Capability | New Implementation Status |
|---------------|--------------------------|
| `planFlow -> challengePlan` | Migrated to `runPlanCritique()` |
| `executeStep -> challengeStep` | Migrated to `runStepCritique()` |
| `step dispatch -> agent run` | Migrated to `dispatchStep()` + `runAgentAssignment()` |
| Minimum auto closed-loop | Migrated to `runFlowLoop()` |
| `critique -> replan` | Migrated to `replanFlow()` and integrated into `runFlowLoop()` |
| Human approval | Migrated to `recordApproval()` |
| `timeline.ndjson` | Migrated to `appendTimeline()` |
| Artifact persistence | Migrated to `writeArtifact()` |
| retrospective -> lesson | Has `createProposal()` entry point |

---

## 4. Relationship with MVP

### 4.1 What Was Kept

- Adversarial review philosophy
- Plan-first challenge, step-after challenge
- Artifact persistence
- Timeline event recording
- Human approval insertion points

### 4.2 What Was Discarded

- Old `FSMStateName`
- `Blackboard` as the primary runtime state
- `BusinessMessage` as the universal protocol center
- Markdown directly driving the execution state machine

The new version's core aggregate root is `TaskFlow`, not `BlackboardState`.

---

## 5. P0 Conclusions and Next Steps

### P0 Implemented

- `planFromPrompt` + `HarnessRuntime.runFlowLoop` are in place, supporting Plan -> Act -> Critique -> Replan.
- `FlowHandle` includes execution state fields and is continuously updated in the runtime.
- `waiting_approval`, dependency cycle detection, and step critique low-confidence replan are all integrated.

### P1 (Next Phase)

- Have `dispatchStep()` generate richer `contextSlices`
- Have `runStepCritique()` consume structured outputs, not just single text
- Add stronger plan diff / merge strategies to `replanFlow()`

### P2 (Mid-term)

- Auto-convert retrospective / challenger lessons into `Proposal`
- Connect Proposals to the Rollout / benchmark verification pipeline

---

## 6. Current Conclusion

The v1 has accomplished the most critical step:

> We no longer depend on the MVP's old type system, but we have migrated its most valuable operating model into the new `@vera/harness`.

Future work should expand around `HarnessRuntime`, not return to the old `blackboard/session` structure.

# Runtime Implementation Design

> Goal: Turn "Harness is the system scheduling and planning layer, Agent is the execution layer" into an implementable runtime protocol, not just a conceptual document.

---

## 1. Design Objectives

This version of the runtime design first solves 3 problems:

1. Use unified types to describe `Flow / Plan / Step / Critique / Proposal / Checkpoint`
2. Make `packages/core` the runtime common protocol layer
3. Leave clear attachment points for the subsequent `packages/harness` scheduling implementation

The current version is the **initial interface**. The goal is to unify the protocol first, not to build the complete runtime here.

---

## 2. Layering

### 2.1 `packages/core`

Responsible for common runtime types:

- Flow
- Plan
- Step
- Assignment
- Critique
- Proposal
- Checkpoint
- Event / Artifact

No specific scheduling logic here — only the protocol.

### 2.2 `packages/harness`

Responsible for system runtime logic:

- `startFlow`
- `dispatch`
- `critique`
- `approve`
- `resume`
- `replay`
- `rollout`

That is, actually running the `core` protocol.

### 2.3 `packages/core/src/agent`

Responsible for the agent execution loop:

- Accept `AgentAssignment`
- Call model and tools
- Produce `StepResult`
- Optionally include local self-check

---

## 3. Runtime Model

### 3.1 The Top-Level Object Is Flow

Flow represents a task execution instance and is the most important aggregate root of the runtime.

A Flow contains at minimum:

- `flowId`
- `goal`
- `state`
- `plan`
- `scope`
- `budget`
- `loopCount`
- `artifacts`

### 3.2 Harness Controls Flow State

Recommended state machine:

```ts
type HarnessState =
  | "intaking"
  | "planning"
  | "dispatching"
  | "executing"
  | "waiting_tool"
  | "waiting_approval"
  | "critiquing"
  | "replanning"
  | "paused"
  | "completed"
  | "failed";
```

Key points:

- State belongs to the harness, not the agent
- The agent can only return results; it cannot directly modify the Flow State

### 3.3 Plan and Step Are the Structured Execution Layer

Plan is the Flow's execution scheme; Step is the smallest execution unit.

Harness responsibilities:

- Generate or accept a Plan
- Determine the currently active Step
- Dispatch a Step as an `AgentAssignment`
- Decide the next action based on `CritiqueResult`

### 3.4 Critique Is a Structured Control Signal

Critique is not an add-on note but a Flow branching condition.

At minimum it must answer:

- What is the confidence level
- What problems exist
- Is the next action `complete / replan / retry / ask_human`

### 3.5 Proposal Is the Evolution Interface

Proposal does not directly modify the system. Instead, it converts problems found by critique / dreaming / benchmark into review-pending proposals.

Proposal Pipeline:

```
Discover problem
  -> Generate Proposal
  -> Human review
  -> Rollout
  -> Benchmark validation
```

---

## 4. Initial Type Boundaries

### 4.1 What Goes in `runtime.ts`

Initial common types recommended:

- Base enums: state / status / artifact type
- Constraint types: `TaskScope`, `BudgetState`
- Plan types: `ExecutionPlan`, `PlanStep`
- Execution types: `AgentAssignment`, `StepResult`
- Control types: `CritiqueResult`, `PendingAction`
- Recovery types: `FlowCheckpoint`
- Evolution types: `PolicyProposal`
- Event types: `RuntimeEvent`

### 4.2 What Does NOT Go In (Yet)

The following are kept out of common types for now, to avoid prematurely locking in implementations:

- Specific storage backend interfaces
- Queue / scheduler implementation
- Approval UI protocol
- Rollout strategy details
- Full benchmark case schema details

---

## 5. Subsequent Implementation Order

### Step 1

Land `packages/core/src/types/runtime.ts` and export from `types/index.ts`.

### Step 2

Add a runtime interface shell in `packages/harness`, e.g.:

```ts
interface HarnessRuntime {
  startFlow(input: StartFlowInput): Promise<FlowHandle>;
  resumeFlow(flowId: string): Promise<FlowHandle>;
  approve(flowId: string, decision: ApprovalDecision): Promise<void>;
  replayFlow(flowId: string): Promise<ReplayResult>;
}
```

### Step 3

Make `agent/loop.ts` support receiving `AgentAssignment`, not just a plain string user message.

### Step 4

Wire in a minimal state machine in `packages/harness`:

- `planning`
- `dispatching`
- `executing`
- `critiquing`
- `completed`

---

## 6. Current Deliverables

Delivered in this batch:

- `packages/core/src/types/runtime.ts`
- `packages/core/src/types/index.ts`

This way, when the harness runtime is implemented later, the protocol already has a unified anchor point — no need to reverse-engineer from documents.

import type {
  ArtifactRecord,
  BudgetState,
  ExecutionPlan,
  FlowCheckpoint,
  TaskFlow,
  TaskScope,
} from "@vera/core/types";
import type { CreateCheckpointInput, StartFlowInput } from "./internal.js";
import { transitionFlow } from "./flow-state.js";

export function createTaskFlow(input: StartFlowInput): TaskFlow {
  const budget: BudgetState = {
    tokenBudget: input.scope?.budgetTokens,
    usdBudget: input.scope?.budgetUsd,
    tokensUsed: 0,
    usdUsed: 0,
  };

  return {
    flowId: input.flowId,
    goal: input.goal,
    state: "planning",
    plan: input.plan,
    activeStepId: input.plan.steps[0]?.id,
    loopCount: 0,
    maxLoops: input.maxLoops ?? 3,
    budget,
    scope: input.scope ?? {},
    assignedAgents: [],
    artifacts: [],
  };
}

export function checkpointFromFlow(
  input: CreateCheckpointInput
): FlowCheckpoint {
  return {
    checkpointId: input.checkpointId,
    flowId: input.flow.flowId,
    state: input.flow.state,
    plan: input.flow.plan,
    activeStepId: input.flow.activeStepId,
    loopCount: input.flow.loopCount,
    budget: input.flow.budget,
    scope: input.flow.scope,
    artifacts: input.artifacts,
  };
}

export function updateFlowState(
  flow: TaskFlow,
  state: TaskFlow["state"]
): TaskFlow {
  return transitionFlow(flow, state);
}

export function attachArtifacts(
  flow: TaskFlow,
  artifacts: ArtifactRecord[]
): TaskFlow {
  return { ...flow, artifacts: [...flow.artifacts, ...artifacts] };
}

export function createScope(scope?: TaskScope): TaskScope {
  return scope ?? {};
}

export function planToArtifact(plan: ExecutionPlan): ArtifactRecord {
  return {
    id: `plan-${plan.planId}`,
    type: "plan",
    summary: plan.goal,
  };
}

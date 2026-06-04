import type { ExecutionPlan } from "@open-vera/core/types";
import type { FlowDefinition, FlowStageRef, StageDefinition } from "../flow-config/index.js";

/**
 * Convert a parsed FlowDefinition into an ExecutionPlan.
 * Stage dependencies come directly from flow/<name>/main.md, so independent stages
 * can be dispatched in parallel by the runtime.
 */
export function flowDefinitionToPlan(input: FlowDefinition, flowId: string): ExecutionPlan {
  return {
    planId: flowId,
    goal: input.goal,
    assumptions: [],
    steps: input.stages.map((step) => ({
      id: step.id,
      type: "delegate" as const,
      action: buildStageInstruction(step, input.stageDefinitions.get(step.stage)),
      dependsOn: step.dependsOn,
      assignedAgent: resolveStageAgents(step, input.stageDefinitions.get(step.stage))[0],
      status: "pending" as const,
    })),
    risk: "medium" as const,
  };
}

function buildStageInstruction(step: FlowStageRef, definition?: StageDefinition): string {
  const agents = resolveStageAgents(step, definition);
  const lines = [
    `Execute stage "${definition?.name ?? step.stage}"`,
    ``,
    `Stage id: ${step.id}`,
    `Stage definition: ${step.stage}`,
  ];
  if (agents.length) lines.push(`Agents: ${agents.join(", ")}`);
  if (definition?.body) lines.push(``, definition.body);
  return lines.join("\n");
}

function resolveStageAgents(step: FlowStageRef, definition?: StageDefinition): string[] {
  return step.agents.length > 0 ? step.agents : definition?.agents ?? [];
}

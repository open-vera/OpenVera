import type { ExecutionPlan } from "@vera/core/types";
import type { MarkdownFlowInput } from "../runtime/internal.js";

/**
 * Convert a parsed MarkdownFlowInput into an ExecutionPlan.
 * Steps are chained sequentially (each depends on the previous).
 */
export function markdownToPlan(input: MarkdownFlowInput, flowId: string): ExecutionPlan {
  const goal = extractGoal(input.rawFlowBody);
  return {
    planId: flowId,
    goal,
    assumptions: [],
    steps: input.steps.map((step, i) => ({
      id: step.dir,
      type: "delegate" as const,
      action:
        `Execute "${step.name}"` +
        (step.agents.length ? ` — agents: ${step.agents.join(", ")}` : ""),
      dependsOn: i > 0 ? [input.steps[i - 1]!.dir] : [],
      assignedAgent: step.agents[0],
      status: "pending" as const,
    })),
    risk: "medium" as const,
  };
}

function extractGoal(body: string): string {
  // Look for a "# 目标" / "# Goal" section and take its first non-empty line
  const match = body.match(/^#\s+(?:目标|Goal)\s*\n([\s\S]*?)(?=\n#|$)/m);
  if (match) {
    const first = match[1]!.split("\n").find((l) => l.trim());
    if (first) return first.trim();
  }
  // Fallback: first non-heading non-blank line
  const first = body.split("\n").find((l) => l.trim() && !l.startsWith("#"));
  return first?.trim() ?? "Execute flow";
}

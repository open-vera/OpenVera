import type { LLMAdapter } from "@open-vera/core/adapters";
import type { AgentAssignment, StepResult } from "@open-vera/core/types";
import type { RunAssignmentOptions, StepCritiqueInput } from "../runtime/internal.js";
import type { AgentRunner } from "./types.js";
import { critiqueStep } from "../runtime/critique.js";

export interface CritiqueRunnerOptions {
  /** Default challenge prompt appended to every critique. */
  defaultChallengePrompt?: string;
}

/**
 * CritiqueRunner — an AgentRunner that critiques step execution outputs.
 *
 * Instead of executing a task, it reviews the outputs from prior steps
 * using the critique pipeline (build prompt → LLM → parse CritiqueResult).
 *
 * Conventions for the AgentAssignment:
 *  - instruction: the step definition / what should have been done
 *  - contextSlices[0]: the main output to critique
 *  - contextSlices[1..]: additional context (plan steps, prior critiques, etc.)
 *
 * Register as "critique" (or any name) in the AgentRunnerMap to use it
 * as the target of plan steps with type "critique".
 */
export class CritiqueRunner implements AgentRunner {
  constructor(
    private readonly adapter: LLMAdapter,
    private readonly model: string,
    private readonly opts: CritiqueRunnerOptions = {}
  ) {}

  async run(
    assignment: AgentAssignment,
    _options: RunAssignmentOptions
  ): Promise<StepResult> {
    const outputs: Record<string, string> = {};

    if (assignment.contextSlices.length > 0) {
      outputs["output"] = assignment.contextSlices[0];
    }
    for (let i = 1; i < assignment.contextSlices.length; i++) {
      outputs[`context_${i}`] = assignment.contextSlices[i];
    }

    const input: StepCritiqueInput = {
      stepName: assignment.stepId,
      goal: assignment.goal,
      stepReadme: assignment.instruction,
      customChallengePrompt: this.opts.defaultChallengePrompt,
      outputs,
    };

    const result = await critiqueStep(this.adapter, this.model, input);

    const output = [
      `# Critique: ${assignment.stepId}`,
      ``,
      `**confidence**: ${result.critique.confidence}`,
      `**nextAction**: ${result.critique.nextAction}`,
      ``,
      `## Issues`,
      ...(result.critique.issues.length > 0
        ? result.critique.issues.map((i) => `- ${i}`)
        : ["(none)"]),
      ``,
      `## Missing Checks`,
      ...(result.critique.missingChecks.length > 0
        ? result.critique.missingChecks.map((c) => `- ${c}`)
        : ["(none)"]),
      ``,
      `## Rationale`,
      result.critique.rationale,
    ].join("\n");

    return {
      flowId: assignment.flowId,
      stepId: assignment.stepId,
      output,
      toolCalls: [],
    };
  }
}

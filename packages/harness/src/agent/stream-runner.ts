import type { LLMAdapter } from "@vera/core/adapters";
import type { AgentAssignment, StepResult } from "@vera/core/types";
import type { RunAssignmentOptions } from "../runtime/internal.js";
import type { AgentRunner } from "./types.js";

function buildAssignmentPrompt(assignment: AgentAssignment): string {
  const context =
    assignment.contextSlices.length > 0
      ? assignment.contextSlices
          .map((slice, index) => `## Context ${index + 1}\n${slice}`)
          .join("\n\n")
      : "(none)";

  return [
    `# Goal`,
    assignment.goal,
    ``,
    `# Instruction`,
    assignment.instruction,
    ``,
    `# Scope`,
    `- workdir: ${assignment.scope.workdir ?? "(none)"}`,
    `- readonlyMode: ${assignment.scope.readonlyMode ?? false}`,
    ``,
    `# Context`,
    context,
  ].join("\n");
}

/**
 * Default agent runner — wraps core's streamAgent loop.
 */
export class StreamAgentRunner implements AgentRunner {
  constructor(
    private readonly adapter: LLMAdapter,
    private readonly model: string
  ) {}

  async run(
    assignment: AgentAssignment,
    options: RunAssignmentOptions
  ): Promise<StepResult> {
    const { streamAgent } = await import("@vera/core/agent");

    const prompt = buildAssignmentPrompt(assignment);
    const toolCalls: StepResult["toolCalls"] = [];

    const agentPromise = streamAgent(
      prompt,
      {
        adapter: this.adapter,
        model: this.model,
        tools: options.tools,
        system: options.system,
        maxTurns: options.maxTurns,
        onToolCall: async (name: string, args: Record<string, unknown>) => {
          let result: string;
          if (options.executors?.has(name)) {
            result = await options.executors.get(name)!(args);
          } else if (options.onToolCall) {
            result = await options.onToolCall(name, args);
          } else {
            result = `Tool "${name}" called (no executor registered)`;
          }
          toolCalls.push({ name, arguments: args, result });
          return result;
        },
      },
      () => {}
    );

    const deadlineMs = assignment.scope.deadlineMs;
    let output: string;

    if (deadlineMs && deadlineMs > 0) {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Step "${assignment.stepId}" exceeded deadline of ${deadlineMs}ms`
              )
            ),
          deadlineMs
        )
      );
      output = await Promise.race([agentPromise, timeoutPromise]);
    } else {
      output = await agentPromise;
    }

    return {
      flowId: assignment.flowId,
      stepId: assignment.stepId,
      output,
      toolCalls,
    };
  }
}

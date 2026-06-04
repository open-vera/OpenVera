import type { LLMAdapter } from "@open-vera/core/adapters";
import type { AgentAssignment, StepResult } from "@open-vera/core/types";
import type { RunAssignmentOptions } from "../runtime/internal.js";
import type { AgentRunner } from "./types.js";
import { createLogger } from "@open-vera/logger";

const log = createLogger("harness:stream-runner");

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
    const startMs = Date.now();
    const { streamAgent } = await import("@open-vera/core/agent");
    const bundle = assignment.assignedAgent
      ? options.agentSkillBundles?.[assignment.assignedAgent]
      : undefined;
    const tools = bundle?.tools ?? options.tools;
    const system = bundle?.system ?? options.system;
    const executors = bundle?.executors ?? options.executors;

    const prompt = buildAssignmentPrompt(assignment);
    const toolCalls: StepResult["toolCalls"] = [];

    log.debug("stream-runner start", { stepId: assignment.stepId, goal: assignment.goal.slice(0, 80) });

    const agentPromise = streamAgent(
      prompt,
      {
        adapter: this.adapter,
        model: this.model,
        tools,
        system,
        maxTurns: options.maxTurns,
        onToolCall: async (name: string, args: Record<string, unknown>) => {
          let result: string;
          if (executors?.has(name)) {
            result = await executors.get(name)!(args);
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

    log.debug("stream-runner done", { stepId: assignment.stepId, outputLen: output.length, toolCalls: toolCalls.length, duration_ms: Date.now() - startMs });

    return {
      flowId: assignment.flowId,
      stepId: assignment.stepId,
      output,
      toolCalls,
    };
  }
}

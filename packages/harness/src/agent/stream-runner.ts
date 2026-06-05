import type { LLMAdapter, LlmPurpose, LlmRequestOptions } from "@open-vera/core/adapters";
import type { CompletionRequest, StreamEvent, AgentAssignment, StepResult } from "@open-vera/core/types";
import type { ToolContext, ToolResult } from "@open-vera/core/tools";
import type { RunAssignmentOptions } from "../runtime/internal.js";
import type { AgentRunner } from "./types.js";
import { createLogger } from "@open-vera/logger";

const log = createLogger("harness:stream-runner");

export interface LlmServiceLike {
  stream(request: CompletionRequest, options?: LlmRequestOptions): AsyncIterable<StreamEvent>;
  buildAdapter?(provider?: string, model?: string, options?: { purpose?: LlmPurpose }): LLMAdapter;
  complete?(request: CompletionRequest, options?: LlmRequestOptions): Promise<unknown>;
  listModels?(): Promise<unknown[]>;
  resolveModel?(options?: LlmRequestOptions): { provider: string; model: string };
  selectAdapter?(options?: LlmRequestOptions): unknown;
}

export interface ToolHostLike {
  execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface StreamAgentRunnerServices {
  llm: LlmServiceLike;
  model: string;
  provider?: string;
  purpose?: LlmPurpose;
  toolHost?: ToolHostLike;
  toolContext?: Partial<ToolContext>;
}

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
  private readonly adapter: LLMAdapter;
  private readonly model: string;
  private readonly llmService?: LlmServiceLike;
  private readonly provider?: string;
  private readonly toolHost?: ToolHostLike;
  private readonly toolContext?: Partial<ToolContext>;

  constructor(adapter: LLMAdapter, model: string);
  constructor(services: StreamAgentRunnerServices);
  constructor(adapterOrServices: LLMAdapter | StreamAgentRunnerServices, model?: string) {
    if (isStreamRunnerServices(adapterOrServices)) {
      this.model = adapterOrServices.model;
      this.llmService = adapterOrServices.llm;
      this.provider = adapterOrServices.provider;
      this.adapter = llmServiceAdapter(adapterOrServices.llm, {
        provider: adapterOrServices.provider,
        model: adapterOrServices.model,
        purpose: adapterOrServices.purpose ?? "chat",
      });
      this.toolHost = adapterOrServices.toolHost;
      this.toolContext = adapterOrServices.toolContext;
    } else {
      this.adapter = adapterOrServices;
      this.model = model ?? "";
    }
  }

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
    const toolHost = options.toolHost ?? this.toolHost;

    const prompt = buildAssignmentPrompt(assignment);
    const toolCalls: StepResult["toolCalls"] = [];

    log.debug("stream-runner start", { stepId: assignment.stepId, goal: assignment.goal.slice(0, 80) });

    const agentPromise = streamAgent(
      prompt,
      {
        adapter: this.adapter,
        model: this.model,
        sessionId: `${assignment.flowId}:${assignment.stepId}`,
        traceId: assignment.stepId,
        ...(hasBuildAdapter(this.llmService) ? {
          llmService: this.llmService,
          compressionProvider: this.provider,
        } : {}),
        tools,
        system,
        maxTurns: options.maxTurns,
        onToolCall: async (name: string, args: Record<string, unknown>) => {
          let result: string;
          if (executors?.has(name)) {
            result = await executors.get(name)!(args);
          } else if (toolHost) {
            const toolResult = await toolHost.execute(name, args, {
              cwd: assignment.scope.workdir ?? process.cwd(),
              sessionId: `${assignment.flowId}:${assignment.stepId}`,
              ...this.toolContext,
              ...options.toolContext,
            });
            result = toolResult.content;
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

function llmServiceAdapter(llm: LlmServiceLike, requestOptions: LlmRequestOptions): LLMAdapter {
  return {
    complete: async () => {
      throw new Error("StreamAgentRunner requires a streaming LLM service");
    },
    stream: (request) => llm.stream(request, requestOptions),
    listModels: llm.listModels ? () => llm.listModels!() as Promise<never[]> : undefined,
  };
}

function isStreamRunnerServices(value: LLMAdapter | StreamAgentRunnerServices): value is StreamAgentRunnerServices {
  return typeof (value as StreamAgentRunnerServices).llm?.stream === "function";
}

function hasBuildAdapter(value: LlmServiceLike | undefined): value is LlmServiceLike & Required<Pick<LlmServiceLike, "buildAdapter">> {
  return typeof value?.buildAdapter === "function";
}

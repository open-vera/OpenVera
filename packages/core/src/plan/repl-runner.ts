import type { LLMAdapter } from "../adapters/base.js";
import type { Tool, Usage, Message } from "../types/index.js";
import type { ToolResult } from "../tools/types.js";
import { streamAgent, type AgentOptions } from "../agent/loop.js";
import { generatePlan, type PlanStepDef } from "./generator.js";

// ── Public types ──────────────────────────────────────────────────────────────

export type { PlanStepDef };

export interface PlanStepUI {
  id: string;
  description: string;
  status: "pending" | "running" | "done" | "failed";
  content: string;
  toolUses: Array<{ name: string; args: Record<string, unknown>; result: ToolResult }>;
}

export type PlanEvent =
  | { type: "plan_ready"; steps: PlanStepDef[] }
  | { type: "step_start"; stepIndex: number; total: number }
  | { type: "step_text"; delta: string }
  | { type: "step_tool"; name: string; args: Record<string, unknown>; result: ToolResult }
  | { type: "step_done"; stepIndex: number; output: string }
  | { type: "plan_done" }
  | { type: "plan_error"; error: string };

export interface PlanRunContext {
  adapter: LLMAdapter;
  model: string;
  tools: Tool[];
  system: string;
  /**
   * Called for each tool invocation. Returns the full ToolResult so the
   * runner can emit step_tool events with rich metadata for the UI.
   */
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  signal: AbortSignal;
  /** Directory for persisting large tool results (enables compression). */
  runDir?: string;
  /** Model-facing history to continue from before the plan starts. */
  history?: Message[];
  maxTurns?: AgentOptions["maxTurns"];
  llmService?: AgentOptions["llmService"];
  contextOptions?: AgentOptions["contextOptions"];
  compressionOptions?: AgentOptions["compressionOptions"];
  compressionProvider?: AgentOptions["compressionProvider"];
  microCompactOptions?: AgentOptions["microCompactOptions"];
  compressionState?: AgentOptions["compressionState"];
  microCompactState?: AgentOptions["microCompactState"];
  memoryTracker?: AgentOptions["memoryTracker"];
  scannedMemoryFiles?: AgentOptions["scannedMemoryFiles"];
  onMemorySelected?: AgentOptions["onMemorySelected"];
  onContextUpdate?: AgentOptions["onContextUpdate"];
}

export type PlanExecutor = (
  goal: string,
  ctx: PlanRunContext,
  onEvent: (event: PlanEvent) => void,
  onUsage: (usage: Usage) => void,
) => Promise<void>;

// ── Default executor (no critique) ───────────────────────────────────────────

/**
 * Default REPL plan executor: generates a plan, then runs each step via
 * streamAgent. No critique/replan — harness can inject a richer executor.
 */
export const defaultPlanExecutor: PlanExecutor = async (
  goal,
  ctx,
  onEvent,
  onUsage,
) => {
  // 1. Generate plan
  let steps: PlanStepDef[];
  try {
    steps = await generatePlan(goal, ctx.adapter, ctx.model);
  } catch (err) {
    onEvent({ type: "plan_error", error: `规划失败：${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  onEvent({ type: "plan_ready", steps });

  // 2. Execute each step, chaining history so later steps have prior context
  let history: Message[] = [...(ctx.history ?? [])];

  for (let i = 0; i < steps.length; i++) {
    if (ctx.signal.aborted) return;

    const step = steps[i];
    onEvent({ type: "step_start", stepIndex: i, total: steps.length });

    const stepPrompt = [
      `总目标：${goal}`,
      ``,
      `当前步骤（${i + 1}/${steps.length}）：${step.description}`,
      history.length > 0
        ? `\n（前面步骤的输出已包含在对话历史中，可作为上下文参考）`
        : "",
    ].join("\n");

    let stepOutput: string;
    try {
      stepOutput = await streamAgent(
        stepPrompt,
        {
          adapter: ctx.adapter,
          model: ctx.model,
          tools: ctx.tools,
          system: ctx.system,
          history,
          maxTurns: ctx.maxTurns,
          llmService: ctx.llmService,
          onUsage,
          signal: ctx.signal,
          runDir: ctx.runDir,
          contextOptions: ctx.contextOptions,
          compressionOptions: ctx.compressionOptions,
          compressionProvider: ctx.compressionProvider,
          microCompactOptions: ctx.microCompactOptions,
          compressionState: ctx.compressionState,
          microCompactState: ctx.microCompactState,
          memoryTracker: ctx.memoryTracker,
          scannedMemoryFiles: ctx.scannedMemoryFiles,
          onMemorySelected: ctx.onMemorySelected,
          onContextUpdate: ctx.onContextUpdate
            ? (messages, update) => {
                history = messages;
                ctx.onContextUpdate?.(messages, update);
              }
            : undefined,
          onToolCall: async (name, args) => {
            const result = await ctx.onToolCall(name, args);
            onEvent({ type: "step_tool", name, args, result });
            return result.content;
          },
        },
        (delta) => onEvent({ type: "step_text", delta }),
      );
    } catch (err) {
      if (ctx.signal.aborted) return;
      onEvent({ type: "plan_error", error: err instanceof Error ? err.message : String(err) });
      return;
    }

    if (!ctx.onContextUpdate) {
      history.push(
        { role: "user", content: stepPrompt },
        { role: "assistant", content: stepOutput },
      );
    }
    onEvent({ type: "step_done", stepIndex: i, output: stepOutput });
  }

  onEvent({ type: "plan_done" });
};

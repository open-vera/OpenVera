import type { LLMAdapter } from "@open-vera/core/adapters";
import { streamAgent } from "@open-vera/core/agent";
import { classifyIntent, shouldPlan, type IntentResult } from "@open-vera/core/intent";
import type { PlanEvent } from "@open-vera/core/plan";
import type { Message, Tool, Usage } from "@open-vera/core/types";
import type { ToolResult } from "@open-vera/core/tools";
import { createHarnessPlanExecutor } from "./plan-executor.js";

export type InteractiveTurnMode = "direct_stream" | "harness_plan";

export interface InteractiveTurnRouting {
  intent: IntentResult;
  executionMode: InteractiveTurnMode;
}

export interface InteractiveTurnOptions {
  message: string;
  adapter: LLMAdapter;
  model: string;
  tools: Tool[];
  system: string;
  history?: Message[];
  maxTurns?: number;
  signal: AbortSignal;
  llmService?: import("@open-vera/core/agent").AgentLlmServiceLike;
  compressionProvider?: string;
  classifier?: {
    adapter: LLMAdapter;
    model: string;
  };
  onUsage?: (usage: Usage) => void;
  onDelta: (delta: string) => void;
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  onPlanEvent?: (event: PlanEvent) => void;
  onRouting?: (routing: InteractiveTurnRouting) => void;
}

export interface InteractiveTurnResult {
  text: string;
  routing: InteractiveTurnRouting;
}

const SIMPLE_CHAT_PATTERN =
  /^(hi|hello|hey|hey\s+boy|你好|您好|嗨|哈喽|hello[!.！。]*|hi[!.！。]*|hey[!.！。]*)$/i;

function classifySimpleChat(message: string): IntentResult | null {
  const normalized = message.trim();
  if (!SIMPLE_CHAT_PATTERN.test(normalized)) return null;
  return {
    level: 0,
    needs_tools: false,
    needs_planning: false,
    domain: "chat",
    reason: "simple greeting",
  };
}

function fallbackIntentForClassificationError(message: string): IntentResult {
  const looksLikeCode = /```|#!\/|;\s*\n|function\s+|class\s+|import\s+|export\s+|const\s+|let\s+|var\s+/.test(message);
  return {
    level: 2,
    needs_tools: true,
    needs_planning: false,
    domain: looksLikeCode ? "code" : "other",
    reason: "classification failed fallback",
  };
}

async function classifyInteractiveIntent(
  options: InteractiveTurnOptions,
  classifier: { adapter: LLMAdapter; model: string },
): Promise<IntentResult> {
  const simple = classifySimpleChat(options.message);
  if (simple) return simple;
  try {
    return await classifyIntent(
      options.message,
      classifier.adapter,
      classifier.model,
      options.onUsage,
    );
  } catch {
    return fallbackIntentForClassificationError(options.message);
  }
}

/**
 * Shared interactive turn runner for hosts that need REPL-like behavior.
 *
 * The turn is classified first. Simple turns stream directly through Core's
 * agent loop; complex planning turns use the Harness plan executor.
 */
export async function runInteractiveTurn(
  options: InteractiveTurnOptions,
): Promise<InteractiveTurnResult> {
  const classifier = options.classifier ?? {
    adapter: options.adapter,
    model: options.model,
  };
  const intent = await classifyInteractiveIntent(options, classifier);
  const executionMode: InteractiveTurnMode = shouldPlan(intent)
    ? "harness_plan"
    : "direct_stream";
  const routing = { intent, executionMode };
  options.onRouting?.(routing);

  let text = "";
  if (executionMode === "harness_plan") {
    const planExecutor = createHarnessPlanExecutor(options.adapter, options.model);
    let planError: string | undefined;
    await planExecutor(
      options.message,
      {
        adapter: options.adapter,
        model: options.model,
        history: options.history,
        tools: options.tools,
        maxTurns: options.maxTurns,
        system: options.system,
        signal: options.signal,
        llmService: options.llmService,
        compressionProvider: options.compressionProvider,
        onToolCall: options.onToolCall,
      },
      (event) => {
        if (event.type === "step_text") {
          text += event.delta;
        } else if (event.type === "plan_error") {
          planError = event.error;
        }
        options.onPlanEvent?.(event);
      },
      (usage) => options.onUsage?.(usage),
    );
    if (planError) throw new Error(planError);
    return { text, routing };
  }

  text = await streamAgent(
    options.message,
    {
      adapter: options.adapter,
      model: options.model,
      history: options.history,
      tools: options.tools,
      maxTurns: options.maxTurns,
      system: options.system,
      signal: options.signal,
      llmService: options.llmService,
      compressionProvider: options.compressionProvider,
      onUsage: options.onUsage,
      onToolCall: async (name, args) => {
        const result = await options.onToolCall(name, args as Record<string, unknown>);
        return result.content;
      },
    },
    options.onDelta,
  );
  return { text, routing };
}

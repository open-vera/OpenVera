import type { IntentResult } from "../../intent/classifier.js";
import type { ToolResult } from "../../tools/types.js";
import type { PlanStepUI } from "../../plan/index.js";

export type { PlanStepUI };

export type StreamStatus = "idle" | "thinking" | "planning" | "streaming";

export interface TokenUsage {
  inputTotal: number;
  outputTotal: number;
  cacheWriteTotal: number;
  cacheReadTotal: number;
  costUsd: number;
}

export interface RoutingInfo {
  provider: string;
  model: string;
  intent: IntentResult | null;
}

export interface ToolUse {
  name: string;
  args: Record<string, unknown>;
  result: ToolResult;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  toolUses?: ToolUse[];
  /** Plan mode — set when executing a multi-step plan */
  planMode?: boolean;
  planSteps?: PlanStepUI[];
  activeStepIndex?: number;
}

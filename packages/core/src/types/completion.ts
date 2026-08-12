// 核心协议：请求与响应

import type { Message } from "./message.js";
import type { Tool } from "./tool.js";

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop";

export interface CompletionRequest {
  model: string;
  messages: Message[];
  tools?: Tool[];
  max_tokens?: number;
  temperature?: number;
  system?: string;
  signal?: AbortSignal;
  thinking_budget?: number;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  reasoning_tokens?: number;
  /**
   * When true, cache_* counts are already included in `input_tokens`
   * (OpenAI / DeepSeek prompt_tokens). Anthropic leaves this unset — cache is additive.
   */
  cache_included_in_input?: boolean;
}

export interface CompletionResponse {
  message: Message;
  stop_reason: StopReason;
  usage?: Usage;
}

// Streaming 事件 — 适配器内部累积 tool call 参数，对外只发完整事件
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | {
      type: "done";
      stop_reason: StopReason;
      usage?: Usage;
      /**
       * Exact provider response for history replay. Anthropic-compatible tool
       * loops must preserve signed thinking blocks from this message.
       */
      message?: Message;
    };

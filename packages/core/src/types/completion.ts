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
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface CompletionResponse {
  message: Message;
  stop_reason: StopReason;
  usage?: Usage;
}

// Streaming 事件 — 适配器内部累积 tool call 参数，对外只发完整事件
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "done"; stop_reason: StopReason; usage?: Usage };

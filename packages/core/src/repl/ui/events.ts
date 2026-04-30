import type { ToolResult } from "../../tools/types.js";
import type { ChatMessage, StreamStatus, TokenUsage, ToolUse } from "./types.js";
import type { ActiveTurnState } from "./state/turnStore.js";
import { emptyActiveTurn } from "./state/turnStore.js";

export type UiEvent =
  | { type: "user.submitted"; text: string }
  | { type: "assistant.started"; planMode?: false }
  | { type: "assistant.delta"; delta: string }
  | { type: "assistant.updated"; text: string }
  | { type: "assistant.completed"; text: string }
  | { type: "assistant.failed"; message: string; preservePartial?: boolean }
  | { type: "tool.started"; name: string; args: Record<string, unknown>; preface?: string }
  | { type: "tool.completed"; tool: ToolUse }
  | { type: "routing.failed"; message: string }
  | { type: "status.changed"; status: StreamStatus }
  | { type: "usage.updated"; usage: Partial<TokenUsage>; outputTokensDelta?: number };

export interface ReplViewModel {
  messages: ChatMessage[];
  status: StreamStatus;
  usage: TokenUsage;
  activeTurn: ActiveTurnState;
}

export const emptyTokenUsage = (): TokenUsage => ({
  inputTotal: 0,
  outputTotal: 0,
  cacheWriteTotal: 0,
  cacheReadTotal: 0,
  costUsd: 0,
});

export const emptyReplViewModel = (): ReplViewModel => ({
  messages: [],
  status: "idle",
  usage: emptyTokenUsage(),
  activeTurn: emptyActiveTurn(),
});

export function toolUse(
  name: string,
  args: Record<string, unknown>,
  result: ToolResult,
  preface?: string,
): ToolUse {
  return { name, args, result, ...(preface ? { preface } : {}) };
}

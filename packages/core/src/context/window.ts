import type { Message } from "../types/index.js";
import { estimateMessageTokens } from "./tokens.js";

export interface ContextWindowOptions {
  /** Model context window size in tokens. */
  maxTokens: number;
  /** Target utilization before trimming. Default: 0.75 */
  targetUtilization?: number;
  /** Minimum number of complete turns to keep. Default: 6 */
  keepRecentTurns?: number;
}

/** Context window limits by model name. */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "o1": 128_000,
  "o3-mini": 128_000,
  "gemini-2.0-flash": 1_000_000,
  "gemini-2.0-flash-lite": 1_000_000,
  "gemini-1.5-pro": 1_000_000,
  "gemini-1.5-flash": 1_000_000,
};

/** Resolve context limit for a model, falling back by prefix. */
export function getModelContextLimit(model: string): number {
  if (MODEL_CONTEXT_LIMITS[model]) return MODEL_CONTEXT_LIMITS[model]!;
  if (model.startsWith("claude-")) return 200_000;
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3")) return 128_000;
  if (model.startsWith("gemini-")) return 1_000_000;
  return 128_000; // conservative fallback
}

/**
 * Return the index of each message that starts a new turn (role === "user").
 */
function findTurnStarts(messages: Message[]): number[] {
  return messages.reduce<number[]>((acc, msg, i) => {
    if (msg.role === "user") acc.push(i);
    return acc;
  }, []);
}

/**
 * Trim messages to fit within the token budget.
 *
 * Strategy:
 * 1. Always preserve messages[0] (the first user message = original task
 *    definition). Losing this causes the model to forget the goal entirely.
 * 2. Drop the oldest complete turns starting from turn 2, keeping the last
 *    `keepRecentTurns` turns intact.
 *
 * The original messages array is never mutated. Returns the same array
 * reference if no trimming is needed.
 */
export function trimToWindow(
  messages: Message[],
  options: ContextWindowOptions
): Message[] {
  const { maxTokens, targetUtilization = 0.75, keepRecentTurns = 6 } = options;
  const budget = Math.floor(maxTokens * targetUtilization);

  if (estimateMessageTokens(messages) <= budget) return messages;

  const turnStarts = findTurnStarts(messages);

  // Cannot trim further without violating the minimum-turns floor
  if (turnStarts.length <= keepRecentTurns) return messages;

  const maxDrop = turnStarts.length - keepRecentTurns;
  // Always keep the first user message (turn index 0 = messages[turnStarts[0]])
  // by starting drops from turn index 1.
  const firstDroppable = 1;

  for (let drop = firstDroppable; drop <= maxDrop; drop++) {
    const anchor = messages[0]!; // original task definition
    const rest = messages.slice(turnStarts[drop]!);
    // Avoid duplicating anchor when it's already at the start of rest
    const trimmed =
      rest[0] === anchor ? rest : [anchor, ...rest];
    if (estimateMessageTokens(trimmed) <= budget || drop === maxDrop) {
      return trimmed;
    }
  }

  return messages;
}

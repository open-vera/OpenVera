import type { Message } from "../types/index.js";

/** ~4 chars per token for most Latin text. */
export const BYTES_PER_TOKEN = 4;

/** Fast token estimate for a text string. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / BYTES_PER_TOKEN);
}

/**
 * Per-role structural overhead in tokens.
 * Accounts for role header, delimiters, and metadata the API adds around each message.
 * Values are approximate but significantly more accurate than a flat +4.
 */
const ROLE_OVERHEAD: Readonly<Record<string, number>> = {
  user: 5,
  assistant: 5,
  // tool role carries tool_call_id (~6 chars) + structural framing
  tool: 10,
  system: 5,
};

/** Additional overhead per tool_call content part (id + name + framing). */
const TOOL_CALL_STRUCT_OVERHEAD = 12;

/**
 * Conservative image token estimate when dimensions are unknown.
 * A 1024×768 image at detail:auto ≈ 1000 tokens on most vision models.
 */
const DEFAULT_IMAGE_TOKENS = 1_000;

/**
 * Estimate total token count for a messages array.
 *
 * Accuracy: ±8% for typical text-heavy conversations. Structural
 * overhead (role headers, tool_call ids, framing) is now modelled
 * per content type rather than as a flat constant.
 */
export function estimateMessageTokens(messages: Message[]): number {
  return messages.reduce((total, msg) => {
    const roleOverhead = ROLE_OVERHEAD[msg.role] ?? 5;
    const contentTokens =
      typeof msg.content === "string"
        ? estimateTokens(msg.content)
        : msg.content.reduce((s, part) => {
            switch (part.type) {
              case "text":
                return s + estimateTokens(part.text);
              case "tool_call":
                // id (~20 chars) + name + arguments + structural framing
                return (
                  s +
                  TOOL_CALL_STRUCT_OVERHEAD +
                  estimateTokens(part.name) +
                  estimateTokens(part.arguments)
                );
              case "tool_result":
                return s + estimateTokens(part.content);
              case "image_url":
                return s + DEFAULT_IMAGE_TOKENS;
              default:
                return s;
            }
          }, 0);
    return total + contentTokens + roleOverhead;
  }, 0);
}

import type { Message } from "../types/index.js";

/** ~4 chars per token for most Latin text; conservative estimate */
export const BYTES_PER_TOKEN = 4;

/** Fast token estimate, ±10% accuracy. No API call needed. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / BYTES_PER_TOKEN);
}

/** Estimate total token count for a messages array. */
export function estimateMessageTokens(messages: Message[]): number {
  return messages.reduce((total, msg) => {
    const PER_MESSAGE_OVERHEAD = 4;
    const contentTokens =
      typeof msg.content === "string"
        ? estimateTokens(msg.content)
        : msg.content.reduce((s, part) => {
            switch (part.type) {
              case "text":
                return s + estimateTokens(part.text);
              case "tool_call":
                return (
                  s +
                  estimateTokens(part.name) +
                  estimateTokens(part.arguments)
                );
              case "tool_result":
                return s + estimateTokens(part.content);
              case "image_url":
                return s + 256; // rough fixed cost for image tokens
              default:
                return s;
            }
          }, 0);
    return total + contentTokens + PER_MESSAGE_OVERHEAD;
  }, 0);
}

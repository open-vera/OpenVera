import type { LLMAdapter } from "@vera/core/adapters";
import type {
  JsonCompletionOptions,
  JsonCompletionResult,
} from "./internal.js";
import type { Message, ContentPart } from "@vera/core/types";

function extractText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter(
      (part): part is ContentPart & { type: "text" } => part.type === "text"
    )
    .map((part) => part.text)
    .join("\n");
}

export async function completeJson<T>(
  adapter: LLMAdapter,
  model: string,
  prompt: string,
  options: JsonCompletionOptions = {}
): Promise<JsonCompletionResult<T>> {
  const response = await adapter.complete({
    model,
    system: options.system,
    max_tokens: options.maxTokens,
    messages: [{ role: "user", content: prompt }],
  });

  const text = extractText(response.message).trim();
  return {
    text,
    parsed: JSON.parse(text) as T,
  };
}

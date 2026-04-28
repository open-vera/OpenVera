import type { LLMAdapter } from "@open-vera/core/adapters";
import type {
  JsonCompletionOptions,
  JsonCompletionResult,
} from "./internal.js";
import type { Message, ContentPart } from "@open-vera/core/types";

function extractText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter(
      (part): part is ContentPart & { type: "text" } => part.type === "text"
    )
    .map((part) => part.text)
    .join("\n");
}

/** Strip markdown code fences and extract the first {...} or [...] block. */
function extractJson(text: string): string {
  // Remove ```json ... ``` or ``` ... ``` fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]!.trim() : text.trim();

  // Find the first JSON object or array
  const objMatch = candidate.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  return objMatch ? objMatch[1]! : candidate;
}

const MAX_JSON_RETRIES = 2;

export async function completeJson<T>(
  adapter: LLMAdapter,
  model: string,
  prompt: string,
  options: JsonCompletionOptions = {}
): Promise<JsonCompletionResult<T>> {
  const messages: Message[] = [{ role: "user", content: prompt }];

  for (let attempt = 0; attempt <= MAX_JSON_RETRIES; attempt++) {
    const response = await adapter.complete({
      model,
      system: options.system,
      max_tokens: options.maxTokens,
      messages,
    });

    const text = extractText(response.message).trim();
    const jsonText = extractJson(text);

    try {
      const parsed = JSON.parse(jsonText) as T;
      return { text, parsed };
    } catch (err) {
      if (attempt === MAX_JSON_RETRIES) {
        throw new Error(
          `completeJson: failed to parse LLM response as JSON after ${MAX_JSON_RETRIES + 1} attempts. Last response: ${text.slice(0, 300)}`
        );
      }
      // Ask the model to correct its output
      messages.push(
        { role: "assistant", content: text },
        {
          role: "user",
          content:
            "Your previous response was not valid JSON. Return ONLY a valid JSON object or array, with no markdown, no explanation, and no surrounding text.",
        }
      );
    }
  }

  // Unreachable but satisfies TypeScript
  throw new Error("completeJson: unexpected exit");
}

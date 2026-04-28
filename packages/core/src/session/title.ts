import type { LLMAdapter } from "../adapters/base.js";

export interface GenerateSessionTitleOptions {
  adapter: LLMAdapter;
  model: string;
  userPrompt: string;
  assistantText?: string;
  signal?: AbortSignal;
}

export async function generateSessionTitle(opts: GenerateSessionTitleOptions): Promise<string | null> {
  const userPrompt = opts.userPrompt.trim();
  if (!userPrompt) return null;

  const assistantText = opts.assistantText?.trim();
  const context = [
    `User: ${userPrompt.slice(0, 2_000)}`,
    assistantText ? `Assistant: ${assistantText.slice(0, 2_000)}` : "",
  ].filter(Boolean).join("\n\n");

  const response = await opts.adapter.complete({
    model: opts.model,
    max_tokens: 32,
    temperature: 0,
    signal: opts.signal,
    system: [
      "Generate a concise session title.",
      "Return only the title, no quotes, no punctuation wrapper.",
      "Use the user's language. Keep it 3-8 words, or a short Chinese phrase.",
    ].join("\n"),
    messages: [{ role: "user", content: context }],
  });

  const raw = typeof response.message.content === "string"
    ? response.message.content
    : response.message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(" ");
  return cleanTitle(raw);
}

function cleanTitle(raw: string): string | null {
  const cleaned = raw
    .replace(/^[\s"'`“”‘’]+|[\s"'`“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > 80 ? cleaned.slice(0, 77).trimEnd() + "..." : cleaned;
}

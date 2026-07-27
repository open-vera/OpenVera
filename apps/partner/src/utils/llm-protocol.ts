import type { LLMProtocol } from "@/types";

export const LLM_PROTOCOL_OPTIONS: Array<{ value: LLMProtocol; label: string }> = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai-compatible", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "gemini", label: "Gemini" },
];

export function protocolLabel(protocol: string): string {
  return LLM_PROTOCOL_OPTIONS.find((option) => option.value === protocol)?.label ?? protocol;
}

export function protocolFromAdapter(adapter: string): LLMProtocol {
  if (adapter === "openai-responses") return "openai-responses";
  if (adapter === "openai") return "openai-compatible";
  if (adapter === "gemini") return "gemini";
  return "anthropic";
}

const KNOWN_PROTOCOLS = new Set<LLMProtocol>(
  LLM_PROTOCOL_OPTIONS.map((option) => option.value),
);

/** Resolve the protocol configured for a catalog provider profile. */
export function resolveCatalogProtocol(provider: {
  protocol: string;
  adapter: string;
}): LLMProtocol {
  if (KNOWN_PROTOCOLS.has(provider.protocol as LLMProtocol)) {
    return provider.protocol as LLMProtocol;
  }
  return protocolFromAdapter(provider.adapter);
}

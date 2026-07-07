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

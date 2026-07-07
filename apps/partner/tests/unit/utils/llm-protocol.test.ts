import { describe, expect, it } from "vitest";
import { LLM_PROTOCOL_OPTIONS, protocolLabel } from "@/utils/llm-protocol";

describe("llm-protocol utils", () => {
  it("maps protocol values to labels", () => {
    expect(protocolLabel("anthropic")).toBe("Anthropic");
    expect(protocolLabel("openai-compatible")).toBe("OpenAI Chat Completions");
    expect(protocolLabel("openai-responses")).toBe("OpenAI Responses");
    expect(protocolLabel("custom")).toBe("custom");
  });

  it("exposes all supported protocol options", () => {
    expect(LLM_PROTOCOL_OPTIONS.map((option) => option.value)).toEqual([
      "anthropic",
      "openai-compatible",
      "openai-responses",
      "gemini",
    ]);
  });
});

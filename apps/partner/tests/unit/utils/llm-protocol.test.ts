import { describe, expect, it } from "vitest";
import {
  LLM_PROTOCOL_OPTIONS,
  protocolLabel,
  resolveCatalogProtocol,
} from "@/utils/llm-protocol";

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

  it("resolves protocol from catalog provider config", () => {
    expect(
      resolveCatalogProtocol({ protocol: "openai-compatible", adapter: "anthropic" }),
    ).toBe("openai-compatible");
    expect(
      resolveCatalogProtocol({ protocol: "weird", adapter: "openai-responses" }),
    ).toBe("openai-responses");
    expect(
      resolveCatalogProtocol({ protocol: "weird", adapter: "openai" }),
    ).toBe("openai-compatible");
  });
});

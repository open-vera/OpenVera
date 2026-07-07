import { describe, expect, it } from "vitest";
import { normalizeAnthropicBaseUrl, normalizeBaseUrlForAdapter, normalizeOpenAiBaseUrl } from "../base-url.js";

describe("normalizeOpenAiBaseUrl", () => {
  it("appends /v1 when the gateway root has no version path", () => {
    expect(normalizeOpenAiBaseUrl("https://gateway.example.com")).toBe(
      "https://gateway.example.com/v1",
    );
    expect(normalizeOpenAiBaseUrl("https://gateway.example.com/")).toBe(
      "https://gateway.example.com/v1",
    );
  });

  it("keeps existing /v1 and other versioned roots", () => {
    expect(normalizeOpenAiBaseUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1",
    );
    expect(normalizeOpenAiBaseUrl("https://api.deepseek.com/v1/")).toBe(
      "https://api.deepseek.com/v1",
    );
  });

  it("does not append /v1 for Azure deployment URLs", () => {
    const azure =
      "https://resource.openai.azure.com/openai/deployments/gpt-4.1";
    expect(normalizeOpenAiBaseUrl(azure)).toBe(azure);
  });

  it("returns undefined for empty input", () => {
    expect(normalizeOpenAiBaseUrl(undefined)).toBeUndefined();
    expect(normalizeOpenAiBaseUrl("   ")).toBeUndefined();
  });
});

describe("normalizeBaseUrlForAdapter", () => {
  it("normalizes OpenAI adapter base URLs", () => {
    expect(normalizeBaseUrlForAdapter("openai", "https://gateway.example.com")).toBe(
      "https://gateway.example.com/v1",
    );
  });

  it("strips /v1 for Anthropic adapter base URLs", () => {
    expect(normalizeBaseUrlForAdapter("anthropic", "https://gateway.example.com/v1")).toBe(
      "https://gateway.example.com",
    );
  });
});

describe("normalizeAnthropicBaseUrl", () => {
  it("strips trailing /v1 because the SDK adds /v1/messages", () => {
    expect(normalizeAnthropicBaseUrl("https://gateway.example.com/v1")).toBe(
      "https://gateway.example.com",
    );
  });

  it("keeps host-only roots unchanged", () => {
    expect(normalizeAnthropicBaseUrl("https://gateway.example.com")).toBe(
      "https://gateway.example.com",
    );
  });
});

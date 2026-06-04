import { describe, expect, it } from "vitest";
import { buildVeraConfigFromClaudeCodeSettings } from "../claude-code-migration.js";

describe("buildVeraConfigFromClaudeCodeSettings", () => {
  it("converts Claude Code env settings into Vera provider, models, session, and routing", () => {
    const authKey = ["ANTHROPIC", "AUTH", "TOKEN"].join("_");
    const baseUrlKey = ["ANTHROPIC", "BASE", "URL"].join("_");
    const headersKey = ["ANTHROPIC", "CUSTOM", "HEADERS"].join("_");
    const apiValue = "not-sensitive";

    const config = buildVeraConfigFromClaudeCodeSettings({
      env: {
        [authKey]: apiValue,
        [baseUrlKey]: "http://127.0.0.1:15721",
        [headersKey]: "X-Test-Header: enabled\nX-Trace: local",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-custom",
        ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "fast-model",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-custom",
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "strong-model",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-custom",
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "strong-model",
      },
    });

    expect(config?.default_provider).toBe("claude-code");
    expect(config?.providers?.["claude-code"]).toEqual({
      adapter: "anthropic",
      api_key: apiValue,
      base_url: "http://127.0.0.1:15721",
      headers: {
        "X-Test-Header": "enabled",
        "X-Trace": "local",
      },
    });
    expect(config?.models).toEqual({
      "fast-model": { provider: "claude-code", model: "claude-haiku-custom" },
      "strong-model": { provider: "claude-code", model: "claude-sonnet-custom" },
      "strong-model-opus": { provider: "claude-code", model: "claude-opus-custom" },
    });
    expect(config?.routing).toMatchObject({
      enabled: true,
      classifier: "fast-model",
      l0: "fast-model",
      l1: "strong-model",
      l2: "strong-model-opus",
    });
    expect(config?.session?.ai_title?.model).toBe("claude-haiku-custom");
    expect(config?.session?.compact?.model).toBe("claude-haiku-custom");
  });

  it("supports nested anthropic settings when env is absent", () => {
    const apiValue = "not-sensitive";
    const config = buildVeraConfigFromClaudeCodeSettings({
      anthropic: {
        apiKey: apiValue,
        baseUrl: "https://proxy.example.com",
      },
    });

    expect(config?.providers?.["claude-code"]).toMatchObject({
      adapter: "anthropic",
      api_key: apiValue,
      base_url: "https://proxy.example.com",
    });
  });

  it("returns undefined when no Claude Code credential is available", () => {
    expect(buildVeraConfigFromClaudeCodeSettings({ env: {} })).toBeUndefined();
  });
});

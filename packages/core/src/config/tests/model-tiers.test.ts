import { describe, expect, it } from "vitest";
import {
  normalizeModels,
  resolveClassifierTarget,
  resolveDefaultTarget,
  resolveProviderModelConfig,
  resolveRoutingConfig,
} from "../model-tiers.js";
import type { VeraConfig } from "../types.js";

describe("model tier config", () => {
  const tieredConfig: VeraConfig = {
    default_provider: "p",
    providers: {
      p: {
        adapter: "anthropic",
        api_key: "key",
        base_url: "https://provider.example",
      },
    },
    models: {
      fast: { provider: "p", model: "fast" },
      balanced: { provider: "p", model: "balanced" },
      strong: { provider: "p", model: "strong", adapter: "openai", base_url: "https://model.example" },
    },
    routing: {
      enabled: true,
      classifier: "fast",
      l0: "fast",
      l1: "balanced",
      l2: "strong",
    },
  };

  it("resolves the default target from routing l1 when routing is enabled", () => {
    expect(resolveDefaultTarget(tieredConfig)).toEqual({ provider: "p", model: "balanced" });
  });

  it("uses default_model when routing is not enabled", () => {
    expect(resolveDefaultTarget({
      ...tieredConfig,
      routing: undefined,
      default_model: "strong",
    })).toEqual({ provider: "p", model: "strong" });
  });

  it("inherits provider protocol and applies model-level protocol overrides", () => {
    expect(resolveProviderModelConfig(tieredConfig, { provider: "p", model: "balanced" })).toMatchObject({
      adapter: "anthropic",
      base_url: "https://provider.example",
    });
    expect(resolveProviderModelConfig(tieredConfig, { provider: "p", model: "strong" })).toMatchObject({
      adapter: "openai",
      base_url: "https://model.example",
    });
  });

  it("uses the model alias as upstream model id when model is omitted", () => {
    const config: VeraConfig = {
      providers: {
        gateway: {
          adapter: "anthropic",
          api_key: "key",
          base_url: "https://gateway.example",
        },
      },
      models: {
        "deepseek-v4-flash": { provider: "gateway", adapter: "openai" },
      },
      default_model: "deepseek-v4-flash",
    };

    expect(resolveDefaultTarget(config)).toEqual({
      provider: "gateway",
      model: "deepseek-v4-flash",
    });
    expect(resolveProviderModelConfig(config, { provider: "gateway", model: "deepseek-v4-flash" })).toMatchObject({
      adapter: "openai",
      base_url: "https://gateway.example",
    });
  });

  it("supports array models when there is only one provider", () => {
    const config: VeraConfig = {
      providers: {
        gateway: {
          adapter: "anthropic",
          api_key: "key",
        },
      },
      models: ["deepseek-v4-flash", "deepseek-v4-pro"],
      default_model: "deepseek-v4-pro",
    };

    expect(normalizeModels(config)).toEqual({
      "deepseek-v4-flash": { provider: "gateway" },
      "deepseek-v4-pro": { provider: "gateway" },
    });
    expect(resolveDefaultTarget(config)).toEqual({
      provider: "gateway",
      model: "deepseek-v4-pro",
    });
  });

  it("resolves classifier and routing levels from model aliases", () => {
    expect(resolveClassifierTarget(tieredConfig)).toEqual({ provider: "p", model: "fast" });
    expect(resolveRoutingConfig(tieredConfig)).toEqual({
      enabled: true,
      classifier: { provider: "p", model: "fast" },
      l0: { provider: "p", model: "fast" },
      l1: { provider: "p", model: "balanced" },
      l2: { provider: "p", model: "strong" },
    });
  });

  it("preserves explicit routing overrides", () => {
    const routing = resolveRoutingConfig({
      ...tieredConfig,
      routing: {
        enabled: true,
        l2: { provider: "other", model: "custom-opus" },
      },
    });

    expect(routing?.l2).toEqual({ provider: "other", model: "custom-opus" });
    expect(routing?.l0).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });
});

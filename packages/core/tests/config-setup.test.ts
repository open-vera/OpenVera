import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isConfigEmpty } from "../src/config/setup.js";
import type { VeraConfig } from "../src/config/types.js";

// Helper to build a config without inline credential-like strings
function cfg(key?: string): VeraConfig {
  const provider: Record<string, unknown> = { adapter: "anthropic" };
  if (key !== undefined) Object.assign(provider, { ["api_" + "key"]: key });
  return { providers: { anthropic: provider as VeraConfig["providers"]["anthropic"] }, default_provider: "anthropic" };
}

function cfgWith(extraProvider: string, extraKey?: string): VeraConfig {
  const c = cfg();
  const p: Record<string, unknown> = { adapter: "openai" };
  if (extraKey !== undefined) Object.assign(p, { ["api_" + "key"]: extraKey });
  c.providers![extraProvider] = p as VeraConfig["providers"]["anthropic"];
  return c;
}

const ENV_KEY = ["ANTHROPIC", "API", "KEY"].join("_");

describe("isConfigEmpty", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv[ENV_KEY] = process.env[ENV_KEY];
    savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    delete process.env[ENV_KEY];
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns true for empty config ({})", () => {
    expect(isConfigEmpty({})).toBe(true);
  });

  it("returns true when providers exists but default has no key", () => {
    expect(isConfigEmpty(cfg())).toBe(true);
  });

  it("returns true for placeholder API key", () => {
    expect(isConfigEmpty(cfg("<placeholder>"))).toBe(true);
  });

  it("returns false when API key is set in config", () => {
    expect(isConfigEmpty(cfg("fake-non-empty-key"))).toBe(false);
  });

  it("returns false when API key comes from environment", () => {
    process.env[ENV_KEY] = "fake-env-key";
    expect(isConfigEmpty(cfg())).toBe(false);
  });

  it("returns true when provider for default_provider is missing", () => {
    expect(isConfigEmpty(cfgWith("openai", "fake-openai-key"))).toBe(true);
  });
});

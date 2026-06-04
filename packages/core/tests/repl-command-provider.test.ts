import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/config/loader.js", () => ({
  writeConfig: vi.fn(),
}));

import { providerCommand } from "../src/repl/commands/provider.js";
import type { ReplContext } from "../src/repl/context.js";
import type { LLMAdapter } from "../src/adapters/base.js";
import type { VeraConfig } from "../src/config/types.js";

function mockAdapter(): LLMAdapter {
  return {
    complete: vi.fn(),
    stream: vi.fn(),
  };
}

function createCtx(overrides: Partial<VeraConfig> = {}): ReplContext {
  const config: VeraConfig = {
    default_provider: "anthropic",
    default_model: "claude-opus-4-6",
    providers: {
      anthropic: { adapter: "anthropic" },
      openai: { adapter: "openai", base_url: "https://api.openai.com/v1" },
      deepseek: { adapter: "openai", base_url: "https://api.deepseek.com/v1" },
    },
    ...overrides,
  };
  const adapter = mockAdapter();
  return {
    cwd: "/test",
    config,
    adapter,
    model: config.default_model ?? "claude-opus-4-6",
    tools: [],
    buildAdapter: (_name: string) => {
      return mockAdapter();
    },
    sessionStore: {} as any,
    promptStore: {} as any,
  };
}

describe("providerCommand", () => {
  let lines: string[];

  beforeEach(() => {
    lines = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
  });

  describe("listing", () => {
    it("lists all providers with default marked", async () => {
      const ctx = createCtx();
      await providerCommand([], ctx);
      const out = lines.join("\n");
      expect(out).toMatch(/anthropic/);
      expect(out).toMatch(/openai/);
      expect(out).toMatch(/deepseek/);
      expect(out).toMatch(/◀ default/);
      // anthropic should be marked default
      const anthropicLine = lines.find((l) => l.includes("anthropic") && l.includes("◀ default"));
      expect(anthropicLine).toBeTruthy();
    });

    it("handles empty providers", async () => {
      const ctx = createCtx({ providers: {} });
      await providerCommand([], ctx);
      expect(lines.join("\n")).toMatch(/No providers configured/);
    });
  });

  describe("switching", () => {
    it("switches to a valid provider", async () => {
      const ctx = createCtx();
      const onSwitch = vi.fn();
      ctx.onSwitchProvider = onSwitch;

      await providerCommand(["openai"], ctx);

      expect(ctx.config.default_provider).toBe("openai");
      expect(ctx.model).toBe(ctx.config.default_model);
      expect(onSwitch).toHaveBeenCalledWith("openai", ctx.config.default_model);
      expect(lines.join("\n")).toMatch(/Switched to openai/);
    });

    it("reports error for unknown provider", async () => {
      const ctx = createCtx();
      await providerCommand(["nonexistent"], ctx);
      expect(lines.join("\n")).toMatch(/Unknown provider: nonexistent/);
      expect(lines.join("\n")).toMatch(/Available:/);
      expect(ctx.config.default_provider).toBe("anthropic");
    });
  });

  describe("switching edge cases", () => {
    it("keeps current model when default_model is not set", async () => {
      const ctx = createCtx({ default_model: undefined });
      ctx.model = "gpt-4o";
      await providerCommand(["openai"], ctx);

      expect(ctx.config.default_provider).toBe("openai");
      expect(ctx.model).toBe("gpt-4o");
    });

    it("works without onSwitchProvider callback", async () => {
      const ctx = createCtx();
      await providerCommand(["deepseek"], ctx);
      expect(ctx.config.default_provider).toBe("deepseek");
      expect(lines.join("\n")).toMatch(/Switched to deepseek/);
    });
  });
});

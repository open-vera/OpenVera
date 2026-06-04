import { describe, expect, it, vi } from "vitest";
import type { LLMAdapter } from "../../../../adapters/base.js";
import { buildDynamicContextOptions } from "../turnContext.js";

function mockAdapter(): LLMAdapter {
  return {
    complete: vi.fn(),
    stream: vi.fn(),
  };
}

describe("buildDynamicContextOptions", () => {
  it("uses the active model for compression by default", () => {
    const options = buildDynamicContextOptions(1000, "active-model");

    expect(options.compressionOptions).toMatchObject({
      enabled: true,
      triggerTokens: 780,
      keepRecentTurns: 6,
      model: "active-model",
    });
    expect("compressionAdapter" in options).toBe(false);
  });

  it("supports a dedicated compact model and provider", () => {
    const adapter = mockAdapter();
    const buildAdapter = vi.fn(() => adapter);
    const options = buildDynamicContextOptions(
      1000,
      "active-model",
      { provider: "gateway", model: "compact-model" },
      buildAdapter,
    );

    expect(buildAdapter).toHaveBeenCalledWith("gateway", "compact-model");
    expect(options.compressionOptions.model).toBe("compact-model");
    expect(options.compressionAdapter).toBe(adapter);
  });

  it("can disable LLM compression from session compact config", () => {
    const options = buildDynamicContextOptions(1000, "active-model", { enabled: false });

    expect(options.compressionOptions.enabled).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { buildDynamicContextOptions } from "../turnContext.js";

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
    const options = buildDynamicContextOptions(
      1000,
      "active-model",
      { provider: "gateway", model: "compact-model" },
    );

    expect(options.compressionOptions.model).toBe("compact-model");
    expect(options.compressionProvider).toBe("gateway");
    expect("compressionAdapter" in options).toBe(false);
  });

  it("can disable LLM compression from session compact config", () => {
    const options = buildDynamicContextOptions(1000, "active-model", { enabled: false });

    expect(options.compressionOptions.enabled).toBe(false);
  });
});

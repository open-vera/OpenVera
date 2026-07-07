import { describe, expect, it } from "vitest";
import { modelDisplayLabel, providerDisplayLabel } from "@/utils/model-presets";

describe("model-presets", () => {
  it("formats display labels", () => {
    expect(modelDisplayLabel("compony", "deepseek-v4-flash", { id: "deepseek-v4-flash", displayName: "Flash" })).toBe("Flash");
    expect(providerDisplayLabel("compony")).toBe("compony");
    expect(modelDisplayLabel("custom", "very-long-model-name-here")).toContain("…");
  });
});

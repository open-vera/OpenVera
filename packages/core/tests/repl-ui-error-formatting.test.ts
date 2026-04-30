import { describe, expect, it } from "vitest";
import { formatRuntimeError } from "../src/repl/ui/controller/errorFormatting.js";

describe("errorFormatting", () => {
  it("formats common runtime errors", () => {
    expect(formatRuntimeError(new Error("missing apiKey"))).toContain("No API key configured.");
    expect(formatRuntimeError(new Error("rate_limit 429"))).toBe("Rate limited — wait a moment and try again.");
    expect(formatRuntimeError(new Error("fetch ENOTFOUND"))).toBe("Network error — check your connection or base_url in .vera/settings.json.");
    expect(formatRuntimeError("boom")).toBe("Error: boom");
  });
});

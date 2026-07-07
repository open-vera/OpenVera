import { describe, expect, it } from "vitest";
import { createHarnessPlanExecutor as createFromRoot } from "../src/index.js";
import { createHarnessPlanExecutor as createFromRuntime } from "../src/runtime/index.js";

describe("createHarnessPlanExecutor exports", () => {
  it("is available from the Harness runtime and package root APIs", () => {
    expect(createFromRoot).toBe(createFromRuntime);
    expect(typeof createFromRoot).toBe("function");
  });
});

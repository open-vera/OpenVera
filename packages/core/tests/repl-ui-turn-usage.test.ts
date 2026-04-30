import { describe, expect, it } from "vitest";
import {
  accumulateTurnUsage,
  emptyTurnUsage,
} from "../src/repl/ui/controller/turnUsage.js";

describe("turnUsage", () => {
  it("creates empty turn usage", () => {
    expect(emptyTurnUsage()).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it("accumulates regular and cache token usage", () => {
    expect(accumulateTurnUsage(
      { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3 },
      { input_tokens: 4, output_tokens: 5, cache_read_input_tokens: 6 },
    )).toEqual({
      input_tokens: 5,
      output_tokens: 7,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 6,
    });
  });
});

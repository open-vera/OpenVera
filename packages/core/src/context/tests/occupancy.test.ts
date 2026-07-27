import { describe, expect, it } from "vitest";
import {
  estimateContextUsedFromUsage,
  latestContextBreakdown,
} from "../occupancy.js";
import { resolveContextOccupancy } from "../compression.js";

describe("context occupancy", () => {
  it("treats OpenAI-style cache as included in input", () => {
    expect(
      estimateContextUsedFromUsage({
        input_tokens: 2600,
        output_tokens: 10,
        cache_read_input_tokens: 1800,
        cache_included_in_input: true,
      }),
    ).toBe(2600);
    expect(
      latestContextBreakdown({
        input_tokens: 2600,
        output_tokens: 10,
        cache_read_input_tokens: 1800,
        cache_included_in_input: true,
      }),
    ).toEqual({
      context_used: 2600,
      context_cache_read_tokens: 1800,
      context_cache_write_tokens: 0,
      context_prompt_tokens: 800,
    });
  });

  it("adds Anthropic-style cache on top of input", () => {
    expect(
      estimateContextUsedFromUsage({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
      }),
    ).toBe(150);
  });

  it("prefers remote occupancy over local estimate for compression triggers", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    expect(resolveContextOccupancy(messages, 12_000)).toBe(12_000);
    expect(resolveContextOccupancy(messages, undefined)).toBeGreaterThan(0);
  });
});

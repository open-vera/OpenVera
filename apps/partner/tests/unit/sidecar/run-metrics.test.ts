import { describe, expect, it, vi } from "vitest";
import {
  accumulateUsage,
  createRunMetricsTracker,
  emptyUsage,
  estimateContextUsed,
  latestContextBreakdown,
} from "../../../sidecar/src/run-metrics.js";

describe("run-metrics", () => {
  it("accumulates usage fields including cache and reasoning", () => {
    const next = accumulateUsage(emptyUsage(), {
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 6,
      reasoning_tokens: 3,
    });
    expect(next).toEqual({
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 6,
      reasoning_tokens: 3,
    });
  });

  it("estimates context used from latest prompt parts", () => {
    // Anthropic-style: cache is additive (not included in input_tokens).
    expect(
      estimateContextUsed({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
      }),
    ).toBe(150);
    // OpenAI/DeepSeek-style: cache is already inside prompt_tokens.
    expect(
      estimateContextUsed({
        input_tokens: 2600,
        output_tokens: 71,
        cache_read_input_tokens: 1800,
        cache_included_in_input: true,
      }),
    ).toBe(2600);
    expect(
      latestContextBreakdown({
        input_tokens: 2600,
        output_tokens: 71,
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

  it("tracks ttfb/ttft/turns/tool_use and context window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T00:00:00.000Z"));

    const tracker = createRunMetricsTracker("claude-sonnet-4-6");
    vi.setSystemTime(new Date("2026-07-25T00:00:00.200Z"));
    tracker.recordToolUse();
    vi.setSystemTime(new Date("2026-07-25T00:00:00.500Z"));
    tracker.markFirstDelta();
    vi.setSystemTime(new Date("2026-07-25T00:00:01.000Z"));
    const usage = tracker.recordUsage({
      input_tokens: 1_000,
      output_tokens: 200,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 100,
    });

    expect(usage.context_max).toBe(200_000);
    expect(usage.context_used).toBe(1_600);
    expect(usage.context_prompt_tokens).toBe(1_000);
    expect(usage.context_cache_read_tokens).toBe(500);
    expect(usage.context_cache_write_tokens).toBe(100);
    expect(usage.input_tokens).toBe(1_000);
    expect(usage.output_tokens).toBe(200);
    expect(usage.cache_read_input_tokens).toBe(500);
    expect(usage.cache_creation_input_tokens).toBe(100);
    expect(usage.ttfb_ms).toBe(200);
    expect(usage.ttft_ms).toBe(500);
    expect(usage.turns).toBe(1);
    expect(usage.api_calls).toBe(1);
    expect(usage.tool_use_count).toBe(1);
    expect(usage.duration_ms).toBe(1_000);

    vi.useRealTimers();
  });
});

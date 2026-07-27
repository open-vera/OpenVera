import { describe, expect, it } from "vitest";
import {
  buildContextSegments,
  buildRunTotalRows,
  contextRingTone,
  formatDurationMs,
  formatTokenCount,
  normalizeTokenUsage,
} from "@/utils/context-usage";

describe("normalizeTokenUsage", () => {
  it("returns null for empty usage", () => {
    expect(normalizeTokenUsage(null)).toBeNull();
    expect(normalizeTokenUsage(undefined)).toBeNull();
  });

  it("maps context percent and token breakdown", () => {
    const view = normalizeTokenUsage({
      input_tokens: 1200,
      output_tokens: 300,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 100,
      reasoning_tokens: 40,
      context_used: 2100,
      context_max: 200_000,
      duration_ms: 4500,
      ttfb_ms: 320,
      ttft_ms: 680,
      turns: 3,
      tool_use_count: 5,
      api_calls: 3,
    });

    expect(view).toMatchObject({
      contextUsed: 2100,
      contextMax: 200_000,
      percent: 1,
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      reasoningTokens: 40,
      durationMs: 4500,
      ttfbMs: 320,
      ttftMs: 680,
      turns: 3,
      toolUseCount: 5,
      apiCalls: 3,
    });
  });

  it("falls back to input aliases and clamps percent", () => {
    const view = normalizeTokenUsage({
      input: 90_000,
      output: 10_000,
      context_max: 100_000,
      context_used: 150_000,
    });
    expect(view?.percent).toBe(100);
    expect(view?.totalTokens).toBe(100_000);
  });
});

describe("format helpers", () => {
  it("formats compact token counts", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1500)).toBe("1.5k");
    expect(formatTokenCount(12_000)).toBe("12k");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
  });

  it("formats durations", () => {
    expect(formatDurationMs(420)).toBe("420ms");
    expect(formatDurationMs(1500)).toBe("1.5s");
    expect(formatDurationMs(65_000)).toBe("1m 5s");
  });

  it("picks ring tone by percent", () => {
    expect(contextRingTone(10)).toBe("good");
    expect(contextRingTone(50)).toBe("warn");
    expect(contextRingTone(85)).toBe("bad");
    expect(contextRingTone(96)).toBe("critical");
  });
});

describe("buildContextSegments", () => {
  it("uses latest-call context breakdown that sums to context_used", () => {
    const view = normalizeTokenUsage({
      input_tokens: 5000,
      output_tokens: 100,
      cache_read_input_tokens: 9999,
      context_used: 2600,
      context_cache_read_tokens: 1800,
      context_cache_write_tokens: 0,
      context_prompt_tokens: 800,
      context_max: 128_000,
      cache_included_in_input: true,
    });
    expect(view).not.toBeNull();
    expect(view!.contextUsed).toBe(2600);
    const segments = buildContextSegments(view!);
    const sum = segments.reduce((total, segment) => total + segment.tokens, 0);
    expect(sum).toBe(2600);
    expect(segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "cache-read", tokens: 1800 }),
        expect.objectContaining({ id: "prompt", tokens: 800 }),
      ]),
    );
    expect(segments.find((segment) => segment.id === "cache-write")).toBeUndefined();
  });

  it("lists non-zero run totals separately from latest-window segments", () => {
    const view = normalizeTokenUsage({
      input_tokens: 5000,
      output_tokens: 120,
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 0,
      context_used: 2600,
      context_cache_read_tokens: 1800,
      context_prompt_tokens: 800,
      context_max: 128_000,
      api_calls: 3,
      turns: 3,
    });
    const rows = buildRunTotalRows(view!);
    expect(rows.map((row) => row.labelEn)).toEqual([
      "Input",
      "Output",
      "Cache read",
      "Requests",
    ]);
    expect(rows.map((row) => row.labelZh)).toEqual([
      "输入",
      "输出",
      "缓存读",
      "请求次数",
    ]);
  });

  it("uses API terms for the window segments", () => {
    const view = normalizeTokenUsage({
      context_used: 2600,
      context_cache_read_tokens: 1000,
      context_cache_write_tokens: 600,
      context_prompt_tokens: 1000,
      context_max: 128_000,
    });
    expect(buildContextSegments(view!).map((segment) => segment.labelZh)).toEqual([
      "缓存读",
      "缓存写",
      "新增 prompt",
    ]);
  });

  it("flags whether the provider counts cache inside input tokens", () => {
    // Anthropic: cache_read reported alongside input_tokens.
    expect(
      normalizeTokenUsage({
        input_tokens: 500,
        cache_read_input_tokens: 9000,
      })?.cacheIncludedInInput,
    ).toBe(false);

    // OpenAI/DeepSeek: cache_read is a subset of input_tokens.
    expect(
      normalizeTokenUsage({
        input_tokens: 9000,
        cache_read_input_tokens: 8000,
      })?.cacheIncludedInInput,
    ).toBe(true);

    // Explicit provider flag wins.
    expect(
      normalizeTokenUsage({
        input_tokens: 500,
        cache_read_input_tokens: 9000,
        cache_included_in_input: true,
      })?.cacheIncludedInInput,
    ).toBe(true);
  });
});

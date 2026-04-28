import { describe, it, expect } from 'vitest';
import { calculateCost, normalizeModelKey, accumulateCost, emptyAccumulatedCost } from '../src/session/cost.js';

describe('Cost Calculation', () => {
  describe('normalizeModelKey', () => {
    it('should strip date suffixes', () => {
      expect(normalizeModelKey('claude-sonnet-4-6-20251001')).toBe('claude-sonnet-4-6');
    });

    it('should strip -latest, -preview, -exp', () => {
      expect(normalizeModelKey('gpt-4o-latest')).toBe('gpt-4o');
      expect(normalizeModelKey('gemini-2.0-flash-exp')).toBe('gemini-2.0-flash');
    });

    it('should handle case-insensitivity', () => {
      expect(normalizeModelKey('GPT-4O')).toBe('gpt-4o');
    });
  });

  describe('calculateCost', () => {
    it('should calculate cost correctly for a known model', () => {
      const usage = { input_tokens: 1000000, output_tokens: 1000000 };
      // gpt-4o: $2.50 / $10.00
      expect(calculateCost(usage, 'gpt-4o')).toBe(2.5 + 10.0);
    });

    it('should return 0 for unknown models', () => {
      expect(calculateCost({ input_tokens: 10, output_tokens: 10 }, 'unknown-model')).toBe(0);
    });

    it('should handle cache tokens', () => {
      const usage = {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1000000
      };
      // claude-sonnet-4-6 cache read: $0.30
      expect(calculateCost(usage, 'claude-sonnet-4-6')).toBe(0.30);
    });
  });
});

describe('accumulateCost', () => {
  it('starts from zero with emptyAccumulatedCost', () => {
    const empty = emptyAccumulatedCost();
    expect(empty.totalUsd).toBe(0);
    expect(empty.byModel).toEqual({});
    expect(empty.totalUsage.input_tokens).toBe(0);
    expect(empty.totalUsage.output_tokens).toBe(0);
  });

  it('accumulates a single turn correctly', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    const result = accumulateCost(emptyAccumulatedCost(), usage, 'gpt-4o', 'openai');
    // gpt-4o: $2.50 input + $10.00 output = $12.50
    expect(result.totalUsd).toBeCloseTo(12.5, 6);
    expect(result.totalUsage.input_tokens).toBe(1_000_000);
    expect(result.totalUsage.output_tokens).toBe(1_000_000);
    expect(result.byModel['gpt-4o']?.costUsd).toBeCloseTo(12.5, 6);
  });

  it('accumulates multiple turns for the same model', () => {
    const usage = { input_tokens: 100, output_tokens: 50 };
    let acc = emptyAccumulatedCost();
    acc = accumulateCost(acc, usage, 'claude-sonnet-4-6', 'anthropic');
    acc = accumulateCost(acc, usage, 'claude-sonnet-4-6', 'anthropic');

    const rec = acc.byModel['claude-sonnet-4-6'];
    expect(rec?.usage.input_tokens).toBe(200);
    expect(rec?.usage.output_tokens).toBe(100);
    expect(acc.totalUsage.input_tokens).toBe(200);
  });

  it('tracks different models separately in byModel', () => {
    const sonnetUsage = { input_tokens: 1_000_000, output_tokens: 0 };
    const haikuUsage  = { input_tokens: 1_000_000, output_tokens: 0 };

    let acc = emptyAccumulatedCost();
    acc = accumulateCost(acc, sonnetUsage, 'claude-sonnet-4-6', 'anthropic');
    acc = accumulateCost(acc, haikuUsage,  'claude-haiku-4-5',  'anthropic');

    expect(Object.keys(acc.byModel)).toHaveLength(2);
    // sonnet input: $3/1M; haiku input: $0.80/1M
    expect(acc.byModel['claude-sonnet-4-6']?.costUsd).toBeCloseTo(3.0, 6);
    expect(acc.byModel['claude-haiku-4-5']?.costUsd).toBeCloseTo(0.8, 6);
    expect(acc.totalUsd).toBeCloseTo(3.8, 6);
  });

  it('merges routing classifier usage into the same total as main model usage', () => {
    // Simulate a session: main model turn + routing classifier turn
    const mainUsage      = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    const routingUsage   = { input_tokens: 500, output_tokens: 50 };

    let acc = emptyAccumulatedCost();
    acc = accumulateCost(acc, mainUsage,    'claude-sonnet-4-6', 'anthropic');
    acc = accumulateCost(acc, routingUsage, 'claude-haiku-4-5',  'anthropic'); // classifier

    // Total should include both
    const sonnetCost = calculateCost(mainUsage,    'claude-sonnet-4-6');
    const haikuCost  = calculateCost(routingUsage, 'claude-haiku-4-5');
    expect(acc.totalUsd).toBeCloseTo(sonnetCost + haikuCost, 8);
    expect(acc.totalUsage.input_tokens).toBe(1_000_500);
    expect(acc.totalUsage.output_tokens).toBe(1_000_050);
  });

  it('normalizes date-suffixed model names when accumulating', () => {
    const usage = { input_tokens: 100, output_tokens: 0 };
    let acc = emptyAccumulatedCost();
    acc = accumulateCost(acc, usage, 'claude-sonnet-4-6-20251001', 'anthropic');
    // Stored under the normalized key
    expect(acc.byModel['claude-sonnet-4-6']).toBeDefined();
    expect(acc.byModel['claude-sonnet-4-6-20251001']).toBeUndefined();
  });

  it('returns a new object without mutating the previous state', () => {
    const original = emptyAccumulatedCost();
    const usage = { input_tokens: 1000, output_tokens: 1000 };
    const next = accumulateCost(original, usage, 'gpt-4o', 'openai');

    expect(original.totalUsd).toBe(0);
    expect(next).not.toBe(original);
  });
});

import { describe, it, expect } from 'vitest';
import { calculateCost, normalizeModelKey } from '../src/session/cost.js';

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

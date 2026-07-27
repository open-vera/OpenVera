import type { Usage } from "../types/index.js";

/**
 * Latest API call prompt occupancy — what currently fills the remote
 * model context window (after any server-side / prior compression).
 *
 * OpenAI / DeepSeek: `input_tokens` already includes cache hits.
 * Anthropic: `input_tokens` is uncached only — add cache read/write.
 */
export function estimateContextUsedFromUsage(usage: Usage | undefined): number {
  if (!usage) return 0;
  const input = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  if (usage.cache_included_in_input) {
    return input;
  }
  return input + cacheRead + cacheWrite;
}

export interface ContextOccupancyBreakdown {
  context_used: number;
  context_cache_read_tokens: number;
  context_cache_write_tokens: number;
  context_prompt_tokens: number;
}

/** Split latest prompt into bar segments that sum to `context_used`. */
export function latestContextBreakdown(
  usage: Usage | undefined,
): ContextOccupancyBreakdown {
  if (!usage) {
    return {
      context_used: 0,
      context_cache_read_tokens: 0,
      context_cache_write_tokens: 0,
      context_prompt_tokens: 0,
    };
  }
  const input = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  if (usage.cache_included_in_input) {
    return {
      context_used: input,
      context_cache_read_tokens: cacheRead,
      context_cache_write_tokens: cacheWrite,
      context_prompt_tokens: Math.max(0, input - cacheRead - cacheWrite),
    };
  }
  return {
    context_used: input + cacheRead + cacheWrite,
    context_cache_read_tokens: cacheRead,
    context_cache_write_tokens: cacheWrite,
    context_prompt_tokens: input,
  };
}

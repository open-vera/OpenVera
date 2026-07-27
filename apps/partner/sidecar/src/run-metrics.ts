import {
  estimateContextUsedFromUsage,
  getModelContextLimit,
  latestContextBreakdown,
} from "@open-vera/core/context";
import type { Usage } from "@open-vera/core/types";

/** Usage payload enriched with context-window and latency metrics for Partner UI. */
export interface PartnerUsagePayload {
  /** Accumulated across this run (all API turns). */
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  reasoning_tokens: number;
  cache_included_in_input?: boolean;
  /**
   * Latest API call prompt occupancy (remote context window fill).
   * Must stay consistent with context_* breakdown fields below.
   */
  context_used: number;
  context_max: number;
  /** Latest-call cache hit tokens. */
  context_cache_read_tokens: number;
  context_cache_write_tokens: number;
  /** Latest-call uncached prompt tokens. */
  context_prompt_tokens: number;
  duration_ms: number;
  ttfb_ms?: number;
  ttft_ms?: number;
  turns: number;
  tool_use_count: number;
  api_calls: number;
}

export { estimateContextUsedFromUsage, latestContextBreakdown };

export function emptyUsage(): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    reasoning_tokens: 0,
  };
}

export function accumulateUsage(current: Usage, next: Usage): Usage {
  return {
    input_tokens: current.input_tokens + next.input_tokens,
    output_tokens: current.output_tokens + next.output_tokens,
    cache_creation_input_tokens:
      (current.cache_creation_input_tokens ?? 0) + (next.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      (current.cache_read_input_tokens ?? 0) + (next.cache_read_input_tokens ?? 0),
    reasoning_tokens: (current.reasoning_tokens ?? 0) + (next.reasoning_tokens ?? 0),
    // Preserve inclusivity flag from the latest chunk (same provider per run).
    ...(next.cache_included_in_input || current.cache_included_in_input
      ? { cache_included_in_input: true }
      : {}),
  };
}

/** @deprecated Prefer estimateContextUsedFromUsage from @open-vera/core/context. */
export function estimateContextUsed(usage: Usage | undefined): number {
  return estimateContextUsedFromUsage(usage);
}

export interface RunMetricsTracker {
  markFirstEvent: () => void;
  markFirstDelta: () => void;
  recordUsage: (usage: Usage) => PartnerUsagePayload;
  recordToolUse: () => void;
  snapshot: () => PartnerUsagePayload;
}

export function createRunMetricsTracker(model: string): RunMetricsTracker {
  const startedAt = Date.now();
  const contextMax = getModelContextLimit(model);
  let firstEventAt: number | undefined;
  let firstDeltaAt: number | undefined;
  let accumulated = emptyUsage();
  let lastUsage: Usage | undefined;
  let apiCalls = 0;
  let toolUseCount = 0;

  const markFirstEvent = () => {
    if (firstEventAt == null) firstEventAt = Date.now();
  };

  const build = (): PartnerUsagePayload => {
    const breakdown = latestContextBreakdown(lastUsage);
    const payload: PartnerUsagePayload = {
      input_tokens: accumulated.input_tokens,
      output_tokens: accumulated.output_tokens,
      total_tokens: accumulated.input_tokens + accumulated.output_tokens,
      cache_creation_input_tokens: accumulated.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: accumulated.cache_read_input_tokens ?? 0,
      reasoning_tokens: accumulated.reasoning_tokens ?? 0,
      ...(accumulated.cache_included_in_input || lastUsage?.cache_included_in_input
        ? { cache_included_in_input: true as const }
        : {}),
      context_used: breakdown.context_used,
      context_max: contextMax,
      context_cache_read_tokens: breakdown.context_cache_read_tokens,
      context_cache_write_tokens: breakdown.context_cache_write_tokens,
      context_prompt_tokens: breakdown.context_prompt_tokens,
      duration_ms: Math.max(0, Date.now() - startedAt),
      turns: apiCalls,
      tool_use_count: toolUseCount,
      api_calls: apiCalls,
    };
    if (firstEventAt != null) {
      payload.ttfb_ms = Math.max(0, firstEventAt - startedAt);
    }
    if (firstDeltaAt != null) {
      payload.ttft_ms = Math.max(0, firstDeltaAt - startedAt);
    }
    return payload;
  };

  return {
    markFirstEvent,
    markFirstDelta: () => {
      markFirstEvent();
      if (firstDeltaAt == null) firstDeltaAt = Date.now();
    },
    recordUsage: (usage) => {
      markFirstEvent();
      apiCalls += 1;
      lastUsage = usage;
      accumulated = accumulateUsage(accumulated, usage);
      return build();
    },
    recordToolUse: () => {
      markFirstEvent();
      toolUseCount += 1;
    },
    snapshot: build,
  };
}

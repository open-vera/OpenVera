import type { TokenUsage } from "@/types";

export interface ContextUsageView {
  contextUsed: number;
  contextMax: number;
  percent: number;
  /** Accumulated run totals (this turn / session run). */
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Provider counts cache_* inside input_tokens (OpenAI/DeepSeek) vs alongside it (Anthropic). */
  cacheIncludedInInput: boolean;
  /** Latest API call slices for the context window bar (sum → contextUsed). */
  contextCacheReadTokens: number;
  contextCacheWriteTokens: number;
  contextPromptTokens: number;
  durationMs: number;
  ttfbMs?: number;
  ttftMs?: number;
  turns: number;
  toolUseCount: number;
  apiCalls: number;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeTokenUsage(usage: TokenUsage | null | undefined): ContextUsageView | null {
  if (!usage) return null;

  const inputTokens = asNumber(usage.input_tokens ?? usage.input);
  const outputTokens = asNumber(usage.output_tokens ?? usage.output);
  const cacheReadTokens = asNumber(usage.cache_read_input_tokens);
  const cacheWriteTokens = asNumber(usage.cache_creation_input_tokens);
  const reasoningTokens = asNumber(usage.reasoning_tokens);
  const totalTokens = asNumber(usage.total_tokens ?? usage.total) || inputTokens + outputTokens;
  const cacheTotal = cacheReadTokens + cacheWriteTokens;
  const cacheIncluded =
    usage.cache_included_in_input === true ||
    (cacheTotal > 0 && cacheTotal <= inputTokens);

  // Prefer explicit latest-call breakdown from sidecar.
  let contextCacheReadTokens = asNumber(usage.context_cache_read_tokens);
  let contextCacheWriteTokens = asNumber(usage.context_cache_write_tokens);
  let contextPromptTokens = asNumber(usage.context_prompt_tokens);
  let contextUsed = asNumber(usage.context_used);

  if (!contextUsed && !contextPromptTokens && !contextCacheReadTokens) {
    // Legacy payload: fall back to accumulated fields (best-effort).
    if (cacheIncluded) {
      contextUsed = inputTokens;
      contextCacheReadTokens = cacheReadTokens;
      contextCacheWriteTokens = cacheWriteTokens;
      contextPromptTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
    } else {
      contextUsed = inputTokens + cacheTotal;
      contextCacheReadTokens = cacheReadTokens;
      contextCacheWriteTokens = cacheWriteTokens;
      contextPromptTokens = inputTokens;
    }
  } else if (!contextUsed) {
    contextUsed =
      contextPromptTokens + contextCacheReadTokens + contextCacheWriteTokens;
  }

  const contextMax = asNumber(usage.context_max);
  const percent =
    contextMax > 0 ? Math.max(0, Math.min(100, Math.round((contextUsed / contextMax) * 100))) : 0;

  return {
    contextUsed,
    contextMax,
    percent,
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    cacheIncludedInInput: cacheIncluded,
    contextCacheReadTokens,
    contextCacheWriteTokens,
    contextPromptTokens,
    durationMs: asNumber(usage.duration_ms),
    ttfbMs: asOptionalNumber(usage.ttfb_ms),
    ttftMs: asOptionalNumber(usage.ttft_ms),
    turns: asNumber(usage.turns),
    toolUseCount: asNumber(usage.tool_use_count),
    apiCalls: asNumber(usage.api_calls ?? usage.turns),
  };
}

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1_000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function contextRingTone(percent: number): "good" | "warn" | "bad" | "critical" {
  if (percent >= 95) return "critical";
  if (percent > 80) return "bad";
  if (percent >= 50) return "warn";
  return "good";
}

export interface ContextSegment {
  id: string;
  labelZh: string;
  labelEn: string;
  tokens: number;
  color: string;
}

/**
 * Context-window bar segments from the **latest API call** (sum equals contextUsed).
 * This is current window occupancy after any compression — not a session total.
 * Labels follow provider API terms so they line up with billing docs.
 * Zero-token categories are omitted from the bar/legend.
 */
export function buildContextSegments(view: ContextUsageView): ContextSegment[] {
  const segments: ContextSegment[] = [
    {
      id: "cache-read",
      labelZh: "缓存读",
      labelEn: "Cache read",
      tokens: view.contextCacheReadTokens,
      color: "#c084fc",
    },
    {
      id: "cache-write",
      labelZh: "缓存写",
      labelEn: "Cache write",
      tokens: view.contextCacheWriteTokens,
      color: "#f472b6",
    },
    {
      id: "prompt",
      labelZh: "新增 prompt",
      labelEn: "New prompt",
      tokens: view.contextPromptTokens,
      color: "#7c6a9a",
    },
  ];
  return segments.filter((segment) => segment.tokens > 0);
}

export interface ContextRunTotalRow {
  labelZh: string;
  labelEn: string;
  value: string;
}

/**
 * Accumulated totals for the current agent run (all API calls in this reply).
 * Billing terms, matching provider usage fields 1:1 — no "included in input"
 * claim here, since that differs per provider (see `cacheIncludedInInput`).
 */
export function buildRunTotalRows(view: ContextUsageView): ContextRunTotalRow[] {
  return [
    {
      labelZh: "输入",
      labelEn: "Input",
      value: formatTokenCount(view.inputTokens),
    },
    {
      labelZh: "输出",
      labelEn: "Output",
      value: formatTokenCount(view.outputTokens),
    },
    {
      labelZh: "缓存读",
      labelEn: "Cache read",
      value: formatTokenCount(view.cacheReadTokens),
    },
    {
      labelZh: "缓存写",
      labelEn: "Cache write",
      value: formatTokenCount(view.cacheWriteTokens),
    },
    {
      labelZh: "请求次数",
      labelEn: "Requests",
      value: String(view.apiCalls || view.turns),
    },
  ].filter((row) => {
    if (row.labelEn === "Requests") return true;
    return row.value !== "0";
  });
}

// Session cost 计算 — 定价表、归一化、累加

import type { Usage } from "../types/index.js";
import type { AccumulatedCost, ModelCostRecord } from "./types.js";

// ── Pricing table ─────────────────────────────────────────────────────────────

interface ModelPricing {
  inputPerMToken: number;
  outputPerMToken: number;
  cacheWritePerMToken?: number;
  cacheReadPerMToken?: number;
}

const PRICING_TABLE: Record<string, ModelPricing> = {
  // Anthropic
  "claude-opus-4-6":   { inputPerMToken: 15.00, outputPerMToken: 75.00, cacheWritePerMToken: 18.75, cacheReadPerMToken: 1.50 },
  "claude-sonnet-4-6": { inputPerMToken:  3.00, outputPerMToken: 15.00, cacheWritePerMToken:  3.75, cacheReadPerMToken: 0.30 },
  "claude-haiku-4-5":  { inputPerMToken:  0.80, outputPerMToken:  4.00, cacheWritePerMToken:  1.00, cacheReadPerMToken: 0.08 },
  // OpenAI
  "gpt-4o":            { inputPerMToken:  2.50, outputPerMToken: 10.00 },
  "gpt-4o-mini":       { inputPerMToken:  0.15, outputPerMToken:  0.60 },
  "o3":                { inputPerMToken: 10.00, outputPerMToken: 40.00 },
  "o4-mini":           { inputPerMToken:  1.10, outputPerMToken:  4.40 },
  // Google
  "gemini-2.0-flash":  { inputPerMToken:  0.10, outputPerMToken:  0.40 },
  "gemini-2.5-pro":    { inputPerMToken:  1.25, outputPerMToken: 10.00 },
};

// ── Normalization ─────────────────────────────────────────────────────────────

/**
 * Strip date suffixes (-20250514, -20240229, etc.) and -latest/-preview/-exp
 * from model names so "claude-sonnet-4-6-20251001" maps to "claude-sonnet-4-6".
 */
export function normalizeModelKey(model: string): string {
  return model
    .toLowerCase()
    .replace(/-\d{8}$/, "")           // -20250514
    .replace(/-(latest|preview|exp)$/, ""); // -latest etc.
}

// ── Cost calculation ──────────────────────────────────────────────────────────

/** Returns USD cost for a single API call. Returns 0 if model is not in the pricing table. */
export function calculateCost(usage: Usage, model: string): number {
  const key = normalizeModelKey(model);
  const pricing = PRICING_TABLE[key];
  if (!pricing) return 0;

  const M = 1_000_000;
  let cost =
    (usage.input_tokens * pricing.inputPerMToken +
     usage.output_tokens * pricing.outputPerMToken) / M;

  if (usage.cache_creation_input_tokens && pricing.cacheWritePerMToken) {
    cost += (usage.cache_creation_input_tokens * pricing.cacheWritePerMToken) / M;
  }
  if (usage.cache_read_input_tokens && pricing.cacheReadPerMToken) {
    cost += (usage.cache_read_input_tokens * pricing.cacheReadPerMToken) / M;
  }

  return cost;
}

export function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
  };
}

/**
 * Accumulate a single turn's usage into the session-level cost record.
 * Returns a new AccumulatedCost (immutable update).
 */
export function accumulateCost(
  current: AccumulatedCost,
  usage: Usage,
  model: string,
  _provider: string
): AccumulatedCost {
  const turnCost = calculateCost(usage, model);
  const key = normalizeModelKey(model);

  const prev: ModelCostRecord = current.byModel[key] ?? { usage: emptyUsage(), costUsd: 0 };
  const byModel: Record<string, ModelCostRecord> = {
    ...current.byModel,
    [key]: {
      usage: addUsage(prev.usage, usage),
      costUsd: prev.costUsd + turnCost,
    },
  };

  return {
    totalUsd: current.totalUsd + turnCost,
    byModel,
    totalUsage: addUsage(current.totalUsage, usage),
  };
}

export function emptyAccumulatedCost(): AccumulatedCost {
  return { totalUsd: 0, byModel: {}, totalUsage: emptyUsage() };
}

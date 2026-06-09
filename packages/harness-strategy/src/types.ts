/**
 * Strategy Types — Adaptive strategy system for task-domain-based configuration.
 *
 * Strategies map task domains to optimal prompt/model/tool-policy combinations,
 * tracking historical success rates to enable data-driven auto-tuning.
 */

// ── Enums ──────────────────────────────────────────────────────────────────────

/** Task domains that strategies can be associated with. */
export type StrategyDomain =
  | "coding"
  | "debugging"
  | "research"
  | "writing"
  | "data-analysis"
  | "planning"
  | "review"
  | "testing"
  | "devops"
  | "general";

/** Status of a strategy in its lifecycle. */
export type StrategyStatus =
  | "active"
  | "deprecated"
  | "candidate"  // newly proposed, not yet validated
  | "retired";   // permanently disabled

// ── Configuration Types ────────────────────────────────────────────────────────

/** Model configuration within a strategy. */
export interface ModelConfig {
  /** Model identifier (e.g., "claude-sonnet-4-6", "gpt-4o") */
  modelId: string;
  /** Temperature setting (0-1) */
  temperature?: number;
  /** Max tokens for generation */
  maxTokens?: number;
  /** System prompt override */
  systemPrompt?: string;
}

/** Tool policy — which tools are allowed/blocked for this strategy. */
export interface ToolPolicy {
  /** Explicitly allowed tools (if set, only these are available) */
  allow?: string[];
  /** Explicitly blocked tools */
  deny?: string[];
  /** Tool-specific parameter constraints */
  constraints?: Record<string, Record<string, unknown>>;
}

/** Prompt template with variable substitution support. */
export interface PromptTemplate {
  /** Template string with {{variable}} placeholders */
  template: string;
  /** Required variables that must be provided */
  requiredVars: string[];
  /** Default values for optional variables */
  defaults?: Record<string, string>;
}

// ── Strategy ───────────────────────────────────────────────────────────────────

/** A strategy maps a task domain to a specific configuration. */
export interface Strategy {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Task domain this strategy targets */
  domain: StrategyDomain;
  /** Current status */
  status: StrategyStatus;
  /** Version number (incremented on updates) */
  version: number;
  /** Prompt template for this strategy */
  prompt: PromptTemplate;
  /** Model configuration */
  model: ModelConfig;
  /** Tool usage policy */
  toolPolicy: ToolPolicy;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
  /** Tags for flexible categorization */
  tags?: string[];
  /** Human-readable description */
  description?: string;
}

/** Outcome record for a strategy execution. */
export interface StrategyOutcome {
  /** Strategy ID that was used */
  strategyId: string;
  /** Whether the task succeeded */
  success: boolean;
  /** Duration in milliseconds */
  durationMs: number;
  /** Token usage */
  tokenUsage?: { input: number; output: number };
  /** Error message if failed */
  error?: string;
  /** Timestamp (ISO 8601) */
  timestamp: string;
}

// ── Statistics ─────────────────────────────────────────────────────────────────

/** Aggregated statistics for a strategy. */
export interface StrategyStats {
  strategyId: string;
  totalRuns: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgDurationMs: number;
  totalTokens: number;
  lastRunAt: string | null;
}

/** Comparison between two strategies on the same domain. */
export interface StrategyComparison {
  domain: StrategyDomain;
  strategyA: StrategyStats;
  strategyB: StrategyStats;
  winner: string; // strategy ID
  confidence: number; // 0-1, based on sample size
  details: string;
}

// ── Trend & Windowed Stats ──────────────────────────────────────────────────

/** Direction of success rate trend. */
export type TrendDirection = "improving" | "declining" | "stable" | "insufficient_data";

/** Trend analysis result for a strategy. */
export interface StrategyTrend {
  strategyId: string;
  /** Overall trend direction */
  direction: TrendDirection;
  /** Recent window success rate */
  recentRate: number;
  /** Older window success rate */
  olderRate: number;
  /** Rate delta (recent - older) */
  delta: number;
  /** Number of runs in recent window */
  recentRuns: number;
  /** Number of runs in older window */
  olderRuns: number;
  /** Minimum runs required for a reliable trend */
  minRunsForTrend: number;
}

/** Predefined time windows for windowed statistics. */
export type TimeWindow = "1h" | "6h" | "24h" | "7d" | "30d";

/** Domain-level summary across all strategies. */
export interface DomainSummary {
  domain: StrategyDomain;
  totalStrategies: number;
  activeStrategies: number;
  totalRuns: number;
  overallSuccessRate: number;
  bestStrategyId: string | null;
  bestSuccessRate: number;
  worstStrategyId: string | null;
  worstSuccessRate: number;
}

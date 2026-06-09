/**
 * Auto-Tuner — Automatically select optimal strategy combinations based on historical data.
 *
 * Uses UCB1 (Upper Confidence Bound) for exploration-exploitation tradeoff,
 * weighted composite scoring combining success rate, speed, and cost efficiency,
 * and generates actionable recommendations for each task domain.
 */

import type {
  Strategy,
  StrategyDomain,
  StrategyOutcome,
  StrategyStats,
} from "./types.js";
import { StrategyStore } from "./strategy-store.js";

// ── Types ────────────────────────────────────────────────────────────────────────

/** Composite score breakdown for a strategy. */
export interface CompositeScore {
  strategyId: string;
  /** Overall composite score (0-1) */
  score: number;
  /** Success rate component */
  successComponent: number;
  /** Speed component (normalized inverse of avg duration) */
  speedComponent: number;
  /** Cost efficiency component (normalized inverse of token usage per run) */
  costComponent: number;
  /** UCB1 exploration bonus */
  explorationBonus: number;
  /** Total runs for this strategy */
  totalRuns: number;
}

/** Recommendation for a domain. */
export interface StrategyRecommendation {
  domain: StrategyDomain;
  /** Currently recommended strategy ID (may be same as current) */
  recommendedId: string;
  /** Current best active strategy ID (if any) */
  currentBestId: string | null;
  /** Whether the recommendation is a change from current */
  isChange: boolean;
  /** Reason for the recommendation */
  reason: string;
  /** Composite score of the recommended strategy */
  score: number;
  /** All candidate scores for this domain */
  candidates: CompositeScore[];
}

/** Result of an optimization cycle. */
export interface OptimizationResult {
  /** Timestamp of the cycle */
  timestamp: string;
  /** Per-domain recommendations */
  recommendations: StrategyRecommendation[];
  /** Domains that had no active strategies */
  emptyDomains: StrategyDomain[];
  /** Total strategies analyzed */
  totalStrategiesAnalyzed: number;
  /** Strategies that were auto-tuned (promoted/deprecated) */
  autoTuned: string[];
}

/** Configuration for the AutoTuner. */
export interface AutoTunerConfig {
  /** Weight for success rate in composite score (default 0.6) */
  successWeight: number;
  /** Weight for speed in composite score (default 0.2) */
  speedWeight: number;
  /** Weight for cost efficiency in composite score (default 0.2) */
  costWeight: number;
  /** Exploration coefficient for UCB1 (default 1.414 = sqrt(2)) */
  explorationCoeff: number;
  /** Minimum total runs across all strategies in a domain before making recommendations */
  minDomainRuns: number;
  /** Minimum runs for a single strategy before it can be recommended */
  minStrategyRuns: number;
  /** Reference duration for speed normalization (ms, default 5000) */
  referenceDurationMs: number;
  /** Reference tokens per run for cost normalization (default 1000) */
  referenceTokensPerRun: number;
}

const DEFAULT_CONFIG: AutoTunerConfig = {
  successWeight: 0.6,
  speedWeight: 0.2,
  costWeight: 0.2,
  explorationCoeff: 1.414,
  minDomainRuns: 5,
  minStrategyRuns: 2,
  referenceDurationMs: 5000,
  referenceTokensPerRun: 1000,
};

// ── AutoTuner ────────────────────────────────────────────────────────────────────

export class AutoTuner {
  private store: StrategyStore;
  private config: AutoTunerConfig;
  private history: OptimizationResult[] = [];

  constructor(store: StrategyStore, config?: Partial<AutoTunerConfig>) {
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Composite Scoring ──────────────────────────────────────────────────────────

  /**
   * Compute composite score for a strategy.
   * Combines success rate, speed, and cost efficiency with configurable weights.
   */
  computeCompositeScore(strategyId: string): CompositeScore {
    const stats = this.store.getStats(strategyId);
    return this.scoreFromStats(strategyId, stats);
  }

  private scoreFromStats(strategyId: string, stats: StrategyStats): CompositeScore {
    // Success component: direct success rate (0-1)
    const successComponent = stats.successRate;

    // Speed component: inverse of avg duration, normalized and clamped to [0, 1]
    const speedComponent =
      stats.avgDurationMs > 0
        ? Math.min(1, this.config.referenceDurationMs / stats.avgDurationMs)
        : 0;

    // Cost component: inverse of tokens-per-run, normalized
    const tokensPerRun =
      stats.totalRuns > 0 ? stats.totalTokens / stats.totalRuns : 0;
    const costComponent =
      tokensPerRun > 0
        ? Math.min(1, this.config.referenceTokensPerRun / tokensPerRun)
        : 0;

    // Weighted base score
    const baseScore =
      this.config.successWeight * successComponent +
      this.config.speedWeight * speedComponent +
      this.config.costWeight * costComponent;

    // UCB1 exploration bonus
    const totalDomainRuns = this.getTotalRunsForStrategy(strategyId);
    const explorationBonus =
      stats.totalRuns > 0
        ? this.config.explorationCoeff * Math.sqrt(Math.log(Math.max(1, totalDomainRuns)) / stats.totalRuns)
        : Infinity; // Never-tried strategies get infinite bonus

    const score = baseScore + explorationBonus;

    return {
      strategyId,
      score,
      successComponent,
      speedComponent,
      costComponent,
      explorationBonus,
      totalRuns: stats.totalRuns,
    };
  }

  /**
   * Get the total number of runs across all strategies (for UCB1 normalization).
   */
  private getTotalRunsForStrategy(_strategyId: string): number {
    // Use all outcomes in the store as the total arm pulls
    const allStats = this.store.getAllStats();
    return allStats.reduce((sum, s) => sum + s.totalRuns, 0);
  }

  // ── Domain Optimization ────────────────────────────────────────────────────────

  /**
   * Select the optimal strategy for a given domain using UCB1 scoring.
   * Returns the scored candidates sorted by composite score (best first).
   */
  scoreDomain(domain: StrategyDomain): CompositeScore[] {
    const strategies = this.store.list({ domain });
    if (strategies.length === 0) return [];

    const scored = strategies.map((s) => this.computeCompositeScore(s.id));
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /**
   * Get the recommended strategy for a domain.
   * Only considers active and candidate strategies.
   */
  selectOptimal(domain: StrategyDomain): CompositeScore | undefined {
    const eligible = this.store.list({ domain }).filter(
      (s) => s.status === "active" || s.status === "candidate",
    );
    if (eligible.length === 0) return undefined;

    const scored = eligible.map((s) => this.computeCompositeScore(s.id));
    scored.sort((a, b) => b.score - a.score);
    return scored[0];
  }

  // ── Optimization Cycle ─────────────────────────────────────────────────────────

  /**
   * Run a full optimization cycle across all domains.
   *
   * For each domain:
   * 1. Score all strategies using composite scoring + UCB1
   * 2. Generate recommendation (best strategy)
   * 3. Run auto-tune (promote/deprecate based on success rates)
   *
   * Returns the full optimization result with recommendations.
   */
  runOptimizationCycle(): OptimizationResult {
    const domains = this.getAllDomains();
    const recommendations: StrategyRecommendation[] = [];
    const emptyDomains: StrategyDomain[] = [];

    let totalAnalyzed = 0;

    for (const domain of domains) {
      const candidates = this.scoreDomain(domain);
      totalAnalyzed += candidates.length;

      if (candidates.length === 0) {
        emptyDomains.push(domain);
        continue;
      }

      const best = candidates[0]!;
      const currentBest = this.store.getBestForDomain(domain, this.config.minStrategyRuns);

      const hasEnoughData = this.hasEnoughDomainData(domain);

      let reason: string;
      if (!hasEnoughData) {
        reason = `Insufficient data (need ${this.config.minDomainRuns} runs across domain)`;
      } else if (best.explorationBonus === Infinity) {
        reason = "Unexplored strategy — needs initial testing";
      } else if (currentBest && best.strategyId === currentBest.id) {
        reason = `Current best confirmed (score: ${best.score.toFixed(3)})`;
      } else {
        reason = `Better option found (score: ${best.score.toFixed(3)} vs current)`;
      }

      recommendations.push({
        domain,
        recommendedId: best.strategyId,
        currentBestId: currentBest?.id ?? null,
        isChange: currentBest ? best.strategyId !== currentBest.id : true,
        reason,
        score: best.score,
        candidates,
      });
    }

    // Run auto-tune for promote/deprecate
    const autoTuned = this.store.autoTune(
      0.7, // promote threshold
      0.3, // deprecate threshold
      this.config.minStrategyRuns,
    );

    const result: OptimizationResult = {
      timestamp: new Date().toISOString(),
      recommendations,
      emptyDomains,
      totalStrategiesAnalyzed: totalAnalyzed,
      autoTuned,
    };

    this.history.push(result);
    return result;
  }

  /**
   * Check if a domain has enough data for reliable recommendations.
   */
  private hasEnoughDomainData(domain: StrategyDomain): boolean {
    const strategies = this.store.list({ domain });
    let totalRuns = 0;
    for (const s of strategies) {
      totalRuns += this.store.getStats(s.id).totalRuns;
    }
    return totalRuns >= this.config.minDomainRuns;
  }

  // ── Batch Recommendations ──────────────────────────────────────────────────────

  /**
   * Get recommendations for all domains in one call.
   * Returns a map of domain → recommended strategy ID.
   */
  getRecommendations(): Map<StrategyDomain, string> {
    const result = new Map<StrategyDomain, string>();
    const domains = this.getAllDomains();

    for (const domain of domains) {
      const optimal = this.selectOptimal(domain);
      if (optimal) {
        result.set(domain, optimal.strategyId);
      }
    }

    return result;
  }

  /**
   * Get the top N strategies across all domains, ranked by composite score.
   */
  getTopStrategies(n = 5): CompositeScore[] {
    const allStrategies = this.store.list({ status: "active" });
    const scored = allStrategies.map((s) => this.computeCompositeScore(s.id));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, n);
  }

  // ── History ────────────────────────────────────────────────────────────────────

  /**
   * Get optimization history.
   */
  getHistory(): OptimizationResult[] {
    return [...this.history];
  }

  /**
   * Get the last N optimization results.
   */
  getRecentHistory(n = 5): OptimizationResult[] {
    return this.history.slice(-n);
  }

  /**
   * Check if a specific domain's recommendation has changed over recent cycles.
   */
  getRecommendationStability(domain: StrategyDomain): {
    stable: boolean;
    changes: number;
    currentRecommendation: string | null;
  } {
    const recentCycles = this.getRecentHistory(5);
    const recommendations = recentCycles
      .flatMap((c) => c.recommendations)
      .filter((r) => r.domain === domain);

    if (recommendations.length === 0) {
      return { stable: true, changes: 0, currentRecommendation: null };
    }

    let changes = 0;
    for (let i = 1; i < recommendations.length; i++) {
      if (recommendations[i]!.recommendedId !== recommendations[i - 1]!.recommendedId) {
        changes++;
      }
    }

    const current = recommendations[recommendations.length - 1]!;
    return {
      stable: changes === 0,
      changes,
      currentRecommendation: current.recommendedId,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────

  private getAllDomains(): StrategyDomain[] {
    return [
      "coding", "debugging", "research", "writing",
      "data-analysis", "planning", "review", "testing", "devops", "general",
    ];
  }

  /**
   * Get current configuration.
   */
  getConfig(): AutoTunerConfig {
    return { ...this.config };
  }

  /**
   * Update configuration.
   */
  updateConfig(updates: Partial<AutoTunerConfig>): void {
    this.config = { ...this.config, ...updates };
  }
}

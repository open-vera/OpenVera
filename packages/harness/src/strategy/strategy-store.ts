/**
 * Strategy Store — Persistent storage for adaptive strategies.
 *
 * Stores strategies with outcome tracking, enabling auto-tuning
 * based on historical success rates per task domain.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Strategy,
  StrategyDomain,
  StrategyStatus,
  StrategyOutcome,
  StrategyStats,
  StrategyComparison,
  StrategyTrend,
  TrendDirection,
  TimeWindow,
  DomainSummary,
} from "./types.js";

// ── Filter Types ───────────────────────────────────────────────────────────────

export interface StrategyFilter {
  domain?: StrategyDomain;
  status?: StrategyStatus;
  tags?: string[];
  since?: string;
}

// ── Strategy Store ─────────────────────────────────────────────────────────────

export class StrategyStore {
  private strategies: Strategy[] = [];
  private outcomes: StrategyOutcome[] = [];
  private strategiesPath: string;
  private outcomesPath: string;

  constructor(storageDir: string) {
    this.strategiesPath = `${storageDir}/strategies.json`;
    this.outcomesPath = `${storageDir}/strategy-outcomes.json`;
    this.load();
  }

  // ── Strategy CRUD ──────────────────────────────────────────────────────────

  /**
   * Add a new strategy. Returns false if ID already exists.
   */
  add(strategy: Strategy): boolean {
    if (this.strategies.some((s) => s.id === strategy.id)) {
      return false;
    }
    this.strategies.push(strategy);
    this.saveStrategies();
    return true;
  }

  /**
   * Get a strategy by ID.
   */
  get(id: string): Strategy | undefined {
    return this.strategies.find((s) => s.id === id);
  }

  /**
   * Update an existing strategy. Increments version and updates timestamp.
   */
  update(id: string, updates: Partial<Omit<Strategy, "id" | "createdAt">>): boolean {
    const idx = this.strategies.findIndex((s) => s.id === id);
    if (idx < 0) return false;

    const existing = this.strategies[idx]!;
    this.strategies[idx] = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.saveStrategies();
    return true;
  }

  /**
   * Remove a strategy and its outcomes.
   */
  remove(id: string): boolean {
    const idx = this.strategies.findIndex((s) => s.id === id);
    if (idx < 0) return false;

    this.strategies.splice(idx, 1);
    this.outcomes = this.outcomes.filter((o) => o.strategyId !== id);
    this.saveStrategies();
    this.saveOutcomes();
    return true;
  }

  /**
   * List strategies with optional filter.
   */
  list(filter?: StrategyFilter): Strategy[] {
    let results = [...this.strategies];

    if (filter?.domain) {
      results = results.filter((s) => s.domain === filter.domain);
    }
    if (filter?.status) {
      results = results.filter((s) => s.status === filter.status);
    }
    if (filter?.tags && filter.tags.length > 0) {
      results = results.filter((s) =>
        filter.tags!.some((tag) => s.tags?.includes(tag))
      );
    }
    if (filter?.since) {
      results = results.filter((s) => s.createdAt >= filter.since!);
    }

    return results;
  }

  /**
   * Get all active strategies for a specific domain.
   */
  getActiveByDomain(domain: StrategyDomain): Strategy[] {
    return this.list({ domain, status: "active" });
  }

  /**
   * Get the best strategy for a domain based on success rate.
   * Requires minimum number of runs for statistical significance.
   */
  getBestForDomain(domain: StrategyDomain, minRuns = 3): Strategy | undefined {
    const active = this.getActiveByDomain(domain);
    if (active.length === 0) return undefined;

    let bestStrategy: Strategy | undefined;
    let bestRate = -1;

    for (const strategy of active) {
      const stats = this.getStats(strategy.id);
      if (stats.totalRuns < minRuns) continue;
      if (stats.successRate > bestRate) {
        bestRate = stats.successRate;
        bestStrategy = strategy;
      }
    }

    // If no strategy has enough runs, return the first active one
    if (!bestStrategy && active.length > 0) {
      return active[0];
    }

    return bestStrategy;
  }

  // ── Outcome Tracking ───────────────────────────────────────────────────────

  /**
   * Record an execution outcome for a strategy.
   */
  recordOutcome(outcome: StrategyOutcome): void {
    this.outcomes.push(outcome);
    this.saveOutcomes();
  }

  /**
   * Get all outcomes for a specific strategy.
   */
  getOutcomes(strategyId: string): StrategyOutcome[] {
    return this.outcomes.filter((o) => o.strategyId === strategyId);
  }

  /**
   * Get aggregated statistics for a strategy.
   */
  getStats(strategyId: string): StrategyStats {
    return this.computeStats(strategyId, this.getOutcomes(strategyId));
  }

  private computeStats(strategyId: string, outcomes: StrategyOutcome[]): StrategyStats {
    const totalRuns = outcomes.length;
    const successCount = outcomes.filter((o) => o.success).length;
    const failureCount = totalRuns - successCount;
    const successRate = totalRuns > 0 ? successCount / totalRuns : 0;

    const totalDuration = outcomes.reduce((sum, o) => sum + o.durationMs, 0);
    const avgDurationMs = totalRuns > 0 ? totalDuration / totalRuns : 0;

    const totalTokens = outcomes.reduce(
      (sum, o) => sum + (o.tokenUsage ? o.tokenUsage.input + o.tokenUsage.output : 0),
      0
    );

    const lastRunAt =
      outcomes.length > 0
        ? outcomes[outcomes.length - 1]!.timestamp
        : null;

    return {
      strategyId,
      totalRuns,
      successCount,
      failureCount,
      successRate,
      avgDurationMs,
      totalTokens,
      lastRunAt,
    };
  }

  /**
   * Compare two strategies on the same domain.
   */
  compare(strategyIdA: string, strategyIdB: string): StrategyComparison | undefined {
    const a = this.get(strategyIdA);
    const b = this.get(strategyIdB);
    if (!a || !b) return undefined;

    const statsA = this.getStats(strategyIdA);
    const statsB = this.getStats(strategyIdB);

    const totalRuns = statsA.totalRuns + statsB.totalRuns;
    const confidence = Math.min(1, totalRuns / 20); // Full confidence at 20+ total runs

    const winner =
      statsA.successRate >= statsB.successRate ? strategyIdA : strategyIdB;

    const details =
      `${a.name} (${(statsA.successRate * 100).toFixed(1)}%, n=${statsA.totalRuns}) ` +
      `vs ${b.name} (${(statsB.successRate * 100).toFixed(1)}%, n=${statsB.totalRuns})`;

    return {
      domain: a.domain,
      strategyA: statsA,
      strategyB: statsB,
      winner,
      confidence,
      details,
    };
  }

  /**
   * Get statistics for all strategies, optionally filtered by domain.
   */
  getAllStats(domain?: StrategyDomain): StrategyStats[] {
    const strategies = domain
      ? this.list({ domain })
      : this.strategies;
    return strategies.map((s) => this.getStats(s.id));
  }

  // ── Time-Windowed Statistics ───────────────────────────────────────────────

  private static readonly WINDOW_MS: Record<TimeWindow, number> = {
    "1h": 3_600_000,
    "6h": 21_600_000,
    "24h": 86_400_000,
    "7d": 604_800_000,
    "30d": 2_592_000_000,
  };

  /**
   * Get aggregated statistics for a strategy within a time window.
   * Only outcomes with timestamp >= (now - window) are included.
   */
  getStatsWindowed(strategyId: string, window: TimeWindow): StrategyStats {
    const windowMs = StrategyStore.WINDOW_MS[window];
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const all = this.getOutcomes(strategyId);
    const windowed = all.filter((o) => o.timestamp >= cutoff);
    return this.computeStats(strategyId, windowed);
  }

  /**
   * Get windowed stats for an arbitrary duration in milliseconds.
   */
  getStatsSince(strategyId: string, durationMs: number): StrategyStats {
    const cutoff = new Date(Date.now() - durationMs).toISOString();
    const all = this.getOutcomes(strategyId);
    const windowed = all.filter((o) => o.timestamp >= cutoff);
    return this.computeStats(strategyId, windowed);
  }

  // ── Trend Detection ───────────────────────────────────────────────────────

  /**
   * Analyze success rate trend by comparing a recent window to an older window.
   * Default: recent = last 24h, older = 24h before that.
   */
  getTrend(
    strategyId: string,
    recentWindow: TimeWindow = "24h",
    olderWindow: TimeWindow = "24h",
    minRunsForTrend = 3,
  ): StrategyTrend {
    const recentMs = StrategyStore.WINDOW_MS[recentWindow];
    const olderMs = StrategyStore.WINDOW_MS[olderWindow];
    const now = Date.now();

    const recentCutoff = new Date(now - recentMs).toISOString();
    const olderCutoff = new Date(now - recentMs - olderMs).toISOString();

    const all = this.getOutcomes(strategyId);
    const recentOutcomes = all.filter((o) => o.timestamp >= recentCutoff);
    const olderOutcomes = all.filter(
      (o) => o.timestamp >= olderCutoff && o.timestamp < recentCutoff,
    );

    const recentRate =
      recentOutcomes.length > 0
        ? recentOutcomes.filter((o) => o.success).length / recentOutcomes.length
        : 0;
    const olderRate =
      olderOutcomes.length > 0
        ? olderOutcomes.filter((o) => o.success).length / olderOutcomes.length
        : 0;

    const delta = recentRate - olderRate;
    const direction = this.classifyTrend(
      recentOutcomes.length,
      olderOutcomes.length,
      delta,
      minRunsForTrend,
    );

    return {
      strategyId,
      direction,
      recentRate,
      olderRate,
      delta,
      recentRuns: recentOutcomes.length,
      olderRuns: olderOutcomes.length,
      minRunsForTrend,
    };
  }

  private classifyTrend(
    recentCount: number,
    olderCount: number,
    delta: number,
    minRuns: number,
  ): TrendDirection {
    if (recentCount < minRuns && olderCount < minRuns) {
      return "insufficient_data";
    }
    const threshold = 0.05; // 5% change to be considered significant
    if (delta > threshold) return "improving";
    if (delta < -threshold) return "declining";
    return "stable";
  }

  // ── Auto-Status Transitions ───────────────────────────────────────────────

  /**
   * Automatically promote/deprecate strategies based on historical performance.
   *
   * Rules:
   * - candidate → active: successRate >= promoteThreshold with >= minRuns
   * - active → deprecated: successRate < deprecateThreshold with >= minRuns
   * - deprecated/retired: unchanged (manual only)
   *
   * Returns the list of strategy IDs whose status was changed.
   */
  autoTune(
    promoteThreshold = 0.7,
    deprecateThreshold = 0.3,
    minRuns = 5,
  ): string[] {
    const changed: string[] = [];

    for (const strategy of this.strategies) {
      const stats = this.getStats(strategy.id);
      if (stats.totalRuns < minRuns) continue;

      if (
        strategy.status === "candidate" &&
        stats.successRate >= promoteThreshold
      ) {
        strategy.status = "active";
        strategy.version++;
        strategy.updatedAt = new Date().toISOString();
        changed.push(strategy.id);
      } else if (
        strategy.status === "active" &&
        stats.successRate < deprecateThreshold
      ) {
        strategy.status = "deprecated";
        strategy.version++;
        strategy.updatedAt = new Date().toISOString();
        changed.push(strategy.id);
      }
    }

    if (changed.length > 0) {
      this.saveStrategies();
    }
    return changed;
  }

  // ── Domain Summary ────────────────────────────────────────────────────────

  /**
   * Get a summary of all strategies within a domain.
   */
  getDomainSummary(domain: StrategyDomain): DomainSummary {
    const strategies = this.list({ domain });
    const active = strategies.filter((s) => s.status === "active");

    let totalRuns = 0;
    let totalSuccess = 0;
    let bestStrategyId: string | null = null;
    let bestRate = -1;
    let worstStrategyId: string | null = null;
    let worstRate = 2;

    for (const s of strategies) {
      const stats = this.getStats(s.id);
      totalRuns += stats.totalRuns;
      totalSuccess += stats.successCount;

      if (stats.totalRuns > 0) {
        if (stats.successRate > bestRate) {
          bestRate = stats.successRate;
          bestStrategyId = s.id;
        }
        if (stats.successRate < worstRate) {
          worstRate = stats.successRate;
          worstStrategyId = s.id;
        }
      }
    }

    return {
      domain,
      totalStrategies: strategies.length,
      activeStrategies: active.length,
      totalRuns,
      overallSuccessRate: totalRuns > 0 ? totalSuccess / totalRuns : 0,
      bestStrategyId,
      bestSuccessRate: bestRate >= 0 ? bestRate : 0,
      worstStrategyId,
      worstSuccessRate: worstRate <= 1 ? worstRate : 0,
    };
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  /**
   * Get count of strategies.
   */
  count(): number {
    return this.strategies.length;
  }

  /**
   * Get counts by status.
   */
  countByStatus(): Record<StrategyStatus, number> {
    const counts: Record<StrategyStatus, number> = {
      active: 0,
      deprecated: 0,
      candidate: 0,
      retired: 0,
    };
    for (const s of this.strategies) {
      counts[s.status]++;
    }
    return counts;
  }

  /**
   * Get counts by domain.
   */
  countByDomain(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const s of this.strategies) {
      counts[s.domain] = (counts[s.domain] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Find strategies with low success rates (below threshold).
   */
  findUnderperforming(threshold = 0.5, minRuns = 5): Strategy[] {
    return this.strategies.filter((s) => {
      const stats = this.getStats(s.id);
      return stats.totalRuns >= minRuns && stats.successRate < threshold;
    });
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private load(): void {
    if (existsSync(this.strategiesPath)) {
      try {
        const content = readFileSync(this.strategiesPath, "utf-8");
        this.strategies = JSON.parse(content) as Strategy[];
      } catch {
        this.strategies = [];
      }
    }
    if (existsSync(this.outcomesPath)) {
      try {
        const content = readFileSync(this.outcomesPath, "utf-8");
        this.outcomes = JSON.parse(content) as StrategyOutcome[];
      } catch {
        this.outcomes = [];
      }
    }
  }

  private saveStrategies(): void {
    const dir = dirname(this.strategiesPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.strategiesPath, JSON.stringify(this.strategies, null, 2), "utf-8");
  }

  private saveOutcomes(): void {
    const dir = dirname(this.outcomesPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.outcomesPath, JSON.stringify(this.outcomes, null, 2), "utf-8");
  }
}

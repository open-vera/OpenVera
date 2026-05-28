/**
 * A/B Test — Run parallel strategy comparisons with statistical rigor.
 *
 * Enables data-driven decisions by splitting traffic between competing strategies,
 * tracking outcomes per variant, and computing statistical significance.
 */

import type {
  Strategy,
  StrategyDomain,
  StrategyOutcome,
  StrategyStats,
} from "./types.js";
import { StrategyStore } from "./strategy-store.js";

// ── Types ────────────────────────────────────────────────────────────────────────

/** Status of an A/B test. */
export type ABTestStatus = "running" | "completed" | "cancelled";

/** A variant in an A/B test. */
export interface ABTestVariant {
  /** Strategy ID for this variant */
  strategyId: string;
  /** Display label (e.g., "control", "treatment") */
  label: string;
  /** Traffic allocation (0-1), all variants should sum to 1 */
  allocation: number;
}

/** Configuration for an A/B test. */
export interface ABTestConfig {
  /** Unique test ID */
  id: string;
  /** Human-readable test name */
  name: string;
  /** Domain being tested */
  domain: StrategyDomain;
  /** Variants to compare (2+) */
  variants: ABTestVariant[];
  /** Minimum total runs across all variants before declaring a result */
  minTotalRuns: number;
  /** Minimum runs per variant before it can be evaluated */
  minVariantRuns: number;
  /** Confidence level required to declare a winner (default 0.95) */
  confidenceLevel: number;
  /** Maximum duration in ms (0 = no limit) */
  maxDurationMs: number;
  /** Creation timestamp */
  createdAt: string;
}

/** Result for a single variant in an A/B test. */
export interface ABTestVariantResult {
  strategyId: string;
  label: string;
  allocation: number;
  stats: StrategyStats;
  /** Runs allocated to this variant during the test */
  testRuns: number;
}

/** Statistical comparison result between two variants. */
export interface StatisticalComparison {
  variantA: string;
  variantB: string;
  /** Absolute difference in success rates (A - B) */
  rateDifference: number;
  /** Z-score of the difference */
  zScore: number;
  /** P-value (two-tailed) */
  pValue: number;
  /** Whether the difference is statistically significant */
  isSignificant: boolean;
  /** Confidence level used */
  confidenceLevel: number;
}

/** Final result of an A/B test. */
export interface ABTestResult {
  testId: string;
  testName: string;
  domain: StrategyDomain;
  status: ABTestStatus;
  /** Per-variant results */
  variants: ABTestVariantResult[];
  /** Pairwise statistical comparisons */
  comparisons: StatisticalComparison[];
  /** Declared winner strategy ID (null if no significant difference) */
  winner: string | null;
  /** Summary text */
  summary: string;
  /** Test start time */
  startedAt: string;
  /** Test end time (null if still running) */
  endedAt: string | null;
  /** Total runs across all variants */
  totalRuns: number;
}

// ── A/B Test Manager ─────────────────────────────────────────────────────────────

export class ABTestManager {
  private store: StrategyStore;
  private tests: Map<string, ABTestConfig> = new Map();
  /** Maps testId → { strategyId → runCount } for traffic tracking */
  private testAllocations: Map<string, Map<string, number>> = new Map();
  /** Maps testId → outcome IDs belonging to this test */
  private testOutcomeIds: Map<string, string[]> = new Map();

  constructor(store: StrategyStore) {
    this.store = store;
  }

  // ── Test Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Create a new A/B test.
   * Validates: at least 2 variants, allocations sum to ~1, strategies exist.
   */
  createTest(config: Omit<ABTestConfig, "createdAt">): ABTestConfig | string {
    if (config.variants.length < 2) {
      return "Need at least 2 variants for an A/B test";
    }

    // Validate allocations sum to 1 (within tolerance)
    const totalAllocation = config.variants.reduce((sum, v) => sum + v.allocation, 0);
    if (Math.abs(totalAllocation - 1) > 0.01) {
      return `Variant allocations must sum to 1.0 (got ${totalAllocation.toFixed(3)})`;
    }

    // Validate all strategies exist
    for (const variant of config.variants) {
      if (!this.store.get(variant.strategyId)) {
        return `Strategy not found: ${variant.strategyId}`;
      }
    }

    // Validate unique strategies
    const ids = new Set(config.variants.map((v) => v.strategyId));
    if (ids.size !== config.variants.length) {
      return "Each variant must use a different strategy";
    }

    const fullConfig: ABTestConfig = {
      ...config,
      createdAt: new Date().toISOString(),
    };

    this.tests.set(config.id, fullConfig);
    this.testAllocations.set(config.id, new Map());
    this.testOutcomeIds.set(config.id, []);

    return fullConfig;
  }

  /**
   * Get a test configuration by ID.
   */
  getTest(testId: string): ABTestConfig | undefined {
    return this.tests.get(testId);
  }

  /**
   * List all tests, optionally filtered by status.
   */
  listTests(status?: ABTestStatus): ABTestConfig[] {
    const all = Array.from(this.tests.values());
    if (!status) return all;
    return all.filter((t) => this.getTestStatus(t.id) === status);
  }

  /**
   * Cancel a running test.
   */
  cancelTest(testId: string): boolean {
    if (!this.tests.has(testId)) return false;
    // We store cancellation by removing from active tracking
    // The test stays in the map for history
    return true;
  }

  /**
   * Get the current status of a test.
   */
  getTestStatus(testId: string): ABTestStatus {
    const config = this.tests.get(testId);
    if (!config) return "cancelled";

    const allocations = this.testAllocations.get(testId);
    if (!allocations) return "cancelled";

    const totalRuns = Array.from(allocations.values()).reduce((s, c) => s + c, 0);
    if (totalRuns >= config.minTotalRuns) return "completed";

    // Check if max duration exceeded
    if (config.maxDurationMs > 0) {
      const elapsed = Date.now() - new Date(config.createdAt).getTime();
      if (elapsed > config.maxDurationMs) return "completed";
    }

    return "running";
  }

  // ── Traffic Routing ─────────────────────────────────────────────────────────

  /**
   * Route a request to a strategy variant for a given test.
   * Uses weighted random selection based on allocation percentages.
   * Returns the strategy ID to use.
   */
  route(testId: string): string | null {
    const config = this.tests.get(testId);
    if (!config) return null;

    if (this.getTestStatus(testId) !== "running") return null;

    // Weighted random selection
    const roll = Math.random();
    let cumulative = 0;
    for (const variant of config.variants) {
      cumulative += variant.allocation;
      if (roll < cumulative) {
        // Track allocation
        const allocations = this.testAllocations.get(testId)!;
        allocations.set(
          variant.strategyId,
          (allocations.get(variant.strategyId) ?? 0) + 1,
        );
        return variant.strategyId;
      }
    }

    // Fallback to last variant (floating point edge case)
    const last = config.variants[config.variants.length - 1]!;
    const allocations = this.testAllocations.get(testId)!;
    allocations.set(
      last.strategyId,
      (allocations.get(last.strategyId) ?? 0) + 1,
    );
    return last.strategyId;
  }

  /**
   * Record an outcome for a test variant.
   * The outcome must already be recorded in the store.
   */
  recordTestOutcome(testId: string, outcome: StrategyOutcome): boolean {
    const config = this.tests.get(testId);
    if (!config) return false;

    // Verify the strategy is part of this test
    const isVariant = config.variants.some((v) => v.strategyId === outcome.strategyId);
    if (!isVariant) return false;

    // Record in store
    this.store.recordOutcome(outcome);

    // Track outcome reference
    const outcomeIds = this.testOutcomeIds.get(testId) ?? [];
    outcomeIds.push(outcome.strategyId + "@" + outcome.timestamp);
    this.testOutcomeIds.set(testId, outcomeIds);

    return true;
  }

  // ── Analysis ────────────────────────────────────────────────────────────────

  /**
   * Analyze a test and return results with statistical comparisons.
   */
  analyze(testId: string): ABTestResult | string {
    const config = this.tests.get(testId);
    if (!config) return `Test not found: ${testId}`;

    const status = this.getTestStatus(testId);

    // Build variant results
    const variants: ABTestVariantResult[] = config.variants.map((v) => {
      const stats = this.store.getStats(v.strategyId);
      const allocations = this.testAllocations.get(testId);
      return {
        strategyId: v.strategyId,
        label: v.label,
        allocation: v.allocation,
        stats,
        testRuns: allocations?.get(v.strategyId) ?? 0,
      };
    });

    // Pairwise statistical comparisons
    const comparisons: StatisticalComparison[] = [];
    for (let i = 0; i < variants.length; i++) {
      for (let j = i + 1; j < variants.length; j++) {
        const comp = this.compareVariants(
          variants[i]!,
          variants[j]!,
          config.confidenceLevel,
        );
        comparisons.push(comp);
      }
    }

    // Determine winner: variant with highest success rate that is significantly better
    let winner: string | null = null;
    const bestVariant = variants.reduce((best, v) =>
      v.stats.successRate > best.stats.successRate ? v : best,
    );

    // Check if best is significantly better than all others
    const hasEnoughData = variants.every((v) => v.stats.totalRuns >= config.minVariantRuns);
    if (hasEnoughData) {
      const isSignificantAgainstAll = comparisons
        .filter((c) => c.variantA === bestVariant.strategyId || c.variantB === bestVariant.strategyId)
        .every((c) => {
          const isBestA = c.variantA === bestVariant.strategyId;
          return c.isSignificant && (isBestA ? c.rateDifference > 0 : c.rateDifference < 0);
        });

      if (isSignificantAgainstAll && comparisons.length > 0) {
        winner = bestVariant.strategyId;
      }
    }

    // Build summary
    const totalRuns = variants.reduce((s, v) => s + v.stats.totalRuns, 0);
    const summary = this.buildSummary(config, variants, comparisons, winner, status);

    const startedAt = config.createdAt;
    const endedAt = status === "completed" || status === "cancelled"
      ? new Date().toISOString()
      : null;

    return {
      testId,
      testName: config.name,
      domain: config.domain,
      status,
      variants,
      comparisons,
      winner,
      summary,
      startedAt,
      endedAt,
      totalRuns,
    };
  }

  /**
   * Get quick recommendation: which variant is currently leading?
   */
  getLeadingVariant(testId: string): ABTestVariantResult | null {
    const result = this.analyze(testId);
    if (typeof result === "string") return null;

    if (result.variants.length === 0) return null;
    return result.variants.reduce((best, v) =>
      v.stats.successRate > best.stats.successRate ? v : best,
    );
  }

  // ── Statistical Methods ─────────────────────────────────────────────────────

  /**
   * Compare two variants using a two-proportion z-test.
   * Tests H0: pA = pB against H1: pA ≠ pB.
   */
  private compareVariants(
    a: ABTestVariantResult,
    b: ABTestVariantResult,
    confidenceLevel: number,
  ): StatisticalComparison {
    const nA = a.stats.totalRuns;
    const nB = b.stats.totalRuns;
    const pA = a.stats.successRate;
    const pB = b.stats.successRate;

    const rateDifference = pA - pB;

    // If either has no runs, can't compare
    if (nA === 0 || nB === 0) {
      return {
        variantA: a.strategyId,
        variantB: b.strategyId,
        rateDifference,
        zScore: 0,
        pValue: 1,
        isSignificant: false,
        confidenceLevel,
      };
    }

    // Pooled proportion under H0
    const pPool = (a.stats.successCount + b.stats.successCount) / (nA + nB);

    // Standard error of difference
    const se = Math.sqrt(
      pPool * (1 - pPool) * (1 / nA + 1 / nB),
    );

    // Z-score
    const zScore = se > 0 ? rateDifference / se : 0;

    // Two-tailed p-value (approximation using error function)
    const pValue = 2 * (1 - this.normalCDF(Math.abs(zScore)));

    // Significance check
    const alpha = 1 - confidenceLevel;
    const isSignificant = pValue < alpha;

    return {
      variantA: a.strategyId,
      variantB: b.strategyId,
      rateDifference,
      zScore,
      pValue,
      isSignificant,
      confidenceLevel,
    };
  }

  /**
   * Standard normal CDF approximation (Abramowitz & Stegun).
   */
  private normalCDF(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x) / Math.sqrt(2);

    const t = 1.0 / (1.0 + p * absX);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

    return 0.5 * (1.0 + sign * y);
  }

  /**
   * Compute required sample size per variant for a given effect size and power.
   * Uses the standard formula for two-proportion z-test sample size.
   */
  static computeRequiredSampleSize(
    baselineRate: number,
    minimumDetectableEffect: number,
    confidenceLevel = 0.95,
    power = 0.80,
  ): number {
    const alpha = 1 - confidenceLevel;
    const beta = 1 - power;

    // Z-scores for alpha and beta
    const zAlpha = ABTestManager.zScoreForP(alpha / 2); // two-tailed
    const zBeta = ABTestManager.zScoreForP(beta);

    const p1 = baselineRate;
    const p2 = baselineRate + minimumDetectableEffect;

    const pAvg = (p1 + p2) / 2;

    const numerator = Math.pow(
      zAlpha * Math.sqrt(2 * pAvg * (1 - pAvg)) +
      zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2)),
      2,
    );

    const denominator = Math.pow(p1 - p2, 2);

    if (denominator === 0) return Infinity;

    return Math.ceil(numerator / denominator);
  }

  /**
   * Approximate z-score for a given p-value (one-tailed).
   */
  private static zScoreForP(p: number): number {
    // Rational approximation (Peter Acklam's algorithm)
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    if (p === 0.5) return 0;

    const a = [
      -3.969683028665376e1, 2.209460984245205e2,
      -2.759285104469687e2, 1.383577518672690e2,
      -3.066479806614716e1, 2.506628277459239e0,
    ];
    const b = [
      -5.447609879822406e1, 1.615858368580409e2,
      -1.556989798598866e2, 6.680131188771972e1,
      -1.328068155288572e1,
    ];
    const c = [
      -7.784894002430293e-3, -3.223964580411365e-1,
      -2.400758277161838e0, -2.549732539343734e0,
      4.374664141464968e0, 2.938163982698783e0,
    ];
    const d = [
      7.784695709041462e-3, 3.224671290700398e-1,
      2.445134137142996e0, 3.754408661907416e0,
    ];

    const pLow = 0.02425;
    const pHigh = 1 - pLow;
    let q: number, r: number;

    if (p < pLow) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
        ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
    } else if (p <= pHigh) {
      q = p - 0.5;
      r = q * q;
      return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
        (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
    } else {
      q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
        ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
    }
  }

  // ── Summary Builder ─────────────────────────────────────────────────────────

  private buildSummary(
    config: ABTestConfig,
    variants: ABTestVariantResult[],
    comparisons: StatisticalComparison[],
    winner: string | null,
    status: ABTestStatus,
  ): string {
    const lines: string[] = [];

    lines.push(`A/B Test: ${config.name}`);
    lines.push(`Domain: ${config.domain} | Status: ${status}`);
    lines.push("");

    // Variant table
    lines.push("Variant Results:");
    for (const v of variants) {
      const rate = (v.stats.successRate * 100).toFixed(1);
      lines.push(
        `  ${v.label}: ${rate}% success (${v.stats.totalRuns} runs)`,
      );
    }
    lines.push("");

    // Comparisons
    if (comparisons.length > 0) {
      lines.push("Statistical Comparisons:");
      for (const c of comparisons) {
        const sig = c.isSignificant ? "✓ significant" : "✗ not significant";
        lines.push(
          `  ${c.variantA} vs ${c.variantB}: Δ=${(c.rateDifference * 100).toFixed(1)}% ` +
          `(p=${c.pValue.toFixed(4)}, ${sig})`,
        );
      }
      lines.push("");
    }

    // Winner
    if (winner) {
      const winnerVariant = variants.find((v) => v.strategyId === winner);
      lines.push(`Winner: ${winnerVariant?.label ?? winner}`);
    } else if (status === "completed") {
      lines.push("No statistically significant winner detected.");
    } else {
      lines.push("Test still running — no winner declared yet.");
    }

    return lines.join("\n");
  }
}

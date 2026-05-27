/**
 * Benchmark Harness — Extended evaluation harness for benchmarking agent capabilities.
 *
 * Builds on EvalHarness with: flaky test detection, cost tracking,
 * multi-run averaging, and regression detection.
 */

import type { EvalCase, EvalResult, EvalReport, AgentExecutor, AgentResponse } from "../eval/harness.js";
import { EvalHarness } from "../eval/harness.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BenchmarkConfig {
  /** Benchmark name */
  name: string;
  /** Model being benchmarked */
  model?: string;
  /** Number of runs for flaky detection */
  repeatRuns?: number;
  /** Flaky threshold: fail if pass rate varies more than this across runs */
  flakyThreshold?: number;
  /** Cost budget in USD */
  budgetUsd?: number;
  /** Timeout per case in ms */
  timeoutMs?: number;
}

export interface BenchmarkResult {
  benchmark: string;
  model: string;
  timestamp: string;
  totalCases: number;
  passed: number;
  failed: number;
  errors: number;
  passRate: number;
  avgScore: number;
  avgDurationMs: number;
  totalCostUsd: number;
  flakyCases: string[];
  byLevel: Record<number, { total: number; passed: number; passRate: number }>;
  results: EvalResult[];
  runs: number;
}

export interface RegressionCheck {
  current: BenchmarkResult;
  baseline: BenchmarkResult | null;
  isRegression: boolean;
  regressionThreshold: number;
  passRateDelta: number;
  regressions: string[];
  improvements: string[];
}

// ── Benchmark Harness ────────────────────────────────────────────────────────

export class BenchmarkHarness {
  private config: Required<BenchmarkConfig>;
  private cases: EvalCase[] = [];

  constructor(config: BenchmarkConfig) {
    this.config = {
      name: config.name,
      model: config.model ?? "unknown",
      repeatRuns: config.repeatRuns ?? 1,
      flakyThreshold: config.flakyThreshold ?? 0.1,
      budgetUsd: config.budgetUsd ?? 10.0,
      timeoutMs: config.timeoutMs ?? 30_000,
    };
  }

  loadCases(cases: EvalCase[]): void {
    this.cases = [...cases];
  }

  loadCasesFromJson(json: string): void {
    this.cases = JSON.parse(json) as EvalCase[];
  }

  getCaseCount(): number {
    return this.cases.length;
  }

  /**
   * Run benchmark with optional multi-run flaky detection.
   */
  async run(agent: AgentExecutor): Promise<BenchmarkResult> {
    const allResults: EvalResult[][] = [];
    let totalCost = 0;

    for (let run = 0; run < this.config.repeatRuns; run++) {
      const harness = new EvalHarness(agent, {
        name: this.config.name,
        model: this.config.model,
        timeoutMs: this.config.timeoutMs,
      });
      harness.loadCases(this.cases);

      const report = await harness.runAll();
      allResults.push(report.results);
      totalCost += report.totalCostUsd;

      // Budget check
      if (totalCost > this.config.budgetUsd) {
        break;
      }
    }

    // Aggregate results
    const primaryResults = allResults[0] ?? [];
    const flakyCases = this.detectFlaky(allResults);

    const passed = primaryResults.filter((r) => r.status === "pass").length;
    const failed = primaryResults.filter((r) => r.status === "fail").length;
    const errors = primaryResults.filter((r) => r.status === "error").length;
    const totalScore = primaryResults.reduce((s, r) => s + r.score, 0);
    const totalDuration = primaryResults.reduce((s, r) => s + r.durationMs, 0);

    const byLevel = this.calculateByLevel(primaryResults);

    return {
      benchmark: this.config.name,
      model: this.config.model,
      timestamp: new Date().toISOString(),
      totalCases: this.cases.length,
      passed,
      failed,
      errors,
      passRate: this.cases.length > 0 ? passed / this.cases.length : 0,
      avgScore: this.cases.length > 0 ? totalScore / this.cases.length : 0,
      avgDurationMs: primaryResults.length > 0 ? totalDuration / primaryResults.length : 0,
      totalCostUsd: totalCost,
      flakyCases,
      byLevel,
      results: primaryResults,
      runs: allResults.length,
    };
  }

  /**
   * Check for regressions against a baseline.
   */
  checkRegression(
    current: BenchmarkResult,
    baseline: BenchmarkResult | null,
    threshold = 0.05,
  ): RegressionCheck {
    const isRegression = baseline
      ? current.passRate < baseline.passRate - threshold
      : false;

    const regressions: string[] = [];
    const improvements: string[] = [];

    if (baseline) {
      // Find individual case regressions/improvements
      const baselineMap = new Map(baseline.results.map((r) => [r.caseId, r]));
      for (const result of current.results) {
        const baseResult = baselineMap.get(result.caseId);
        if (baseResult) {
          if (baseResult.status === "pass" && result.status !== "pass") {
            regressions.push(result.caseId);
          } else if (baseResult.status !== "pass" && result.status === "pass") {
            improvements.push(result.caseId);
          }
        }
      }
    }

    return {
      current,
      baseline,
      isRegression,
      regressionThreshold: threshold,
      passRateDelta: baseline ? current.passRate - baseline.passRate : 0,
      regressions,
      improvements,
    };
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private detectFlaky(allResults: EvalResult[][]): string[] {
    if (allResults.length < 2) return [];

    const flaky: string[] = [];
    const caseIds = allResults[0].map((r) => r.caseId);

    for (const caseId of caseIds) {
      const statuses = allResults
        .map((run) => run.find((r) => r.caseId === caseId)?.status)
        .filter(Boolean);

      const passCount = statuses.filter((s) => s === "pass").length;
      const passRate = passCount / statuses.length;

      // Flaky if it sometimes passes and sometimes fails
      if (passRate > 0 && passRate < 1) {
        const variance = Math.abs(passRate - 0.5);
        if (variance < this.config.flakyThreshold) {
          flaky.push(caseId);
        }
      }
    }

    return flaky;
  }

  private calculateByLevel(
    results: EvalResult[],
  ): Record<number, { total: number; passed: number; passRate: number }> {
    const byLevel: Record<number, { total: number; passed: number; passRate: number }> = {};
    const caseLevelMap = new Map(this.cases.map((c) => [c.id, c.level ?? 1]));

    for (const result of results) {
      const level = caseLevelMap.get(result.caseId) ?? 1;
      if (!byLevel[level]) {
        byLevel[level] = { total: 0, passed: 0, passRate: 0 };
      }
      byLevel[level].total++;
      if (result.status === "pass") {
        byLevel[level].passed++;
      }
    }

    for (const level of Object.keys(byLevel)) {
      const l = byLevel[Number(level)];
      l.passRate = l.total > 0 ? l.passed / l.total : 0;
    }

    return byLevel;
  }
}

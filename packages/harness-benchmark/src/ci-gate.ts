/**
 * CI Gate — Integrates regression detection into CI/CD pipelines.
 *
 * Runs a benchmark, compares against the best historical baseline,
 * and produces a pass/fail exit code. Designed for GitHub Actions
 * or any CI that checks process exit codes.
 *
 * Usage:
 *   const gate = new CIGate({ historyPath: ".benchmark-history.json", threshold: 0.05 });
 *   const result = await gate.run(agent, cases);
 *   gate.printReport(result);
 *   process.exit(result.exitCode);
 */

import type { EvalCase, AgentExecutor } from "@open-vera/harness-eval";
import { BenchmarkHarness } from "./harness.js";
import type { BenchmarkResult } from "./harness.js";
import { BenchmarkReporter } from "./reporter.js";
import { RegressionDetector } from "./regression-detector.js";
import type { RegressionReport } from "./regression-detector.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CIGateOptions {
  /** Path to benchmark history JSON file */
  historyPath: string;
  /** Regression threshold (default: 0.05 = 5%) */
  threshold?: number;
  /** Benchmark name */
  name?: string;
  /** Model name */
  model?: string;
  /** Number of repeat runs for flaky detection */
  repeatRuns?: number;
  /** Cost budget in USD */
  budgetUsd?: number;
  /** Timeout per case in ms */
  timeoutMs?: number;
}

export interface CIGateResult {
  /** 0 = no regression, 1 = regression detected */
  exitCode: 0 | 1;
  /** The benchmark result */
  benchmarkResult: BenchmarkResult;
  /** The regression report */
  regressionReport: RegressionReport;
  /** Whether the result was recorded to history */
  recorded: boolean;
}

// ── CI Gate ──────────────────────────────────────────────────────────────────

export class CIGate {
  private detector: RegressionDetector;
  private config: Required<CIGateOptions>;

  constructor(options: CIGateOptions) {
    this.config = {
      historyPath: options.historyPath,
      threshold: options.threshold ?? 0.05,
      name: options.name ?? "gaia-l1",
      model: options.model ?? "unknown",
      repeatRuns: options.repeatRuns ?? 1,
      budgetUsd: options.budgetUsd ?? 10.0,
      timeoutMs: options.timeoutMs ?? 60_000,
    };

    this.detector = new RegressionDetector({
      historyPath: this.config.historyPath,
      threshold: this.config.threshold,
    });
  }

  /**
   * Run benchmark and check for regression.
   */
  async run(agent: AgentExecutor, cases: EvalCase[]): Promise<CIGateResult> {
    const harness = new BenchmarkHarness({
      name: this.config.name,
      model: this.config.model,
      repeatRuns: this.config.repeatRuns,
      budgetUsd: this.config.budgetUsd,
      timeoutMs: this.config.timeoutMs,
    });

    harness.loadCases(cases);
    const benchmarkResult = await harness.run(agent);
    const regressionReport = this.detector.checkRegression(benchmarkResult);

    // Record the result regardless of regression
    this.detector.record(benchmarkResult);

    return {
      exitCode: regressionReport.isRegression ? 1 : 0,
      benchmarkResult,
      regressionReport,
      recorded: true,
    };
  }

  /**
   * Check an already-computed benchmark result against history.
   * Does NOT run the benchmark — useful when the result comes from an external source.
   */
  check(result: BenchmarkResult): CIGateResult {
    const regressionReport = this.detector.checkRegression(result);
    this.detector.record(result);

    return {
      exitCode: regressionReport.isRegression ? 1 : 0,
      benchmarkResult: result,
      regressionReport,
      recorded: true,
    };
  }

  /**
   * Get the underlying RegressionDetector (for inspection).
   */
  getDetector(): RegressionDetector {
    return this.detector;
  }

  /**
   * Format a CI-friendly report to stdout.
   */
  static formatReport(result: CIGateResult): string {
    const lines: string[] = [];

    // Header
    if (result.exitCode === 1) {
      lines.push("## REGRESSION DETECTED");
      lines.push("");
      lines.push(
        `Pass rate dropped ${(Math.abs(result.regressionReport.passRateDelta) * 100).toFixed(1)}% ` +
        `(threshold: ${(result.regressionReport.threshold * 100).toFixed(0)}%)`,
      );
    } else {
      lines.push("## No Regression");
    }
    lines.push("");

    // Benchmark summary
    lines.push(BenchmarkReporter.toMarkdown(result.benchmarkResult));
    lines.push("");

    // Regression details
    if (result.regressionReport.baseline) {
      lines.push(BenchmarkReporter.regressionMarkdown({
        current: result.benchmarkResult,
        baseline: result.regressionReport.baseline
          ? {
              ...result.benchmarkResult,
              passRate: result.regressionReport.baseline.passRate,
              avgScore: result.regressionReport.baseline.avgScore,
            }
          : null,
        isRegression: result.regressionReport.isRegression,
        regressionThreshold: result.regressionReport.threshold,
        passRateDelta: result.regressionReport.passRateDelta,
        regressions: [],
        improvements: [],
      }));
    }

    return lines.join("\n");
  }
}

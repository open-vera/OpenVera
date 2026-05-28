/**
 * Benchmark Reporter — Generates benchmark reports with regression analysis.
 */

import type { BenchmarkResult, RegressionCheck } from "./harness.js";

// ── Benchmark Reporter ───────────────────────────────────────────────────────

export class BenchmarkReporter {
  /**
   * Generate a markdown benchmark report.
   */
  static toMarkdown(result: BenchmarkResult): string {
    const lines: string[] = [];
    const pct = (n: number) => (n * 100).toFixed(1) + "%";

    lines.push(`# Benchmark Report: ${result.benchmark}`);
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Model | ${result.model} |`);
    lines.push(`| Timestamp | ${result.timestamp} |`);
    lines.push(`| Total Cases | ${result.totalCases} |`);
    lines.push(`| Passed | ${result.passed} |`);
    lines.push(`| Failed | ${result.failed} |`);
    lines.push(`| Errors | ${result.errors} |`);
    lines.push(`| Pass Rate | ${pct(result.passRate)} |`);
    lines.push(`| Avg Score | ${result.avgScore.toFixed(3)} |`);
    lines.push(`| Avg Duration | ${result.avgDurationMs.toFixed(0)}ms |`);
    lines.push(`| Total Cost | $${result.totalCostUsd.toFixed(4)} |`);
    lines.push(`| Runs | ${result.runs} |`);
    lines.push("");

    // By level
    const levels = Object.keys(result.byLevel).map(Number).sort();
    if (levels.length > 0) {
      lines.push("## By Level");
      lines.push("");
      lines.push(`| Level | Total | Passed | Pass Rate |`);
      lines.push(`|-------|-------|--------|-----------|`);
      for (const level of levels) {
        const l = result.byLevel[level];
        lines.push(`| L${level} | ${l.total} | ${l.passed} | ${pct(l.passRate)} |`);
      }
      lines.push("");
    }

    // Flaky cases
    if (result.flakyCases.length > 0) {
      lines.push("## Flaky Cases");
      lines.push("");
      for (const caseId of result.flakyCases) {
        lines.push(`- \`${caseId}\``);
      }
      lines.push("");
    }

    // Failures
    const failures = result.results.filter((r) => r.status === "fail" || r.status === "error");
    if (failures.length > 0) {
      lines.push("## Failures");
      lines.push("");
      lines.push(`| Case | Status | Score | Error |`);
      lines.push(`|------|--------|-------|-------|`);
      for (const f of failures) {
        const err = f.error ? f.error.slice(0, 80) : "-";
        lines.push(`| ${f.caseId} | ${f.status} | ${f.score.toFixed(2)} | ${err} |`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Generate a regression comparison report.
   */
  static regressionMarkdown(check: RegressionCheck): string {
    const lines: string[] = [];
    const pct = (n: number) => (n * 100).toFixed(1) + "%";

    const status = check.isRegression ? "REGRESSION DETECTED" : "No regression";
    lines.push(`# Regression Check: ${status}`);
    lines.push("");

    if (check.baseline) {
      lines.push(`| Metric | Baseline | Current | Delta |`);
      lines.push(`|--------|----------|---------|-------|`);
      lines.push(
        `| Pass Rate | ${pct(check.baseline.passRate)} | ${pct(check.current.passRate)} | ${pct(check.passRateDelta)} |`,
      );
      lines.push(
        `| Avg Score | ${check.baseline.avgScore.toFixed(3)} | ${check.current.avgScore.toFixed(3)} | ${(check.current.avgScore - check.baseline.avgScore).toFixed(3)} |`,
      );
      lines.push("");
    }

    if (check.regressions.length > 0) {
      lines.push("## Regressions");
      lines.push("");
      for (const r of check.regressions) {
        lines.push(`- \`${r}\``);
      }
      lines.push("");
    }

    if (check.improvements.length > 0) {
      lines.push("## Improvements");
      lines.push("");
      for (const r of check.improvements) {
        lines.push(`- \`${r}\``);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Compare two benchmark results side by side.
   */
  static compareMarkdown(baseline: BenchmarkResult, current: BenchmarkResult): string {
    const lines: string[] = [];
    const pct = (n: number) => (n * 100).toFixed(1) + "%";

    lines.push("# Benchmark Comparison");
    lines.push("");
    lines.push(`| Metric | ${baseline.model} | ${current.model} | Delta |`);
    lines.push(`|--------|${"-".repeat(baseline.model.length + 2)}|${"-".repeat(current.model.length + 2)}|-------|`);
    lines.push(`| Pass Rate | ${pct(baseline.passRate)} | ${pct(current.passRate)} | ${pct(current.passRate - baseline.passRate)} |`);
    lines.push(`| Avg Score | ${baseline.avgScore.toFixed(3)} | ${current.avgScore.toFixed(3)} | ${(current.avgScore - baseline.avgScore).toFixed(3)} |`);
    lines.push(`| Avg Duration | ${baseline.avgDurationMs.toFixed(0)}ms | ${current.avgDurationMs.toFixed(0)}ms | ${(current.avgDurationMs - baseline.avgDurationMs).toFixed(0)}ms |`);
    lines.push(`| Cost | $${baseline.totalCostUsd.toFixed(4)} | $${current.totalCostUsd.toFixed(4)} | $${(current.totalCostUsd - baseline.totalCostUsd).toFixed(4)} |`);
    lines.push("");

    return lines.join("\n");
  }
}

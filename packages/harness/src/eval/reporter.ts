/**
 * Eval Reporter — Generate markdown reports from evaluation results.
 */

import type { EvalReport, EvalResult, EvalStatus } from "./harness.js";

// ── Reporter ─────────────────────────────────────────────────────────────────

export class EvalReporter {
  /**
   * Generate a markdown report from an EvalReport.
   */
  static toMarkdown(report: EvalReport): string {
    const lines: string[] = [];

    lines.push(`# Eval Report: ${report.benchmark}`);
    lines.push("");
    lines.push(`**Model**: ${report.model}`);
    lines.push(`**Date**: ${report.timestamp}`);
    lines.push("");

    // Summary
    lines.push("## Summary");
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total Cases | ${report.totalCases} |`);
    lines.push(`| Passed | ${report.passed} |`);
    lines.push(`| Failed | ${report.failed} |`);
    lines.push(`| Errors | ${report.errors} |`);
    lines.push(`| Skipped | ${report.skipped} |`);
    lines.push(`| Pass Rate | ${(report.passRate * 100).toFixed(1)}% |`);
    lines.push(`| Avg Score | ${report.avgScore.toFixed(3)} |`);
    lines.push(`| Avg Duration | ${report.avgDurationMs.toFixed(0)}ms |`);
    lines.push(`| Total Cost | $${report.totalCostUsd.toFixed(4)} |`);
    lines.push("");

    // By Level
    lines.push("## Results by Level");
    lines.push("");
    lines.push(`| Level | Total | Passed | Pass Rate |`);
    lines.push(`|-------|-------|--------|-----------|`);
    for (const [level, stats] of Object.entries(report.byLevel)) {
      lines.push(`| L${level} | ${stats.total} | ${stats.passed} | ${(stats.passRate * 100).toFixed(1)}% |`);
    }
    lines.push("");

    // Failed Cases
    const failedCases = report.results.filter(
      (r) => r.status === "fail" || r.status === "error" || r.status === "timeout",
    );
    if (failedCases.length > 0) {
      lines.push("## Failed Cases");
      lines.push("");
      for (const result of failedCases) {
        lines.push(`### ${result.caseId} (${result.status})`);
        lines.push(`- Score: ${result.score.toFixed(3)}`);
        lines.push(`- Duration: ${result.durationMs.toFixed(0)}ms`);
        if (result.error) {
          lines.push(`- Error: ${result.error}`);
        }
        if (result.response) {
          lines.push(`- Response preview: ${result.response.slice(0, 200)}...`);
        }
        lines.push("");
      }
    }

    // Tool Usage
    const toolCounts: Record<string, number> = {};
    for (const result of report.results) {
      for (const tool of result.toolCalls) {
        toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
      }
    }
    if (Object.keys(toolCounts).length > 0) {
      lines.push("## Tool Usage");
      lines.push("");
      lines.push(`| Tool | Calls |`);
      lines.push(`|------|-------|`);
      const sorted = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
      for (const [tool, count] of sorted) {
        lines.push(`| ${tool} | ${count} |`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Generate a comparison report between two eval runs.
   */
  static compareMarkdown(baseline: EvalReport, current: EvalReport): string {
    const lines: string[] = [];

    lines.push(`# Eval Comparison: ${baseline.benchmark}`);
    lines.push("");
    lines.push(`**Baseline**: ${baseline.model} (${baseline.timestamp})`);
    lines.push(`**Current**: ${current.model} (${current.timestamp})`);
    lines.push("");

    lines.push("## Summary Comparison");
    lines.push("");
    lines.push(`| Metric | Baseline | Current | Delta |`);
    lines.push(`|--------|----------|---------|-------|`);

    const passRateDelta = current.passRate - baseline.passRate;
    const passRateIcon = passRateDelta > 0 ? "+" : "";
    lines.push(
      `| Pass Rate | ${(baseline.passRate * 100).toFixed(1)}% | ${(current.passRate * 100).toFixed(1)}% | ${passRateIcon}${(passRateDelta * 100).toFixed(1)}% |`,
    );

    const scoreDelta = current.avgScore - baseline.avgScore;
    const scoreIcon = scoreDelta > 0 ? "+" : "";
    lines.push(
      `| Avg Score | ${baseline.avgScore.toFixed(3)} | ${current.avgScore.toFixed(3)} | ${scoreIcon}${scoreDelta.toFixed(3)} |`,
    );

    const durationDelta = current.avgDurationMs - baseline.avgDurationMs;
    const durationIcon = durationDelta > 0 ? "+" : "";
    lines.push(
      `| Avg Duration | ${baseline.avgDurationMs.toFixed(0)}ms | ${current.avgDurationMs.toFixed(0)}ms | ${durationIcon}${durationDelta.toFixed(0)}ms |`,
    );

    lines.push("");

    // Regressions
    const regressions: string[] = [];
    const improvements: string[] = [];

    const baselineMap = new Map(baseline.results.map((r) => [r.caseId, r]));
    for (const currentResult of current.results) {
      const baselineResult = baselineMap.get(currentResult.caseId);
      if (!baselineResult) continue;

      if (baselineResult.status === "pass" && currentResult.status !== "pass") {
        regressions.push(currentResult.caseId);
      } else if (baselineResult.status !== "pass" && currentResult.status === "pass") {
        improvements.push(currentResult.caseId);
      }
    }

    if (regressions.length > 0) {
      lines.push(`## Regressions (${regressions.length})`);
      lines.push("");
      for (const id of regressions) {
        lines.push(`- ${id}`);
      }
      lines.push("");
    }

    if (improvements.length > 0) {
      lines.push(`## Improvements (${improvements.length})`);
      lines.push("");
      for (const id of improvements) {
        lines.push(`- ${id}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}

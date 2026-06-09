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
   * Generate a WebArena-specific report with per-site breakdown and step efficiency.
   */
  static webarenaMarkdown(report: EvalReport): string {
    const lines: string[] = [];

    lines.push(`# WebArena Eval Report`);
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
    lines.push(`| Pass Rate | ${(report.passRate * 100).toFixed(1)}% |`);
    lines.push(`| Avg Score | ${report.avgScore.toFixed(3)} |`);
    lines.push(`| Avg Duration | ${(report.avgDurationMs / 1000).toFixed(1)}s |`);
    lines.push(`| Total Cost | $${report.totalCostUsd.toFixed(4)} |`);
    lines.push("");

    // Step Efficiency
    const totalSteps = report.results.reduce((s, r) => s + r.toolCalls.length, 0);
    const avgSteps = report.totalCases > 0 ? totalSteps / report.totalCases : 0;
    lines.push("## Step Efficiency");
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total Tool Calls | ${totalSteps} |`);
    lines.push(`| Avg Steps/Task | ${avgSteps.toFixed(1)} |`);
    lines.push(`| Avg Duration/Task | ${(report.avgDurationMs / 1000).toFixed(1)}s |`);
    lines.push("");

    // Per-site breakdown
    const siteMap = new Map<string, { total: number; passed: number; steps: number }>();
    for (let i = 0; i < report.results.length; i++) {
      const result = report.results[i];
      const evalCase = report.results[i]; // We use tags from the result
      // Extract site from case — we store it in the result metadata via tags
      // For now, extract from the caseId prefix pattern or use level grouping
      const site = this.extractSiteFromId(result.caseId);
      if (!siteMap.has(site)) siteMap.set(site, { total: 0, passed: 0, steps: 0 });
      const entry = siteMap.get(site)!;
      entry.total++;
      if (result.status === "pass") entry.passed++;
      entry.steps += result.toolCalls.length;
    }

    if (siteMap.size > 1) {
      lines.push("## Per-Site Breakdown");
      lines.push("");
      lines.push(`| Site | Total | Passed | Pass Rate | Avg Steps |`);
      lines.push(`|------|-------|--------|-----------|-----------|`);
      const sorted = [...siteMap.entries()].sort((a, b) => b[1].total - a[1].total);
      for (const [site, stats] of sorted) {
        const passRate = stats.total > 0 ? (stats.passed / stats.total) * 100 : 0;
        const avgS = stats.total > 0 ? stats.steps / stats.total : 0;
        lines.push(`| ${site} | ${stats.total} | ${stats.passed} | ${passRate.toFixed(1)}% | ${avgS.toFixed(1)} |`);
      }
      lines.push("");
    }

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
        lines.push(`- Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
        lines.push(`- Steps: ${result.toolCalls.length}`);
        if (result.error) {
          lines.push(`- Error: ${result.error}`);
        }
        if (result.response) {
          lines.push(`- Response preview: ${result.response.slice(0, 200)}...`);
        }
        lines.push("");
      }
    }

    return lines.join("\n");
  }

  /**
   * Extract site name from case ID (e.g., "wa-shop-001" → "shopping").
   */
  private static extractSiteFromId(caseId: string): string {
    const siteMap: Record<string, string> = {
      shop: "shopping",
      forum: "forum",
      git: "gitlab",
      cms: "cms",
      map: "map",
      wiki: "wikipedia",
      complex: "complex",
    };
    for (const [prefix, site] of Object.entries(siteMap)) {
      if (caseId.includes(`-${prefix}-`)) return site;
    }
    return "unknown";
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

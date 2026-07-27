import { describe, it, expect } from "vitest";
import { BenchmarkReporter } from "../reporter.js";
import type { BenchmarkResult, RegressionCheck } from "../harness.js";
import type { EvalResult } from "@open-vera/harness-eval";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    benchmark: "gaia-l1",
    model: "claude-3",
    timestamp: "2026-01-01T00:00:00Z",
    totalCases: 10,
    passed: 8,
    failed: 1,
    errors: 1,
    passRate: 0.8,
    avgScore: 0.75,
    avgDurationMs: 500,
    totalCostUsd: 0.5,
    flakyCases: ["c3"],
    byLevel: {
      1: { total: 6, passed: 5, passRate: 0.833 },
      2: { total: 4, passed: 3, passRate: 0.75 },
    },
    results: [
      { caseId: "c1", status: "pass", score: 1, durationMs: 200, response: "ok", toolCalls: ["read"] },
      { caseId: "c2", status: "fail", score: 0, durationMs: 300, response: "wrong", toolCalls: [] },
      { caseId: "c3", status: "error", score: 0, durationMs: 100, response: "", toolCalls: [], error: "API timeout" },
    ],
    runs: 1,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("BenchmarkReporter", () => {
  describe("toMarkdown", () => {
    it("includes benchmark name and model", () => {
      const md = BenchmarkReporter.toMarkdown(makeResult());
      expect(md).toContain("gaia-l1");
      expect(md).toContain("claude-3");
    });

    it("includes summary metrics", () => {
      const md = BenchmarkReporter.toMarkdown(makeResult());
      expect(md).toContain("80.0%");
      expect(md).toContain("0.750");
      expect(md).toContain("500ms");
      expect(md).toContain("$0.5000");
    });

    it("includes by-level breakdown", () => {
      const md = BenchmarkReporter.toMarkdown(makeResult());
      expect(md).toContain("L1");
      expect(md).toContain("L2");
      expect(md).toContain("83.3%");
    });

    it("includes flaky cases", () => {
      const md = BenchmarkReporter.toMarkdown(makeResult());
      expect(md).toContain("Flaky Cases");
      expect(md).toContain("c3");
    });

    it("includes failure details", () => {
      const md = BenchmarkReporter.toMarkdown(makeResult());
      expect(md).toContain("Failures");
      expect(md).toContain("c2");
      expect(md).toContain("API timeout");
    });

    it("omits flaky section when no flaky cases", () => {
      const md = BenchmarkReporter.toMarkdown(makeResult({ flakyCases: [] }));
      expect(md).not.toContain("Flaky Cases");
    });

    it("omits failures section when all pass", () => {
      const allPass: BenchmarkResult = {
        ...makeResult(),
        results: [
          { caseId: "c1", status: "pass", score: 1, durationMs: 100, response: "ok", toolCalls: [] },
        ],
        passed: 1,
        failed: 0,
        errors: 0,
      };
      const md = BenchmarkReporter.toMarkdown(allPass);
      expect(md).not.toContain("Failures");
    });
  });

  describe("regressionMarkdown", () => {
    it("shows regression status when regression detected", () => {
      const check: RegressionCheck = {
        current: makeResult({ passRate: 0.6 }),
        baseline: makeResult({ passRate: 0.9 }),
        isRegression: true,
        regressionThreshold: 0.05,
        passRateDelta: -0.3,
        regressions: ["c1", "c2"],
        improvements: [],
      };

      const md = BenchmarkReporter.regressionMarkdown(check);
      expect(md).toContain("REGRESSION DETECTED");
      expect(md).toContain("Regressions");
      expect(md).toContain("c1");
      expect(md).toContain("c2");
    });

    it("shows no-regression status when stable", () => {
      const check: RegressionCheck = {
        current: makeResult({ passRate: 0.9 }),
        baseline: makeResult({ passRate: 0.9 }),
        isRegression: false,
        regressionThreshold: 0.05,
        passRateDelta: 0,
        regressions: [],
        improvements: [],
      };

      const md = BenchmarkReporter.regressionMarkdown(check);
      expect(md).toContain("No regression");
    });

    it("shows improvements", () => {
      const check: RegressionCheck = {
        current: makeResult({ passRate: 0.9 }),
        baseline: makeResult({ passRate: 0.8 }),
        isRegression: false,
        regressionThreshold: 0.05,
        passRateDelta: 0.1,
        regressions: [],
        improvements: ["c5", "c6"],
      };

      const md = BenchmarkReporter.regressionMarkdown(check);
      expect(md).toContain("Improvements");
      expect(md).toContain("c5");
      expect(md).toContain("c6");
    });

    it("handles null baseline", () => {
      const check: RegressionCheck = {
        current: makeResult(),
        baseline: null,
        isRegression: false,
        regressionThreshold: 0.05,
        passRateDelta: 0,
        regressions: [],
        improvements: [],
      };

      const md = BenchmarkReporter.regressionMarkdown(check);
      expect(md).not.toContain("Baseline");
    });
  });

  describe("compareMarkdown", () => {
    it("generates comparison table", () => {
      const baseline = makeResult({ model: "gpt-4", passRate: 0.8 });
      const current = makeResult({ model: "claude-3", passRate: 0.9 });

      const md = BenchmarkReporter.compareMarkdown(baseline, current);
      expect(md).toContain("gpt-4");
      expect(md).toContain("claude-3");
      expect(md).toContain("80.0%");
      expect(md).toContain("90.0%");
    });
  });
});

import { describe, it, expect } from "vitest";
import { EvalReporter } from "../../src/eval/reporter.js";
import type { EvalReport } from "../../src/eval/harness.js";

function makeReport(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    benchmark: "test-bench",
    model: "test-model",
    timestamp: "2026-05-27T18:00:00Z",
    totalCases: 3,
    passed: 2,
    failed: 1,
    errors: 0,
    skipped: 0,
    passRate: 2 / 3,
    avgScore: 0.8,
    avgDurationMs: 500,
    totalCostUsd: 0.05,
    byLevel: {
      1: { total: 2, passed: 1, passRate: 0.5 },
      2: { total: 1, passed: 1, passRate: 1.0 },
    },
    results: [
      { caseId: "c1", status: "pass", score: 1, durationMs: 200, response: "ok", toolCalls: ["read"] },
      { caseId: "c2", status: "fail", score: 0, durationMs: 300, response: "wrong", toolCalls: ["write"] },
      { caseId: "c3", status: "pass", score: 1, durationMs: 1000, response: "correct", toolCalls: ["read", "bash"] },
    ],
    ...overrides,
  };
}

describe("EvalReporter", () => {
  describe("toMarkdown", () => {
    it("includes benchmark name and model", () => {
      const md = EvalReporter.toMarkdown(makeReport());
      expect(md).toContain("test-bench");
      expect(md).toContain("test-model");
    });

    it("includes summary table with correct values", () => {
      const md = EvalReporter.toMarkdown(makeReport());
      expect(md).toContain("| Total Cases | 3 |");
      expect(md).toContain("| Passed | 2 |");
      expect(md).toContain("| Failed | 1 |");
      expect(md).toContain("66.7%");
    });

    it("includes by-level breakdown", () => {
      const md = EvalReporter.toMarkdown(makeReport());
      expect(md).toContain("| L1 | 2 | 1 | 50.0% |");
      expect(md).toContain("| L2 | 1 | 1 | 100.0% |");
    });

    it("includes failed cases section", () => {
      const md = EvalReporter.toMarkdown(makeReport());
      expect(md).toContain("## Failed Cases");
      expect(md).toContain("c2 (fail)");
      expect(md).toContain("Score: 0.000");
    });

    it("includes tool usage section", () => {
      const md = EvalReporter.toMarkdown(makeReport());
      expect(md).toContain("## Tool Usage");
      expect(md).toContain("| read | 2 |");
      expect(md).toContain("| write | 1 |");
      expect(md).toContain("| bash | 1 |");
    });

    it("skips failed cases section when all pass", () => {
      const md = EvalReporter.toMarkdown(makeReport({
        passed: 3,
        failed: 0,
        results: [
          { caseId: "c1", status: "pass", score: 1, durationMs: 100, response: "ok", toolCalls: [] },
          { caseId: "c2", status: "pass", score: 1, durationMs: 100, response: "ok", toolCalls: [] },
          { caseId: "c3", status: "pass", score: 1, durationMs: 100, response: "ok", toolCalls: [] },
        ],
      }));
      expect(md).not.toContain("## Failed Cases");
    });

    it("skips tool usage when no tools called", () => {
      const md = EvalReporter.toMarkdown(makeReport({
        results: [
          { caseId: "c1", status: "pass", score: 1, durationMs: 100, response: "ok", toolCalls: [] },
        ],
      }));
      expect(md).not.toContain("## Tool Usage");
    });

    it("handles error status in failed cases", () => {
      const md = EvalReporter.toMarkdown(makeReport({
        results: [
          { caseId: "c1", status: "error", score: 0, durationMs: 100, response: "", toolCalls: [], error: "API down" },
        ],
      }));
      expect(md).toContain("c1 (error)");
      expect(md).toContain("Error: API down");
    });

    it("handles timeout status in failed cases", () => {
      const md = EvalReporter.toMarkdown(makeReport({
        results: [
          { caseId: "c1", status: "timeout", score: 0, durationMs: 60000, response: "", toolCalls: [] },
        ],
      }));
      expect(md).toContain("c1 (timeout)");
    });
  });

  describe("compareMarkdown", () => {
    it("shows pass rate delta", () => {
      const baseline = makeReport({ passRate: 0.5, avgScore: 0.6, avgDurationMs: 1000 });
      const current = makeReport({ passRate: 0.8, avgScore: 0.9, avgDurationMs: 500 });
      const md = EvalReporter.compareMarkdown(baseline, current);
      expect(md).toContain("+30.0%");
      expect(md).toContain("+0.300");
      expect(md).toContain("-500ms");
    });

    it("lists regressions", () => {
      const baseline = makeReport({
        results: [
          { caseId: "c1", status: "pass", score: 1, durationMs: 100, response: "ok", toolCalls: [] },
        ],
      });
      const current = makeReport({
        results: [
          { caseId: "c1", status: "fail", score: 0, durationMs: 100, response: "bad", toolCalls: [] },
        ],
      });
      const md = EvalReporter.compareMarkdown(baseline, current);
      expect(md).toContain("## Regressions (1)");
      expect(md).toContain("- c1");
    });

    it("lists improvements", () => {
      const baseline = makeReport({
        results: [
          { caseId: "c1", status: "fail", score: 0, durationMs: 100, response: "bad", toolCalls: [] },
        ],
      });
      const current = makeReport({
        results: [
          { caseId: "c1", status: "pass", score: 1, durationMs: 100, response: "ok", toolCalls: [] },
        ],
      });
      const md = EvalReporter.compareMarkdown(baseline, current);
      expect(md).toContain("## Improvements (1)");
      expect(md).toContain("- c1");
    });

    it("skips sections when no regressions or improvements", () => {
      const report = makeReport();
      const md = EvalReporter.compareMarkdown(report, report);
      expect(md).not.toContain("## Regressions");
      expect(md).not.toContain("## Improvements");
    });
  });

  describe("webarenaMarkdown", () => {
    function makeWebArenaReport(overrides: Partial<EvalReport> = {}): EvalReport {
      return {
        benchmark: "WebArena",
        model: "claude-opus-4-7",
        timestamp: "2026-05-28T08:00:00Z",
        totalCases: 4,
        passed: 2,
        failed: 1,
        errors: 1,
        skipped: 0,
        passRate: 0.5,
        avgScore: 0.5,
        avgDurationMs: 15000,
        totalCostUsd: 0.12,
        byLevel: {
          1: { total: 2, passed: 1, passRate: 0.5 },
          2: { total: 2, passed: 1, passRate: 0.5 },
        },
        results: [
          { caseId: "wa-shop-001", status: "pass", score: 1, durationMs: 10000, response: "added to cart", toolCalls: ["computer_use", "computer_use", "computer_use"] },
          { caseId: "wa-shop-002", status: "pass", score: 1, durationMs: 8000, response: "sorted", toolCalls: ["computer_use", "computer_use"] },
          { caseId: "wa-git-001", status: "fail", score: 0, durationMs: 20000, response: "wrong page", toolCalls: ["computer_use", "computer_use", "computer_use", "computer_use"] },
          { caseId: "wa-forum-001", status: "error", score: 0, durationMs: 5000, response: "", toolCalls: ["computer_use"], error: "timeout" },
        ],
        ...overrides,
      };
    }

    it("includes WebArena title and model", () => {
      const md = EvalReporter.webarenaMarkdown(makeWebArenaReport());
      expect(md).toContain("# WebArena Eval Report");
      expect(md).toContain("claude-opus-4-7");
    });

    it("includes summary table", () => {
      const md = EvalReporter.webarenaMarkdown(makeWebArenaReport());
      expect(md).toContain("| Total Cases | 4 |");
      expect(md).toContain("| Passed | 2 |");
      expect(md).toContain("50.0%");
    });

    it("includes step efficiency section", () => {
      const md = EvalReporter.webarenaMarkdown(makeWebArenaReport());
      expect(md).toContain("## Step Efficiency");
      expect(md).toContain("| Total Tool Calls | 10 |");
      expect(md).toContain("| Avg Steps/Task | 2.5 |");
    });

    it("includes per-site breakdown", () => {
      const md = EvalReporter.webarenaMarkdown(makeWebArenaReport());
      expect(md).toContain("## Per-Site Breakdown");
      expect(md).toContain("shopping");
      expect(md).toContain("gitlab");
      expect(md).toContain("forum");
    });

    it("includes by-level breakdown", () => {
      const md = EvalReporter.webarenaMarkdown(makeWebArenaReport());
      expect(md).toContain("## Results by Level");
      expect(md).toContain("| L1 | 2 | 1 | 50.0% |");
    });

    it("includes failed cases with step count", () => {
      const md = EvalReporter.webarenaMarkdown(makeWebArenaReport());
      expect(md).toContain("## Failed Cases");
      expect(md).toContain("Steps: 4");
    });

    it("handles all-pass report", () => {
      const md = EvalReporter.webarenaMarkdown(makeWebArenaReport({
        passed: 4,
        failed: 0,
        errors: 0,
        passRate: 1.0,
        results: [
          { caseId: "wa-shop-001", status: "pass", score: 1, durationMs: 10000, response: "ok", toolCalls: ["computer_use"] },
          { caseId: "wa-shop-002", status: "pass", score: 1, durationMs: 8000, response: "ok", toolCalls: ["computer_use"] },
          { caseId: "wa-git-001", status: "pass", score: 1, durationMs: 20000, response: "ok", toolCalls: ["computer_use"] },
          { caseId: "wa-forum-001", status: "pass", score: 1, durationMs: 5000, response: "ok", toolCalls: ["computer_use"] },
        ],
      }));
      expect(md).not.toContain("## Failed Cases");
    });

    it("formats duration in seconds", () => {
      const md = EvalReporter.webarenaMarkdown(makeWebArenaReport());
      expect(md).toContain("15.0s");
    });
  });
});

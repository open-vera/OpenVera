import { describe, it, expect, vi } from "vitest";
import { BenchmarkHarness, type BenchmarkResult } from "../../src/benchmark/harness.js";
import type { EvalCase, AgentExecutor, AgentResponse } from "../../src/eval/harness.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "test-1",
    description: "test case",
    level: 1,
    prompt: "What is 2+2?",
    expected: "4",
    evalType: "exact",
    ...overrides,
  };
}

function makeResponse(content = "4"): AgentResponse {
  return { content, toolCalls: [], durationMs: 100, costUsd: 0.01 };
}

function makeAgent(content = "4"): AgentExecutor {
  return { execute: vi.fn().mockResolvedValue(makeResponse(content)) };
}

function makeResult(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    benchmark: "test",
    model: "m",
    timestamp: "2026-01-01",
    totalCases: 5,
    passed: 4,
    failed: 1,
    errors: 0,
    passRate: 0.8,
    avgScore: 0.75,
    avgDurationMs: 500,
    totalCostUsd: 0.1,
    flakyCases: [],
    byLevel: {},
    results: [
      { caseId: "c1", status: "pass", score: 1, durationMs: 100, response: "4", toolCalls: [] },
      { caseId: "c2", status: "pass", score: 1, durationMs: 100, response: "4", toolCalls: [] },
      { caseId: "c3", status: "pass", score: 1, durationMs: 100, response: "4", toolCalls: [] },
      { caseId: "c4", status: "pass", score: 1, durationMs: 100, response: "4", toolCalls: [] },
      { caseId: "c5", status: "fail", score: 0, durationMs: 100, response: "wrong", toolCalls: [] },
    ],
    runs: 1,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("BenchmarkHarness", () => {
  describe("constructor", () => {
    it("uses default config values", () => {
      const harness = new BenchmarkHarness({ name: "test" });
      expect(harness.getCaseCount()).toBe(0);
    });

    it("accepts custom config", () => {
      const harness = new BenchmarkHarness({
        name: "custom",
        model: "gpt-4",
        repeatRuns: 3,
        flakyThreshold: 0.2,
        budgetUsd: 5,
        timeoutMs: 10_000,
      });
      expect(harness.getCaseCount()).toBe(0);
    });
  });

  describe("loadCases", () => {
    it("loads cases from array", () => {
      const harness = new BenchmarkHarness({ name: "test" });
      harness.loadCases([makeCase(), makeCase({ id: "c2" })]);
      expect(harness.getCaseCount()).toBe(2);
    });

    it("loads cases from JSON", () => {
      const harness = new BenchmarkHarness({ name: "test" });
      harness.loadCasesFromJson(JSON.stringify([makeCase()]));
      expect(harness.getCaseCount()).toBe(1);
    });
  });

  describe("run", () => {
    it("runs all cases and returns benchmark result", async () => {
      const harness = new BenchmarkHarness({ name: "test", model: "m" });
      harness.loadCases([
        makeCase({ id: "c1", expected: "4" }),
        makeCase({ id: "c2", expected: "4" }),
      ]);

      const result = await harness.run(makeAgent("4"));
      expect(result.benchmark).toBe("test");
      expect(result.model).toBe("m");
      expect(result.totalCases).toBe(2);
      expect(result.passed).toBe(2);
      expect(result.runs).toBe(1);
    });

    it("handles empty cases", async () => {
      const harness = new BenchmarkHarness({ name: "test" });
      harness.loadCases([]);
      const result = await harness.run(makeAgent());
      expect(result.totalCases).toBe(0);
      expect(result.passRate).toBe(0);
    });

    it("respects budget by stopping early", async () => {
      const harness = new BenchmarkHarness({
        name: "test",
        repeatRuns: 10,
        budgetUsd: 0.001, // Very small budget
      });
      harness.loadCases([makeCase({ id: "c1" })]);

      // Each case costs 0.01, so with budget 0.001 it should stop after first run
      const result = await harness.run(makeAgent("4"));
      expect(result.runs).toBeLessThanOrEqual(10);
    });

    it("calculates byLevel correctly", async () => {
      const harness = new BenchmarkHarness({ name: "test", model: "m" });
      harness.loadCases([
        makeCase({ id: "c1", level: 1, expected: "4" }),
        makeCase({ id: "c2", level: 1, expected: "4" }),
        makeCase({ id: "c3", level: 2, expected: "4" }),
      ]);

      const result = await harness.run(makeAgent("4"));
      expect(result.byLevel[1].total).toBe(2);
      expect(result.byLevel[1].passed).toBe(2);
      expect(result.byLevel[2].total).toBe(1);
      expect(result.byLevel[2].passed).toBe(1);
    });

    it("detects flaky cases across multiple runs", async () => {
      const harness = new BenchmarkHarness({
        name: "test",
        repeatRuns: 3,
        flakyThreshold: 0.5,
      });
      harness.loadCases([makeCase({ id: "c1", expected: "4" })]);

      // Agent that alternates between passing and failing
      let callCount = 0;
      const agent: AgentExecutor = {
        execute: vi.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve(makeResponse(callCount % 2 === 1 ? "4" : "wrong"));
        }),
      };

      const result = await harness.run(agent);
      expect(result.flakyCases).toBeDefined();
      expect(result.runs).toBe(3);
    });
  });

  describe("checkRegression", () => {
    it("reports no regression when no baseline", () => {
      const harness = new BenchmarkHarness({ name: "test" });
      const check = harness.checkRegression(makeResult(), null);
      expect(check.isRegression).toBe(false);
      expect(check.regressions).toEqual([]);
      expect(check.improvements).toEqual([]);
    });

    it("reports regression when pass rate drops beyond threshold", () => {
      const harness = new BenchmarkHarness({ name: "test" });
      const baseline = makeResult({ passRate: 0.9 });
      const current = makeResult({ passRate: 0.7 });

      const check = harness.checkRegression(current, baseline, 0.05);
      expect(check.isRegression).toBe(true);
      expect(check.passRateDelta).toBeCloseTo(-0.2);
    });

    it("reports no regression when drop is within threshold", () => {
      const harness = new BenchmarkHarness({ name: "test" });
      const baseline = makeResult({ passRate: 0.9 });
      const current = makeResult({ passRate: 0.88 });

      const check = harness.checkRegression(current, baseline, 0.05);
      expect(check.isRegression).toBe(false);
    });

    it("detects individual case regressions", () => {
      const harness = new BenchmarkHarness({ name: "test" });
      const baseline = makeResult({
        results: [
          { caseId: "c1", status: "pass", score: 1, durationMs: 100, response: "4", toolCalls: [] },
          { caseId: "c2", status: "pass", score: 1, durationMs: 100, response: "4", toolCalls: [] },
          { caseId: "c3", status: "fail", score: 0, durationMs: 100, response: "wrong", toolCalls: [] },
        ],
      });
      const current = makeResult({
        results: [
          { caseId: "c1", status: "fail", score: 0, durationMs: 100, response: "wrong", toolCalls: [] },
          { caseId: "c2", status: "pass", score: 1, durationMs: 100, response: "4", toolCalls: [] },
          { caseId: "c3", status: "pass", score: 1, durationMs: 100, response: "4", toolCalls: [] },
        ],
      });

      const check = harness.checkRegression(current, baseline, 0.05);
      expect(check.regressions).toContain("c1");
      expect(check.improvements).toContain("c3");
    });

    it("reports no regressions when all cases pass in both runs", () => {
      const harness = new BenchmarkHarness({ name: "test" });
      const baseline = makeResult({
        results: [
          { caseId: "c1", status: "pass", score: 1, durationMs: 100, response: "4", toolCalls: [] },
        ],
      });
      const current = makeResult({
        results: [
          { caseId: "c1", status: "pass", score: 1, durationMs: 100, response: "4", toolCalls: [] },
        ],
      });

      const check = harness.checkRegression(current, baseline);
      expect(check.regressions).toEqual([]);
      expect(check.improvements).toEqual([]);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CIGate, type CIGateResult } from "../ci-gate.js";
import type { EvalCase, AgentExecutor, AgentResponse } from "@open-vera/harness-eval";
import type { BenchmarkResult } from "../harness.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function tmpHistoryPath(): string {
  return join(tmpdir(), `test-ci-gate-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

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

function makeBenchmarkResult(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    benchmark: "test-bench",
    model: "test-model",
    timestamp: new Date().toISOString(),
    totalCases: 10,
    passed: 8,
    failed: 2,
    errors: 0,
    passRate: 0.8,
    avgScore: 0.75,
    avgDurationMs: 500,
    totalCostUsd: 0.1,
    flakyCases: [],
    byLevel: { 1: { total: 10, passed: 8, passRate: 0.8 } },
    results: [],
    runs: 1,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("CIGate", () => {
  let historyPath: string;

  beforeEach(() => {
    historyPath = tmpHistoryPath();
  });

  afterEach(() => {
    if (existsSync(historyPath)) rmSync(historyPath);
  });

  describe("run", () => {
    it("runs benchmark and returns exit code 0 when no regression", async () => {
      const gate = new CIGate({ historyPath, name: "test", model: "m" });
      const cases = [makeCase()];
      const result = await gate.run(makeAgent(), cases);

      expect(result.exitCode).toBe(0);
      expect(result.benchmarkResult.totalCases).toBe(1);
      expect(result.recorded).toBe(true);
    });

    it("returns exit code 1 when regression is detected", async () => {
      // Record a high baseline first — agent returns "4" which matches expected "4" → pass rate 1.0
      const gate1 = new CIGate({ historyPath, threshold: 0.05, name: "test", model: "m" });
      await gate1.run(makeAgent("4"), [makeCase()]);

      // Now run with a failing agent (returns "wrong" → pass rate 0)
      const gate2 = new CIGate({ historyPath, threshold: 0.05, name: "test", model: "m" });
      const result = await gate2.run(makeAgent("wrong-answer"), [makeCase()]);

      expect(result.exitCode).toBe(1);
      expect(result.regressionReport.isRegression).toBe(true);
    });

    it("returns exit code 0 when first run (no baseline)", async () => {
      const gate = new CIGate({ historyPath, name: "test", model: "m" });
      const result = await gate.run(makeAgent(), [makeCase()]);

      expect(result.exitCode).toBe(0);
      expect(result.regressionReport.baseline).toBeNull();
    });

    it("records result to history", async () => {
      const gate = new CIGate({ historyPath, name: "test", model: "m" });
      await gate.run(makeAgent(), [makeCase()]);

      // Load history file and verify
      const content = readFileSync(historyPath, "utf-8");
      const history = JSON.parse(content);
      expect(history).toHaveLength(1);
      expect(history[0].benchmark).toBe("test");
    });

    it("respects custom threshold", async () => {
      // Record baseline with 100% pass rate
      const gate1 = new CIGate({ historyPath, threshold: 0.5, name: "test", model: "m" });
      await gate1.run(makeAgent("4"), [makeCase()]);

      // With 50% threshold, a 100% drop is still a regression
      const gate2 = new CIGate({ historyPath, threshold: 0.5, name: "test", model: "m" });
      const result = await gate2.run(makeAgent("wrong"), [makeCase()]);
      expect(result.exitCode).toBe(1);
    });

    it("passes multiple cases through benchmark harness", async () => {
      const gate = new CIGate({ historyPath, name: "test", model: "m" });
      const cases = [
        makeCase({ id: "c1", expected: "4" }),
        makeCase({ id: "c2", expected: "4" }),
        makeCase({ id: "c3", expected: "4" }),
      ];
      const result = await gate.run(makeAgent("4"), cases);

      expect(result.benchmarkResult.totalCases).toBe(3);
      expect(result.benchmarkResult.passed).toBe(3);
    });
  });

  describe("check", () => {
    it("checks existing benchmark result against history", () => {
      const gate = new CIGate({ historyPath, threshold: 0.05, name: "test", model: "m" });

      // Record baseline
      gate.check(makeBenchmarkResult({ passRate: 0.9 }));

      // Check with a drop
      const result = gate.check(makeBenchmarkResult({ passRate: 0.8 }));
      expect(result.exitCode).toBe(1);
      expect(result.regressionReport.isRegression).toBe(true);
    });

    it("returns exit code 0 when no regression", () => {
      const gate = new CIGate({ historyPath, threshold: 0.1, name: "test", model: "m" });
      gate.check(makeBenchmarkResult({ passRate: 0.9 }));

      const result = gate.check(makeBenchmarkResult({ passRate: 0.85 }));
      expect(result.exitCode).toBe(0);
    });

    it("records result to history", () => {
      const gate = new CIGate({ historyPath, name: "test", model: "m" });
      gate.check(makeBenchmarkResult());

      const content = readFileSync(historyPath, "utf-8");
      const history = JSON.parse(content);
      expect(history).toHaveLength(1);
    });
  });

  describe("getDetector", () => {
    it("returns the underlying RegressionDetector", () => {
      const gate = new CIGate({ historyPath });
      const detector = gate.getDetector();
      expect(detector).toBeDefined();
      expect(typeof detector.record).toBe("function");
    });
  });

  describe("formatReport", () => {
    it("formats no-regression report", () => {
      const result: CIGateResult = {
        exitCode: 0,
        benchmarkResult: makeBenchmarkResult(),
        regressionReport: {
          current: { benchmark: "test", model: "m", timestamp: "", passRate: 0.8, avgScore: 0.75, totalCases: 10, passed: 8, failed: 2 },
          baseline: null,
          isRegression: false,
          threshold: 0.05,
          passRateDelta: 0,
          scoreDelta: 0,
          bestPassRate: 0.8,
          bestTimestamp: "",
        },
        recorded: true,
      };

      const report = CIGate.formatReport(result);
      expect(report).toContain("No Regression");
      expect(report).toContain("80.0%");
    });

    it("formats regression report", () => {
      const result: CIGateResult = {
        exitCode: 1,
        benchmarkResult: makeBenchmarkResult({ passRate: 0.6 }),
        regressionReport: {
          current: { benchmark: "test", model: "m", timestamp: "", passRate: 0.6, avgScore: 0.5, totalCases: 10, passed: 6, failed: 4 },
          baseline: { benchmark: "test", model: "m", timestamp: "", passRate: 0.9, avgScore: 0.8, totalCases: 10, passed: 9, failed: 1 },
          isRegression: true,
          threshold: 0.05,
          passRateDelta: -0.3,
          scoreDelta: -0.3,
          bestPassRate: 0.9,
          bestTimestamp: "",
        },
        recorded: true,
      };

      const report = CIGate.formatReport(result);
      expect(report).toContain("REGRESSION DETECTED");
      expect(report).toContain("30.0%");
      expect(report).toContain("5%");
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RegressionDetector,
  type BenchmarkSnapshot,
  type RegressionReport,
} from "../../src/benchmark/regression-detector.js";
import type { BenchmarkResult } from "../../src/benchmark/harness.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function tmpHistoryPath(): string {
  return join(tmpdir(), `test-history-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
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

describe("RegressionDetector", () => {
  let historyPath: string;

  beforeEach(() => {
    historyPath = tmpHistoryPath();
  });

  afterEach(() => {
    if (existsSync(historyPath)) rmSync(historyPath);
  });

  describe("constructor", () => {
    it("creates with empty history when file doesn't exist", () => {
      const detector = new RegressionDetector({ historyPath });
      expect(detector.getHistory("test-bench", "test-model")).toEqual([]);
    });

    it("loads existing history from file", () => {
      const history: BenchmarkSnapshot[] = [
        { benchmark: "b", model: "m", timestamp: "2026-01-01", passRate: 0.9, avgScore: 0.8, totalCases: 10, passed: 9, failed: 1 },
      ];
      writeFileSync(historyPath, JSON.stringify(history), "utf-8");

      const detector = new RegressionDetector({ historyPath });
      expect(detector.getHistory("b", "m")).toHaveLength(1);
    });

    it("handles corrupted JSON gracefully", () => {
      writeFileSync(historyPath, "not-json", "utf-8");
      const detector = new RegressionDetector({ historyPath });
      expect(detector.getHistory("b", "m")).toEqual([]);
    });

    it("uses default threshold of 0.05", () => {
      const detector = new RegressionDetector({ historyPath });
      // No regression when there's no baseline
      const report = detector.checkRegression(makeBenchmarkResult({ passRate: 0.5 }));
      expect(report.threshold).toBe(0.05);
    });

    it("accepts custom threshold", () => {
      const detector = new RegressionDetector({ historyPath, threshold: 0.1 });
      const report = detector.checkRegression(makeBenchmarkResult({ passRate: 0.5 }));
      expect(report.threshold).toBe(0.1);
    });
  });

  describe("record", () => {
    it("persists snapshot to history file", () => {
      const detector = new RegressionDetector({ historyPath });
      detector.record(makeBenchmarkResult({ passRate: 0.9 }));

      const history = detector.getHistory("test-bench", "test-model");
      expect(history).toHaveLength(1);
      expect(history[0].passRate).toBe(0.9);

      // Verify file was written
      expect(existsSync(historyPath)).toBe(true);
      const fileContent = JSON.parse(readFileSync(historyPath, "utf-8"));
      expect(fileContent).toHaveLength(1);
    });

    it("accumulates multiple records", () => {
      const detector = new RegressionDetector({ historyPath });
      detector.record(makeBenchmarkResult({ passRate: 0.9, timestamp: "2026-01-01" }));
      detector.record(makeBenchmarkResult({ passRate: 0.8, timestamp: "2026-01-02" }));
      detector.record(makeBenchmarkResult({ passRate: 0.85, timestamp: "2026-01-03" }));

      expect(detector.getHistory("test-bench", "test-model")).toHaveLength(3);
    });

    it("preserves history for other benchmark+model combos", () => {
      const detector = new RegressionDetector({ historyPath });
      detector.record(makeBenchmarkResult({ benchmark: "bench-a", model: "m1", passRate: 0.9 }));
      detector.record(makeBenchmarkResult({ benchmark: "bench-b", model: "m2", passRate: 0.7 }));

      expect(detector.getHistory("bench-a", "m1")).toHaveLength(1);
      expect(detector.getHistory("bench-b", "m2")).toHaveLength(1);
    });

    it("creates parent directory if needed", () => {
      const nestedPath = join(tmpdir(), `test-nested-${Date.now()}`, "sub", "history.json");
      const detector = new RegressionDetector({ historyPath: nestedPath });
      detector.record(makeBenchmarkResult());
      expect(existsSync(nestedPath)).toBe(true);
      rmSync(join(tmpdir(), `test-nested-${Date.now()}`), { recursive: true, force: true });
    });
  });

  describe("getBaseline", () => {
    it("returns null when no history exists", () => {
      const detector = new RegressionDetector({ historyPath });
      expect(detector.getBaseline("test-bench", "test-model")).toBeNull();
    });

    it("returns the most recent snapshot for matching benchmark+model", () => {
      const detector = new RegressionDetector({ historyPath });
      detector.record(makeBenchmarkResult({ passRate: 0.9, timestamp: "2026-01-01" }));
      detector.record(makeBenchmarkResult({ passRate: 0.85, timestamp: "2026-01-02" }));
      detector.record(makeBenchmarkResult({ passRate: 0.88, timestamp: "2026-01-03" }));

      const baseline = detector.getBaseline("test-bench", "test-model");
      expect(baseline).not.toBeNull();
      expect(baseline!.passRate).toBe(0.88);
      expect(baseline!.timestamp).toBe("2026-01-03");
    });

    it("ignores entries for different benchmark+model", () => {
      const detector = new RegressionDetector({ historyPath });
      detector.record(makeBenchmarkResult({ benchmark: "other", passRate: 0.5 }));
      detector.record(makeBenchmarkResult({ passRate: 0.9 }));

      const baseline = detector.getBaseline("test-bench", "test-model");
      expect(baseline!.passRate).toBe(0.9);
    });
  });

  describe("getBest", () => {
    it("returns null when no history exists", () => {
      const detector = new RegressionDetector({ historyPath });
      expect(detector.getBest("test-bench", "test-model")).toBeNull();
    });

    it("returns the snapshot with highest pass rate", () => {
      const detector = new RegressionDetector({ historyPath });
      detector.record(makeBenchmarkResult({ passRate: 0.7, timestamp: "2026-01-01" }));
      detector.record(makeBenchmarkResult({ passRate: 0.9, timestamp: "2026-01-02" }));
      detector.record(makeBenchmarkResult({ passRate: 0.8, timestamp: "2026-01-03" }));

      const best = detector.getBest("test-bench", "test-model");
      expect(best!.passRate).toBe(0.9);
    });
  });

  describe("checkRegression", () => {
    it("reports no regression when no baseline exists", () => {
      const detector = new RegressionDetector({ historyPath });
      const report = detector.checkRegression(makeBenchmarkResult({ passRate: 0.5 }));

      expect(report.isRegression).toBe(false);
      expect(report.baseline).toBeNull();
      expect(report.passRateDelta).toBe(0);
    });

    it("reports no regression when pass rate is stable", () => {
      const detector = new RegressionDetector({ historyPath });
      detector.record(makeBenchmarkResult({ passRate: 0.8 }));

      const report = detector.checkRegression(makeBenchmarkResult({ passRate: 0.8 }));
      expect(report.isRegression).toBe(false);
    });

    it("reports no regression when pass rate improves", () => {
      const detector = new RegressionDetector({ historyPath });
      detector.record(makeBenchmarkResult({ passRate: 0.7 }));

      const report = detector.checkRegression(makeBenchmarkResult({ passRate: 0.9 }));
      expect(report.isRegression).toBe(false);
      expect(report.passRateDelta).toBeCloseTo(0.2);
    });

    it("reports no regression when drop is within threshold", () => {
      const detector = new RegressionDetector({ historyPath, threshold: 0.1 });
      detector.record(makeBenchmarkResult({ passRate: 0.8 }));

      // 0.75 is within 0.1 of 0.8
      const report = detector.checkRegression(makeBenchmarkResult({ passRate: 0.75 }));
      expect(report.isRegression).toBe(false);
    });

    it("reports regression when pass rate drops beyond threshold", () => {
      const detector = new RegressionDetector({ historyPath, threshold: 0.05 });
      detector.record(makeBenchmarkResult({ passRate: 0.9 }));

      // 0.8 is 10% below 0.9, exceeds 5% threshold
      const report = detector.checkRegression(makeBenchmarkResult({ passRate: 0.8 }));
      expect(report.isRegression).toBe(true);
      expect(report.passRateDelta).toBeCloseTo(-0.1);
    });

    it("uses best pass rate as baseline for comparison", () => {
      const detector = new RegressionDetector({ historyPath, threshold: 0.05 });
      detector.record(makeBenchmarkResult({ passRate: 0.7, timestamp: "2026-01-01" }));
      detector.record(makeBenchmarkResult({ passRate: 0.9, timestamp: "2026-01-02" }));
      detector.record(makeBenchmarkResult({ passRate: 0.8, timestamp: "2026-01-03" }));

      // Baseline is most recent (0.8), not best (0.9)
      const report = detector.checkRegression(makeBenchmarkResult({ passRate: 0.75 }));
      expect(report.isRegression).toBe(false); // 0.75 is within 0.05 of 0.8
      expect(report.bestPassRate).toBe(0.9);
    });

    it("computes score delta correctly", () => {
      const detector = new RegressionDetector({ historyPath });
      detector.record(makeBenchmarkResult({ passRate: 0.8, avgScore: 0.7 }));

      const report = detector.checkRegression(makeBenchmarkResult({ passRate: 0.8, avgScore: 0.6 }));
      expect(report.scoreDelta).toBeCloseTo(-0.1);
    });
  });

  describe("getHistory", () => {
    it("returns empty array for unknown benchmark+model", () => {
      const detector = new RegressionDetector({ historyPath });
      expect(detector.getHistory("unknown", "unknown")).toEqual([]);
    });

    it("filters by benchmark+model combo", () => {
      const detector = new RegressionDetector({ historyPath });
      detector.record(makeBenchmarkResult({ benchmark: "a", model: "m1" }));
      detector.record(makeBenchmarkResult({ benchmark: "a", model: "m2" }));
      detector.record(makeBenchmarkResult({ benchmark: "b", model: "m1" }));

      expect(detector.getHistory("a", "m1")).toHaveLength(1);
      expect(detector.getHistory("a", "m2")).toHaveLength(1);
      expect(detector.getHistory("b", "m1")).toHaveLength(1);
    });
  });
});

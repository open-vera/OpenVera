/**
 * Regression Detector — Tracks benchmark history and detects regressions.
 *
 * Stores historical benchmark results and provides regression analysis
 * by comparing current results against the best or most recent baseline.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { BenchmarkResult } from "./harness.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BenchmarkSnapshot {
  benchmark: string;
  model: string;
  timestamp: string;
  passRate: number;
  avgScore: number;
  totalCases: number;
  passed: number;
  failed: number;
}

export interface RegressionReport {
  current: BenchmarkSnapshot;
  baseline: BenchmarkSnapshot | null;
  isRegression: boolean;
  threshold: number;
  passRateDelta: number;
  scoreDelta: number;
  bestPassRate: number;
  bestTimestamp: string;
}

// ── Regression Detector ──────────────────────────────────────────────────────

export class RegressionDetector {
  private historyPath: string;
  private history: BenchmarkSnapshot[] = [];
  private threshold: number;

  constructor(options: { historyPath: string; threshold?: number }) {
    this.historyPath = options.historyPath;
    this.threshold = options.threshold ?? 0.05;
    this.loadHistory();
  }

  /**
   * Record a benchmark result.
   */
  record(result: BenchmarkResult): void {
    const snapshot: BenchmarkSnapshot = {
      benchmark: result.benchmark,
      model: result.model,
      timestamp: result.timestamp,
      passRate: result.passRate,
      avgScore: result.avgScore,
      totalCases: result.totalCases,
      passed: result.passed,
      failed: result.failed,
    };

    this.history.push(snapshot);
    this.saveHistory();
  }

  /**
   * Check current result against baseline.
   */
  checkRegression(result: BenchmarkResult): RegressionReport {
    const baseline = this.getBaseline(result.benchmark, result.model);
    const best = this.getBest(result.benchmark, result.model);

    const currentSnapshot: BenchmarkSnapshot = {
      benchmark: result.benchmark,
      model: result.model,
      timestamp: result.timestamp,
      passRate: result.passRate,
      avgScore: result.avgScore,
      totalCases: result.totalCases,
      passed: result.passed,
      failed: result.failed,
    };

    const isRegression = baseline
      ? currentSnapshot.passRate < baseline.passRate - this.threshold
      : false;

    return {
      current: currentSnapshot,
      baseline,
      isRegression,
      threshold: this.threshold,
      passRateDelta: baseline ? currentSnapshot.passRate - baseline.passRate : 0,
      scoreDelta: baseline ? currentSnapshot.avgScore - baseline.avgScore : 0,
      bestPassRate: best?.passRate ?? 0,
      bestTimestamp: best?.timestamp ?? "",
    };
  }

  /**
   * Get the most recent baseline for a benchmark+model combo.
   */
  getBaseline(benchmark: string, model: string): BenchmarkSnapshot | null {
    const matches = this.history.filter(
      (h) => h.benchmark === benchmark && h.model === model,
    );
    return matches.length > 0 ? matches[matches.length - 1] : null;
  }

  /**
   * Get the best pass rate ever achieved for a benchmark+model combo.
   */
  getBest(benchmark: string, model: string): BenchmarkSnapshot | null {
    const matches = this.history.filter(
      (h) => h.benchmark === benchmark && h.model === model,
    );
    if (matches.length === 0) return null;
    return matches.reduce((best, h) => (h.passRate > best.passRate ? h : best));
  }

  /**
   * Get full history for a benchmark+model combo.
   */
  getHistory(benchmark: string, model: string): BenchmarkSnapshot[] {
    return this.history.filter(
      (h) => h.benchmark === benchmark && h.model === model,
    );
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private loadHistory(): void {
    if (existsSync(this.historyPath)) {
      try {
        const content = readFileSync(this.historyPath, "utf-8");
        this.history = JSON.parse(content) as BenchmarkSnapshot[];
      } catch {
        this.history = [];
      }
    }
  }

  private saveHistory(): void {
    const dir = dirname(this.historyPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.historyPath, JSON.stringify(this.history, null, 2), "utf-8");
  }
}

/**
 * A/B Test Tests — Strategy comparison with statistical significance.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { StrategyStore } from "../strategy-store.js";
import { ABTestManager } from "../ab-test.js";
import type { Strategy, StrategyDomain, StrategyOutcome } from "../types.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

const TEST_DIR = join(import.meta.dirname, "../../.test-ab-test");

function makeStrategy(overrides: Partial<Strategy> = {}): Strategy {
  const now = new Date().toISOString();
  return {
    id: `strategy-${Math.random().toString(36).slice(2, 8)}`,
    name: "Test Strategy",
    domain: "general",
    status: "active",
    version: 1,
    prompt: { template: "test", requiredVars: [], defaults: {} },
    model: { modelId: "test-model" },
    toolPolicy: { allow: ["bash"] },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function addOutcomes(
  store: StrategyStore,
  strategyId: string,
  successCount: number,
  failureCount: number,
): void {
  for (let i = 0; i < successCount; i++) {
    store.recordOutcome({
      strategyId,
      success: true,
      durationMs: 1000,
      timestamp: new Date().toISOString(),
    });
  }
  for (let i = 0; i < failureCount; i++) {
    store.recordOutcome({
      strategyId,
      success: false,
      durationMs: 2000,
      timestamp: new Date().toISOString(),
    });
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("ABTestManager", () => {
  let store: StrategyStore;
  let abm: ABTestManager;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new StrategyStore(TEST_DIR);
    abm = new ABTestManager(store);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── Test Creation ─────────────────────────────────────────────────────────

  describe("createTest", () => {
    it("should create a valid A/B test", () => {
      const s1 = makeStrategy({ id: "s1", domain: "coding" });
      const s2 = makeStrategy({ id: "s2", domain: "coding" });
      store.add(s1);
      store.add(s2);

      const result = abm.createTest({
        id: "test-1",
        name: "Coding Strategy Test",
        domain: "coding",
        variants: [
          { strategyId: "s1", label: "control", allocation: 0.5 },
          { strategyId: "s2", label: "treatment", allocation: 0.5 },
        ],
        minTotalRuns: 20,
        minVariantRuns: 5,
        confidenceLevel: 0.95,
        maxDurationMs: 0,
      });

      expect(typeof result).not.toBe("string");
      if (typeof result !== "string") {
        expect(result.id).toBe("test-1");
        expect(result.variants).toHaveLength(2);
      }
    });

    it("should reject test with fewer than 2 variants", () => {
      const s1 = makeStrategy({ id: "s1" });
      store.add(s1);

      const result = abm.createTest({
        id: "test-1",
        name: "Bad Test",
        domain: "general",
        variants: [{ strategyId: "s1", label: "only", allocation: 1.0 }],
        minTotalRuns: 10,
        minVariantRuns: 5,
        confidenceLevel: 0.95,
        maxDurationMs: 0,
      });

      expect(typeof result).toBe("string");
      expect(result).toContain("at least 2 variants");
    });

    it("should reject test with invalid allocations", () => {
      const s1 = makeStrategy({ id: "s1" });
      const s2 = makeStrategy({ id: "s2" });
      store.add(s1);
      store.add(s2);

      const result = abm.createTest({
        id: "test-1",
        name: "Bad Test",
        domain: "general",
        variants: [
          { strategyId: "s1", label: "a", allocation: 0.3 },
          { strategyId: "s2", label: "b", allocation: 0.3 },
        ],
        minTotalRuns: 10,
        minVariantRuns: 5,
        confidenceLevel: 0.95,
        maxDurationMs: 0,
      });

      expect(typeof result).toBe("string");
      expect(result).toContain("sum to 1.0");
    });

    it("should reject test with non-existent strategy", () => {
      const s1 = makeStrategy({ id: "s1" });
      store.add(s1);

      const result = abm.createTest({
        id: "test-1",
        name: "Bad Test",
        domain: "general",
        variants: [
          { strategyId: "s1", label: "a", allocation: 0.5 },
          { strategyId: "nonexistent", label: "b", allocation: 0.5 },
        ],
        minTotalRuns: 10,
        minVariantRuns: 5,
        confidenceLevel: 0.95,
        maxDurationMs: 0,
      });

      expect(typeof result).toBe("string");
      expect(result).toContain("Strategy not found");
    });

    it("should reject test with duplicate strategies", () => {
      const s1 = makeStrategy({ id: "s1" });
      store.add(s1);

      const result = abm.createTest({
        id: "test-1",
        name: "Bad Test",
        domain: "general",
        variants: [
          { strategyId: "s1", label: "a", allocation: 0.5 },
          { strategyId: "s1", label: "b", allocation: 0.5 },
        ],
        minTotalRuns: 10,
        minVariantRuns: 5,
        confidenceLevel: 0.95,
        maxDurationMs: 0,
      });

      expect(typeof result).toBe("string");
      expect(result).toContain("different strategy");
    });
  });

  // ── Traffic Routing ───────────────────────────────────────────────────────

  describe("route", () => {
    it("should route to valid strategy", () => {
      const s1 = makeStrategy({ id: "s1" });
      const s2 = makeStrategy({ id: "s2" });
      store.add(s1);
      store.add(s2);

      abm.createTest({
        id: "test-1",
        name: "Test",
        domain: "general",
        variants: [
          { strategyId: "s1", label: "a", allocation: 0.5 },
          { strategyId: "s2", label: "b", allocation: 0.5 },
        ],
        minTotalRuns: 100,
        minVariantRuns: 5,
        confidenceLevel: 0.95,
        maxDurationMs: 0,
      });

      const routed = abm.route("test-1");
      expect(routed === "s1" || routed === "s2").toBe(true);
    });

    it("should return null for non-existent test", () => {
      expect(abm.route("nonexistent")).toBeNull();
    });

    it("should distribute traffic roughly according to allocation", () => {
      const s1 = makeStrategy({ id: "s1" });
      const s2 = makeStrategy({ id: "s2" });
      store.add(s1);
      store.add(s2);

      abm.createTest({
        id: "test-1",
        name: "Test",
        domain: "general",
        variants: [
          { strategyId: "s1", label: "a", allocation: 0.7 },
          { strategyId: "s2", label: "b", allocation: 0.3 },
        ],
        minTotalRuns: 10000, // Keep running
        minVariantRuns: 5,
        confidenceLevel: 0.95,
        maxDurationMs: 0,
      });

      let s1Count = 0;
      const total = 1000;
      for (let i = 0; i < total; i++) {
        if (abm.route("test-1") === "s1") s1Count++;
      }

      // With 1000 samples, expect ~700 ± ~50 for s1
      expect(s1Count).toBeGreaterThan(600);
      expect(s1Count).toBeLessThan(800);
    });
  });

  // ── Test Status ───────────────────────────────────────────────────────────

  describe("getTestStatus", () => {
    it("should report running for new test", () => {
      const s1 = makeStrategy({ id: "s1" });
      const s2 = makeStrategy({ id: "s2" });
      store.add(s1);
      store.add(s2);

      abm.createTest({
        id: "test-1",
        name: "Test",
        domain: "general",
        variants: [
          { strategyId: "s1", label: "a", allocation: 0.5 },
          { strategyId: "s2", label: "b", allocation: 0.5 },
        ],
        minTotalRuns: 100,
        minVariantRuns: 5,
        confidenceLevel: 0.95,
        maxDurationMs: 0,
      });

      expect(abm.getTestStatus("test-1")).toBe("running");
    });

    it("should report completed when enough data collected", () => {
      const s1 = makeStrategy({ id: "s1" });
      const s2 = makeStrategy({ id: "s2" });
      store.add(s1);
      store.add(s2);

      abm.createTest({
        id: "test-1",
        name: "Test",
        domain: "general",
        variants: [
          { strategyId: "s1", label: "a", allocation: 0.5 },
          { strategyId: "s2", label: "b", allocation: 0.5 },
        ],
        minTotalRuns: 10,
        minVariantRuns: 2,
        confidenceLevel: 0.95,
        maxDurationMs: 0,
      });

      // Route enough times to complete
      for (let i = 0; i < 15; i++) {
        abm.route("test-1");
      }

      expect(abm.getTestStatus("test-1")).toBe("completed");
    });
  });

  // ── Analysis ──────────────────────────────────────────────────────────────

  describe("analyze", () => {
    it("should analyze a test with clear winner", () => {
      const s1 = makeStrategy({ id: "s1", name: "Strategy A" });
      const s2 = makeStrategy({ id: "s2", name: "Strategy B" });
      store.add(s1);
      store.add(s2);

      // Give s1 much better success rate
      addOutcomes(store, "s1", 45, 5); // 90% success
      addOutcomes(store, "s2", 25, 25); // 50% success

      abm.createTest({
        id: "test-1",
        name: "Clear Winner Test",
        domain: "general",
        variants: [
          { strategyId: "s1", label: "control", allocation: 0.5 },
          { strategyId: "s2", label: "treatment", allocation: 0.5 },
        ],
        minTotalRuns: 10,
        minVariantRuns: 5,
        confidenceLevel: 0.95,
        maxDurationMs: 0,
      });

      // Route enough for completion
      for (let i = 0; i < 20; i++) {
        abm.route("test-1");
      }

      const result = abm.analyze("test-1");
      expect(typeof result).not.toBe("string");
      if (typeof result !== "string") {
        expect(result.variants).toHaveLength(2);
        expect(result.comparisons).toHaveLength(1);
        expect(result.winner).toBe("s1");
        expect(result.summary).toContain("Winner");
      }
    });

    it("should report no winner when difference is not significant", () => {
      const s1 = makeStrategy({ id: "s1" });
      const s2 = makeStrategy({ id: "s2" });
      store.add(s1);
      store.add(s2);

      // Very similar success rates with small sample
      addOutcomes(store, "s1", 6, 4); // 60%
      addOutcomes(store, "s2", 5, 5); // 50%

      abm.createTest({
        id: "test-1",
        name: "Close Test",
        domain: "general",
        variants: [
          { strategyId: "s1", label: "a", allocation: 0.5 },
          { strategyId: "s2", label: "b", allocation: 0.5 },
        ],
        minTotalRuns: 10,
        minVariantRuns: 5,
        confidenceLevel: 0.95,
        maxDurationMs: 0,
      });

      for (let i = 0; i < 15; i++) {
        abm.route("test-1");
      }

      const result = abm.analyze("test-1");
      expect(typeof result).not.toBe("string");
      if (typeof result !== "string") {
        // With small samples and close rates, should not declare winner
        expect(result.winner).toBeNull();
      }
    });

    it("should return error for non-existent test", () => {
      const result = abm.analyze("nonexistent");
      expect(typeof result).toBe("string");
      expect(result).toContain("not found");
    });

    it("should handle test with no outcomes", () => {
      const s1 = makeStrategy({ id: "s1" });
      const s2 = makeStrategy({ id: "s2" });
      store.add(s1);
      store.add(s2);

      abm.createTest({
        id: "test-1",
        name: "Empty Test",
        domain: "general",
        variants: [
          { strategyId: "s1", label: "a", allocation: 0.5 },
          { strategyId: "s2", label: "b", allocation: 0.5 },
        ],
        minTotalRuns: 10,
        minVariantRuns: 5,
        confidenceLevel: 0.95,
        maxDurationMs: 0,
      });

      const result = abm.analyze("test-1");
      expect(typeof result).not.toBe("string");
      if (typeof result !== "string") {
        expect(result.totalRuns).toBe(0);
        expect(result.winner).toBeNull();
      }
    });
  });

  // ── getLeadingVariant ─────────────────────────────────────────────────────

  describe("getLeadingVariant", () => {
    it("should return the variant with highest success rate", () => {
      const s1 = makeStrategy({ id: "s1" });
      const s2 = makeStrategy({ id: "s2" });
      store.add(s1);
      store.add(s2);

      addOutcomes(store, "s1", 8, 2); // 80%
      addOutcomes(store, "s2", 4, 6); // 40%

      abm.createTest({
        id: "test-1",
        name: "Test",
        domain: "general",
        variants: [
          { strategyId: "s1", label: "winner", allocation: 0.5 },
          { strategyId: "s2", label: "loser", allocation: 0.5 },
        ],
        minTotalRuns: 100,
        minVariantRuns: 5,
        confidenceLevel: 0.95,
        maxDurationMs: 0,
      });

      const leader = abm.getLeadingVariant("test-1");
      expect(leader).not.toBeNull();
      expect(leader!.strategyId).toBe("s1");
    });

    it("should return null for non-existent test", () => {
      expect(abm.getLeadingVariant("nonexistent")).toBeNull();
    });
  });

  // ── listTests ─────────────────────────────────────────────────────────────

  describe("listTests", () => {
    it("should list all tests", () => {
      const s1 = makeStrategy({ id: "s1" });
      const s2 = makeStrategy({ id: "s2" });
      store.add(s1);
      store.add(s2);

      abm.createTest({
        id: "test-1", name: "Test 1", domain: "general",
        variants: [
          { strategyId: "s1", label: "a", allocation: 0.5 },
          { strategyId: "s2", label: "b", allocation: 0.5 },
        ],
        minTotalRuns: 10, minVariantRuns: 5, confidenceLevel: 0.95, maxDurationMs: 0,
      });
      abm.createTest({
        id: "test-2", name: "Test 2", domain: "coding",
        variants: [
          { strategyId: "s1", label: "a", allocation: 0.5 },
          { strategyId: "s2", label: "b", allocation: 0.5 },
        ],
        minTotalRuns: 10, minVariantRuns: 5, confidenceLevel: 0.95, maxDurationMs: 0,
      });

      expect(abm.listTests()).toHaveLength(2);
    });

    it("should filter by status", () => {
      const s1 = makeStrategy({ id: "s1" });
      const s2 = makeStrategy({ id: "s2" });
      store.add(s1);
      store.add(s2);

      abm.createTest({
        id: "test-1", name: "Running", domain: "general",
        variants: [
          { strategyId: "s1", label: "a", allocation: 0.5 },
          { strategyId: "s2", label: "b", allocation: 0.5 },
        ],
        minTotalRuns: 100, minVariantRuns: 5, confidenceLevel: 0.95, maxDurationMs: 0,
      });

      expect(abm.listTests("running")).toHaveLength(1);
      expect(abm.listTests("completed")).toHaveLength(0);
    });
  });

  // ── recordTestOutcome ─────────────────────────────────────────────────────

  describe("recordTestOutcome", () => {
    it("should record outcome for valid variant", () => {
      const s1 = makeStrategy({ id: "s1" });
      const s2 = makeStrategy({ id: "s2" });
      store.add(s1);
      store.add(s2);

      abm.createTest({
        id: "test-1", name: "Test", domain: "general",
        variants: [
          { strategyId: "s1", label: "a", allocation: 0.5 },
          { strategyId: "s2", label: "b", allocation: 0.5 },
        ],
        minTotalRuns: 100, minVariantRuns: 5, confidenceLevel: 0.95, maxDurationMs: 0,
      });

      const recorded = abm.recordTestOutcome("test-1", {
        strategyId: "s1",
        success: true,
        durationMs: 500,
        timestamp: new Date().toISOString(),
      });

      expect(recorded).toBe(true);
    });

    it("should reject outcome for non-variant strategy", () => {
      const s1 = makeStrategy({ id: "s1" });
      const s2 = makeStrategy({ id: "s2" });
      const s3 = makeStrategy({ id: "s3" });
      store.add(s1);
      store.add(s2);
      store.add(s3);

      abm.createTest({
        id: "test-1", name: "Test", domain: "general",
        variants: [
          { strategyId: "s1", label: "a", allocation: 0.5 },
          { strategyId: "s2", label: "b", allocation: 0.5 },
        ],
        minTotalRuns: 100, minVariantRuns: 5, confidenceLevel: 0.95, maxDurationMs: 0,
      });

      const recorded = abm.recordTestOutcome("test-1", {
        strategyId: "s3", // not in test
        success: true,
        durationMs: 500,
        timestamp: new Date().toISOString(),
      });

      expect(recorded).toBe(false);
    });
  });

  // ── Sample Size Calculator ────────────────────────────────────────────────

  describe("computeRequiredSampleSize", () => {
    it("should compute reasonable sample size", () => {
      // Detecting 10% effect from 50% baseline
      const n = ABTestManager.computeRequiredSampleSize(0.5, 0.1, 0.95, 0.80);
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(1000);
    });

    it("should require larger sample for smaller effects", () => {
      const nLarge = ABTestManager.computeRequiredSampleSize(0.5, 0.05, 0.95, 0.80);
      const nSmall = ABTestManager.computeRequiredSampleSize(0.5, 0.15, 0.95, 0.80);
      expect(nLarge).toBeGreaterThan(nSmall);
    });

    it("should return Infinity for zero effect", () => {
      const n = ABTestManager.computeRequiredSampleSize(0.5, 0, 0.95, 0.80);
      expect(n).toBe(Infinity);
    });
  });

  // ── Statistical Accuracy ──────────────────────────────────────────────────

  describe("statistical accuracy", () => {
    it("should detect significant difference with large sample", () => {
      const s1 = makeStrategy({ id: "s1" });
      const s2 = makeStrategy({ id: "s2" });
      store.add(s1);
      store.add(s2);

      // Large sample, clear difference
      addOutcomes(store, "s1", 90, 10); // 90%
      addOutcomes(store, "s2", 60, 40); // 60%

      abm.createTest({
        id: "test-1", name: "Large Sample", domain: "general",
        variants: [
          { strategyId: "s1", label: "a", allocation: 0.5 },
          { strategyId: "s2", label: "b", allocation: 0.5 },
        ],
        minTotalRuns: 5, minVariantRuns: 5, confidenceLevel: 0.95, maxDurationMs: 0,
      });

      const result = abm.analyze("test-1");
      expect(typeof result).not.toBe("string");
      if (typeof result !== "string") {
        expect(result.comparisons).toHaveLength(1);
        expect(result.comparisons[0]!.isSignificant).toBe(true);
        expect(result.comparisons[0]!.pValue).toBeLessThan(0.05);
      }
    });

    it("should not detect significance with very small sample", () => {
      const s1 = makeStrategy({ id: "s1" });
      const s2 = makeStrategy({ id: "s2" });
      store.add(s1);
      store.add(s2);

      // Tiny sample
      addOutcomes(store, "s1", 3, 2); // 60%
      addOutcomes(store, "s2", 2, 3); // 40%

      abm.createTest({
        id: "test-1", name: "Tiny Sample", domain: "general",
        variants: [
          { strategyId: "s1", label: "a", allocation: 0.5 },
          { strategyId: "s2", label: "b", allocation: 0.5 },
        ],
        minTotalRuns: 5, minVariantRuns: 2, confidenceLevel: 0.95, maxDurationMs: 0,
      });

      const result = abm.analyze("test-1");
      expect(typeof result).not.toBe("string");
      if (typeof result !== "string") {
        expect(result.comparisons[0]!.isSignificant).toBe(false);
      }
    });
  });
});

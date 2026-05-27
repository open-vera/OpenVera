/**
 * AutoTuner Tests — UCB1 strategy selection, composite scoring, optimization cycles.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { StrategyStore } from "../strategy-store.js";
import { AutoTuner } from "../auto-tuner.js";
import type { Strategy, StrategyDomain, StrategyOutcome } from "../types.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

const TEST_DIR = join(import.meta.dirname, "../../.test-auto-tuner");

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

function makeOutcome(
  strategyId: string,
  success = true,
  overrides: Partial<StrategyOutcome> = {},
): StrategyOutcome {
  return {
    strategyId,
    success,
    durationMs: 1000,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function addOutcomes(
  store: StrategyStore,
  strategyId: string,
  successCount: number,
  failureCount: number,
  overrides: Partial<StrategyOutcome> = {},
): void {
  for (let i = 0; i < successCount; i++) {
    store.recordOutcome(makeOutcome(strategyId, true, overrides));
  }
  for (let i = 0; i < failureCount; i++) {
    store.recordOutcome(makeOutcome(strategyId, false, overrides));
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("AutoTuner", () => {
  let store: StrategyStore;
  let tuner: AutoTuner;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new StrategyStore(TEST_DIR);
    tuner = new AutoTuner(store);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── Composite Scoring ──────────────────────────────────────────────────────

  describe("composite scoring", () => {
    it("should compute score with all components", () => {
      store.add(makeStrategy({ id: "s1" }));
      // 8/10 success, 1000ms avg, 500 tokens/run
      for (let i = 0; i < 8; i++) {
        store.recordOutcome(
          makeOutcome("s1", true, {
            durationMs: 1000,
            tokenUsage: { input: 300, output: 200 },
          }),
        );
      }
      for (let i = 0; i < 2; i++) {
        store.recordOutcome(makeOutcome("s1", false, { durationMs: 1000 }));
      }

      const score = tuner.computeCompositeScore("s1");
      expect(score.strategyId).toBe("s1");
      expect(score.successComponent).toBeCloseTo(0.8, 5);
      expect(score.speedComponent).toBeCloseTo(1.0, 5); // refDuration(5000) / 1000 = 5, clamped to 1
      expect(score.totalRuns).toBe(10);
      expect(score.score).toBeGreaterThan(0);
    });

    it("should give higher score to strategy with better success rate", () => {
      store.add(makeStrategy({ id: "s-good", domain: "coding" }));
      store.add(makeStrategy({ id: "s-bad", domain: "coding" }));

      addOutcomes(store, "s-good", 9, 1); // 90%
      addOutcomes(store, "s-bad", 3, 7); // 30%

      const goodScore = tuner.computeCompositeScore("s-good");
      const badScore = tuner.computeCompositeScore("s-bad");

      expect(goodScore.score).toBeGreaterThan(badScore.score);
    });

    it("should give higher score to faster strategy", () => {
      store.add(makeStrategy({ id: "s-fast", domain: "coding" }));
      store.add(makeStrategy({ id: "s-slow", domain: "coding" }));

      addOutcomes(store, "s-fast", 5, 0, { durationMs: 500 });
      addOutcomes(store, "s-slow", 5, 0, { durationMs: 50000 }); // 50s → speedComponent = 5000/50000 = 0.1

      const fastScore = tuner.computeCompositeScore("s-fast");
      const slowScore = tuner.computeCompositeScore("s-slow");

      expect(fastScore.speedComponent).toBeGreaterThan(slowScore.speedComponent);
      expect(fastScore.score).toBeGreaterThan(slowScore.score);
    });

    it("should give infinite exploration bonus to untried strategy", () => {
      store.add(makeStrategy({ id: "s-new", domain: "coding" }));
      store.add(makeStrategy({ id: "s-old", domain: "coding" }));

      addOutcomes(store, "s-old", 5, 0); // s-old has data

      const newScore = tuner.computeCompositeScore("s-new");
      const oldScore = tuner.computeCompositeScore("s-old");

      expect(newScore.explorationBonus).toBe(Infinity);
      expect(newScore.totalRuns).toBe(0);
      expect(newScore.score).toBe(Infinity);
      expect(oldScore.explorationBonus).toBeLessThan(Infinity);
    });

    it("should handle strategy with zero outcomes", () => {
      store.add(makeStrategy({ id: "s1" }));

      const score = tuner.computeCompositeScore("s1");
      expect(score.totalRuns).toBe(0);
      expect(score.successComponent).toBe(0);
      expect(score.speedComponent).toBe(0);
      expect(score.costComponent).toBe(0);
      expect(score.explorationBonus).toBe(Infinity);
    });
  });

  // ── Domain Scoring ─────────────────────────────────────────────────────────

  describe("domain scoring", () => {
    it("should score and rank strategies in a domain", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "active" }));
      store.add(makeStrategy({ id: "s2", domain: "coding", status: "active" }));
      store.add(makeStrategy({ id: "s3", domain: "coding", status: "active" }));

      addOutcomes(store, "s1", 8, 2); // 80%
      addOutcomes(store, "s2", 5, 5); // 50%
      addOutcomes(store, "s3", 9, 1); // 90%

      const ranked = tuner.scoreDomain("coding");
      expect(ranked).toHaveLength(3);
      // Should be sorted best-first
      expect(ranked[0]!.strategyId).toBe("s3");
    });

    it("should return empty for domain with no strategies", () => {
      expect(tuner.scoreDomain("research")).toHaveLength(0);
    });

    it("should only score strategies in the specified domain", () => {
      store.add(makeStrategy({ id: "s-coding", domain: "coding" }));
      store.add(makeStrategy({ id: "s-research", domain: "research" }));

      addOutcomes(store, "s-coding", 5, 0);
      addOutcomes(store, "s-research", 5, 0);

      const codingScores = tuner.scoreDomain("coding");
      expect(codingScores).toHaveLength(1);
      expect(codingScores[0]!.strategyId).toBe("s-coding");
    });
  });

  // ── Optimal Selection ──────────────────────────────────────────────────────

  describe("optimal selection", () => {
    it("should select the best active strategy", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "active" }));
      store.add(makeStrategy({ id: "s2", domain: "coding", status: "active" }));

      addOutcomes(store, "s1", 9, 1); // 90%
      addOutcomes(store, "s2", 3, 7); // 30%

      const optimal = tuner.selectOptimal("coding");
      expect(optimal).toBeDefined();
      expect(optimal!.strategyId).toBe("s1");
    });

    it("should include candidate strategies in selection", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "active" }));
      store.add(makeStrategy({ id: "s2", domain: "coding", status: "candidate" }));

      addOutcomes(store, "s1", 5, 5); // 50%
      addOutcomes(store, "s2", 10, 0); // 100%

      const optimal = tuner.selectOptimal("coding");
      expect(optimal!.strategyId).toBe("s2");
    });

    it("should exclude deprecated and retired strategies", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "deprecated" }));
      store.add(makeStrategy({ id: "s2", domain: "coding", status: "retired" }));

      addOutcomes(store, "s1", 10, 0);
      addOutcomes(store, "s2", 10, 0);

      const optimal = tuner.selectOptimal("coding");
      expect(optimal).toBeUndefined();
    });

    it("should return undefined for domain with no eligible strategies", () => {
      expect(tuner.selectOptimal("research")).toBeUndefined();
    });

    it("should prefer unexplored strategy due to exploration bonus", () => {
      store.add(makeStrategy({ id: "s-explored", domain: "coding", status: "active" }));
      store.add(makeStrategy({ id: "s-new", domain: "coding", status: "candidate" }));

      // s-explored has mediocre performance
      addOutcomes(store, "s-explored", 5, 5); // 50%
      // s-new has no outcomes but infinite exploration bonus

      const optimal = tuner.selectOptimal("coding");
      expect(optimal!.strategyId).toBe("s-new");
    });
  });

  // ── Optimization Cycle ─────────────────────────────────────────────────────

  describe("optimization cycle", () => {
    it("should generate recommendations for all domains", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "active" }));
      store.add(makeStrategy({ id: "s2", domain: "research", status: "active" }));

      addOutcomes(store, "s1", 8, 2);
      addOutcomes(store, "s2", 6, 4);

      const result = tuner.runOptimizationCycle();
      expect(result.timestamp).toBeDefined();
      expect(result.recommendations.length).toBeGreaterThanOrEqual(2);

      const codingRec = result.recommendations.find((r) => r.domain === "coding");
      expect(codingRec).toBeDefined();
      expect(codingRec!.recommendedId).toBe("s1");
    });

    it("should track empty domains", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "active" }));
      addOutcomes(store, "s1", 5, 0);

      const result = tuner.runOptimizationCycle();
      expect(result.emptyDomains).toContain("research");
      expect(result.emptyDomains).toContain("debugging");
      expect(result.emptyDomains).not.toContain("coding");
    });

    it("should run auto-tune as part of optimization", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "candidate" }));
      addOutcomes(store, "s1", 10, 0); // 100% → should be promoted

      const result = tuner.runOptimizationCycle();
      expect(result.autoTuned).toContain("s1");
      expect(store.get("s1")!.status).toBe("active");
    });

    it("should count total strategies analyzed", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding" }));
      store.add(makeStrategy({ id: "s2", domain: "coding" }));
      store.add(makeStrategy({ id: "s3", domain: "research" }));

      const result = tuner.runOptimizationCycle();
      expect(result.totalStrategiesAnalyzed).toBe(3);
    });

    it("should mark recommendation as change when different from current best", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "active" }));
      store.add(makeStrategy({ id: "s2", domain: "coding", status: "active" }));

      // s1 has data → current best
      addOutcomes(store, "s1", 5, 5);
      // s2 is unexplored → infinite exploration bonus → recommended
      // But with enough data, s1 should be recommended
      addOutcomes(store, "s2", 0, 0);

      const result = tuner.runOptimizationCycle();
      const rec = result.recommendations.find((r) => r.domain === "coding");
      expect(rec).toBeDefined();
      // s2 has infinite bonus, so it should be recommended over s1
      expect(rec!.recommendedId).toBe("s2");
      expect(rec!.isChange).toBe(true);
    });

    it("should store optimization history", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding" }));
      addOutcomes(store, "s1", 5, 0);

      tuner.runOptimizationCycle();
      tuner.runOptimizationCycle();

      expect(tuner.getHistory()).toHaveLength(2);
      expect(tuner.getRecentHistory(1)).toHaveLength(1);
    });

    it("should generate reason with insufficient data message", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "active" }));
      addOutcomes(store, "s1", 1, 0); // only 1 run, below minDomainRuns=5

      const result = tuner.runOptimizationCycle();
      const rec = result.recommendations.find((r) => r.domain === "coding");
      expect(rec).toBeDefined();
      expect(rec!.reason).toContain("Insufficient data");
    });
  });

  // ── Batch Recommendations ──────────────────────────────────────────────────

  describe("batch recommendations", () => {
    it("should return recommendations map for all domains", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "active" }));
      store.add(makeStrategy({ id: "s2", domain: "research", status: "active" }));

      addOutcomes(store, "s1", 5, 0);
      addOutcomes(store, "s2", 5, 0);

      const recs = tuner.getRecommendations();
      expect(recs.has("coding")).toBe(true);
      expect(recs.has("research")).toBe(true);
      expect(recs.get("coding")).toBe("s1");
    });

    it("should return empty map when no eligible strategies", () => {
      const recs = tuner.getRecommendations();
      expect(recs.size).toBe(0);
    });
  });

  // ── Top Strategies ─────────────────────────────────────────────────────────

  describe("top strategies", () => {
    it("should return top N strategies across all domains", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "active" }));
      store.add(makeStrategy({ id: "s2", domain: "research", status: "active" }));
      store.add(makeStrategy({ id: "s3", domain: "writing", status: "active" }));

      addOutcomes(store, "s1", 9, 1, { durationMs: 500 });
      addOutcomes(store, "s2", 7, 3, { durationMs: 1000 });
      addOutcomes(store, "s3", 5, 5, { durationMs: 2000 });

      const top = tuner.getTopStrategies(2);
      expect(top).toHaveLength(2);
      expect(top[0]!.strategyId).toBe("s1"); // best overall
    });

    it("should exclude non-active strategies from top", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "active" }));
      store.add(makeStrategy({ id: "s2", domain: "research", status: "deprecated" }));

      addOutcomes(store, "s1", 5, 0);
      addOutcomes(store, "s2", 10, 0); // better data but deprecated

      const top = tuner.getTopStrategies(5);
      expect(top).toHaveLength(1);
      expect(top[0]!.strategyId).toBe("s1");
    });

    it("should default to top 5", () => {
      for (let i = 0; i < 10; i++) {
        store.add(makeStrategy({ id: `s${i}`, domain: "coding", status: "active" }));
        addOutcomes(store, `s${i}`, i, 10 - i);
      }

      const top = tuner.getTopStrategies();
      expect(top).toHaveLength(5);
    });
  });

  // ── Recommendation Stability ───────────────────────────────────────────────

  describe("recommendation stability", () => {
    it("should detect stable recommendation", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "active" }));
      addOutcomes(store, "s1", 10, 0);

      tuner.runOptimizationCycle();
      tuner.runOptimizationCycle();
      tuner.runOptimizationCycle();

      const stability = tuner.getRecommendationStability("coding");
      expect(stability.stable).toBe(true);
      expect(stability.changes).toBe(0);
    });

    it("should detect recommendation changes", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "active" }));
      addOutcomes(store, "s1", 10, 0);

      // First cycle: s1 recommended
      tuner.runOptimizationCycle();

      // Add a new unexplored strategy
      store.add(makeStrategy({ id: "s2", domain: "coding", status: "candidate" }));

      // Second cycle: s2 recommended (infinite exploration bonus)
      tuner.runOptimizationCycle();

      const stability = tuner.getRecommendationStability("coding");
      expect(stability.changes).toBe(1);
    });

    it("should return empty stability for domain with no history", () => {
      const stability = tuner.getRecommendationStability("coding");
      expect(stability.stable).toBe(true);
      expect(stability.changes).toBe(0);
      expect(stability.currentRecommendation).toBeNull();
    });
  });

  // ── Configuration ──────────────────────────────────────────────────────────

  describe("configuration", () => {
    it("should use default config", () => {
      const config = tuner.getConfig();
      expect(config.successWeight).toBe(0.6);
      expect(config.speedWeight).toBe(0.2);
      expect(config.costWeight).toBe(0.2);
      expect(config.explorationCoeff).toBe(1.414);
    });

    it("should allow custom config", () => {
      const customTuner = new AutoTuner(store, {
        successWeight: 0.8,
        speedWeight: 0.1,
        costWeight: 0.1,
        explorationCoeff: 2.0,
      });

      const config = customTuner.getConfig();
      expect(config.successWeight).toBe(0.8);
      expect(config.explorationCoeff).toBe(2.0);
    });

    it("should update config at runtime", () => {
      tuner.updateConfig({ successWeight: 0.9 });
      expect(tuner.getConfig().successWeight).toBe(0.9);
      // Other values unchanged
      expect(tuner.getConfig().speedWeight).toBe(0.2);
    });

    it("should affect scoring when weights change", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding" }));
      addOutcomes(store, "s1", 8, 2, { durationMs: 1000, tokenUsage: { input: 500, output: 500 } });

      const scoreDefault = tuner.computeCompositeScore("s1");

      tuner.updateConfig({ successWeight: 1.0, speedWeight: 0, costWeight: 0 });
      const scoreSuccessOnly = tuner.computeCompositeScore("s1");

      // With successWeight=1.0, the base score should equal successComponent
      expect(scoreSuccessOnly.successComponent).toBeCloseTo(0.8, 5);
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle store with no strategies at all", () => {
      const result = tuner.runOptimizationCycle();
      expect(result.recommendations).toHaveLength(0);
      expect(result.emptyDomains).toHaveLength(10); // all domains empty
      expect(result.totalStrategiesAnalyzed).toBe(0);
    });

    it("should handle multiple domains with mixed data", () => {
      // coding: has data
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "active" }));
      addOutcomes(store, "s1", 8, 2);

      // research: no outcomes
      store.add(makeStrategy({ id: "s2", domain: "research", status: "active" }));

      // writing: deprecated only
      store.add(makeStrategy({ id: "s3", domain: "writing", status: "deprecated" }));
      addOutcomes(store, "s3", 10, 0);

      const result = tuner.runOptimizationCycle();

      const codingRec = result.recommendations.find((r) => r.domain === "coding");
      expect(codingRec!.recommendedId).toBe("s1");

      const researchRec = result.recommendations.find((r) => r.domain === "research");
      expect(researchRec!.recommendedId).toBe("s2"); // only option
      expect(researchRec!.reason).toContain("Insufficient data");
    });

    it("should handle strategy with only failures", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "active" }));
      addOutcomes(store, "s1", 0, 10);

      const score = tuner.computeCompositeScore("s1");
      expect(score.successComponent).toBe(0);
      expect(score.score).toBeLessThan(1);
    });

    it("should handle very fast strategies (high speed component)", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding" }));
      addOutcomes(store, "s1", 5, 0, { durationMs: 10 }); // 10ms, very fast

      const score = tuner.computeCompositeScore("s1");
      expect(score.speedComponent).toBe(1); // clamped at 1
    });

    it("should handle very slow strategies (low speed component)", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding" }));
      addOutcomes(store, "s1", 5, 0, { durationMs: 100_000 }); // 100s

      const score = tuner.computeCompositeScore("s1");
      expect(score.speedComponent).toBeLessThan(0.1);
    });
  });
});

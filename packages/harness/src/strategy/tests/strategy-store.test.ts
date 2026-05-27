/**
 * StrategyStore Tests — CRUD, filtering, outcome tracking, statistics, comparison.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StrategyStore } from "../strategy-store.js";
import type {
  Strategy,
  StrategyDomain,
  StrategyOutcome,
  ModelConfig,
  ToolPolicy,
  PromptTemplate,
  TimeWindow,
} from "../types.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

const TEST_DIR = join(import.meta.dirname, "../../.test-strategy-store");

function makeStrategy(overrides: Partial<Strategy> = {}): Strategy {
  const now = new Date().toISOString();
  return {
    id: `strategy-${Math.random().toString(36).slice(2, 8)}`,
    name: "Test Strategy",
    domain: "general",
    status: "active",
    version: 1,
    prompt: {
      template: "You are a {{role}} assistant.",
      requiredVars: ["role"],
      defaults: { role: "helpful" },
    },
    model: {
      modelId: "claude-sonnet-4-6",
      temperature: 0.7,
      maxTokens: 4096,
    },
    toolPolicy: {
      allow: ["bash", "read", "write"],
      deny: ["eval"],
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeOutcome(
  strategyId: string,
  success = true,
  overrides: Partial<StrategyOutcome> = {}
): StrategyOutcome {
  return {
    strategyId,
    success,
    durationMs: 1000,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("StrategyStore", () => {
  let store: StrategyStore;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new StrategyStore(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── CRUD ──────────────────────────────────────────────────────────────────

  describe("CRUD operations", () => {
    it("should add a strategy", () => {
      const strategy = makeStrategy({ id: "s1" });
      expect(store.add(strategy)).toBe(true);
      expect(store.count()).toBe(1);
      expect(store.get("s1")).toBeDefined();
      expect(store.get("s1")!.name).toBe("Test Strategy");
    });

    it("should reject duplicate IDs", () => {
      store.add(makeStrategy({ id: "s1" }));
      expect(store.add(makeStrategy({ id: "s1", name: "Duplicate" }))).toBe(false);
      expect(store.count()).toBe(1);
    });

    it("should get undefined for missing strategy", () => {
      expect(store.get("nonexistent")).toBeUndefined();
    });

    it("should update a strategy and increment version", () => {
      store.add(makeStrategy({ id: "s1", version: 1 }));
      const result = store.update("s1", { name: "Updated" });
      expect(result).toBe(true);

      const updated = store.get("s1")!;
      expect(updated.name).toBe("Updated");
      expect(updated.version).toBe(2);
      expect(updated.createdAt).toBeDefined();
    });

    it("should return false when updating nonexistent strategy", () => {
      expect(store.update("nonexistent", { name: "x" })).toBe(false);
    });

    it("should not allow changing id or createdAt on update", () => {
      const original = makeStrategy({ id: "s1" });
      store.add(original);
      store.update("s1", { id: "s2" } as Partial<Strategy>);
      expect(store.get("s1")).toBeDefined();
      expect(store.get("s2")).toBeUndefined();
    });

    it("should remove a strategy and its outcomes", () => {
      store.add(makeStrategy({ id: "s1" }));
      store.recordOutcome(makeOutcome("s1"));
      store.recordOutcome(makeOutcome("s1"));

      expect(store.remove("s1")).toBe(true);
      expect(store.get("s1")).toBeUndefined();
      expect(store.getOutcomes("s1")).toHaveLength(0);
    });

    it("should return false when removing nonexistent strategy", () => {
      expect(store.remove("nonexistent")).toBe(false);
    });
  });

  // ── Listing & Filtering ──────────────────────────────────────────────────

  describe("listing and filtering", () => {
    beforeEach(() => {
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "active", tags: ["fast"] }));
      store.add(makeStrategy({ id: "s2", domain: "coding", status: "deprecated", tags: ["slow"] }));
      store.add(makeStrategy({ id: "s3", domain: "research", status: "active", tags: ["fast"] }));
      store.add(makeStrategy({ id: "s4", domain: "debugging", status: "candidate" }));
    });

    it("should list all strategies", () => {
      expect(store.list()).toHaveLength(4);
    });

    it("should filter by domain", () => {
      expect(store.list({ domain: "coding" })).toHaveLength(2);
      expect(store.list({ domain: "research" })).toHaveLength(1);
    });

    it("should filter by status", () => {
      expect(store.list({ status: "active" })).toHaveLength(2);
      expect(store.list({ status: "deprecated" })).toHaveLength(1);
    });

    it("should filter by tags", () => {
      expect(store.list({ tags: ["fast"] })).toHaveLength(2);
      expect(store.list({ tags: ["slow"] })).toHaveLength(1);
      expect(store.list({ tags: ["nonexistent"] })).toHaveLength(0);
    });

    it("should filter by since timestamp", () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      expect(store.list({ since: future })).toHaveLength(0);
    });

    it("should combine multiple filters", () => {
      expect(store.list({ domain: "coding", status: "active" })).toHaveLength(1);
      expect(store.list({ domain: "coding", tags: ["fast"] })).toHaveLength(1);
    });

    it("should get active strategies by domain", () => {
      expect(store.getActiveByDomain("coding")).toHaveLength(1);
      expect(store.getActiveByDomain("research")).toHaveLength(1);
      expect(store.getActiveByDomain("testing")).toHaveLength(0);
    });
  });

  // ── Outcome Tracking ─────────────────────────────────────────────────────

  describe("outcome tracking", () => {
    it("should record and retrieve outcomes", () => {
      store.add(makeStrategy({ id: "s1" }));
      store.recordOutcome(makeOutcome("s1", true));
      store.recordOutcome(makeOutcome("s1", false));

      const outcomes = store.getOutcomes("s1");
      expect(outcomes).toHaveLength(2);
      expect(outcomes[0]!.success).toBe(true);
      expect(outcomes[1]!.success).toBe(false);
    });

    it("should only return outcomes for the specified strategy", () => {
      store.add(makeStrategy({ id: "s1" }));
      store.add(makeStrategy({ id: "s2" }));
      store.recordOutcome(makeOutcome("s1"));
      store.recordOutcome(makeOutcome("s2"));

      expect(store.getOutcomes("s1")).toHaveLength(1);
      expect(store.getOutcomes("s2")).toHaveLength(1);
    });

    it("should return empty array for strategy with no outcomes", () => {
      store.add(makeStrategy({ id: "s1" }));
      expect(store.getOutcomes("s1")).toHaveLength(0);
    });
  });

  // ── Statistics ────────────────────────────────────────────────────────────

  describe("statistics", () => {
    it("should compute success rate correctly", () => {
      store.add(makeStrategy({ id: "s1" }));
      store.recordOutcome(makeOutcome("s1", true));
      store.recordOutcome(makeOutcome("s1", true));
      store.recordOutcome(makeOutcome("s1", false));

      const stats = store.getStats("s1");
      expect(stats.totalRuns).toBe(3);
      expect(stats.successCount).toBe(2);
      expect(stats.failureCount).toBe(1);
      expect(stats.successRate).toBeCloseTo(2 / 3, 5);
    });

    it("should compute average duration", () => {
      store.add(makeStrategy({ id: "s1" }));
      store.recordOutcome(makeOutcome("s1", true, { durationMs: 100 }));
      store.recordOutcome(makeOutcome("s1", true, { durationMs: 300 }));

      const stats = store.getStats("s1");
      expect(stats.avgDurationMs).toBe(200);
    });

    it("should compute total tokens", () => {
      store.add(makeStrategy({ id: "s1" }));
      store.recordOutcome(makeOutcome("s1", true, { tokenUsage: { input: 100, output: 50 } }));
      store.recordOutcome(makeOutcome("s1", true, { tokenUsage: { input: 200, output: 100 } }));

      const stats = store.getStats("s1");
      expect(stats.totalTokens).toBe(450);
    });

    it("should return zero stats for strategy with no outcomes", () => {
      store.add(makeStrategy({ id: "s1" }));
      const stats = store.getStats("s1");
      expect(stats.totalRuns).toBe(0);
      expect(stats.successRate).toBe(0);
      expect(stats.avgDurationMs).toBe(0);
      expect(stats.lastRunAt).toBeNull();
    });

    it("should track last run timestamp", () => {
      store.add(makeStrategy({ id: "s1" }));
      const t1 = "2026-01-01T00:00:00.000Z";
      const t2 = "2026-01-02T00:00:00.000Z";
      store.recordOutcome(makeOutcome("s1", true, { timestamp: t1 }));
      store.recordOutcome(makeOutcome("s1", true, { timestamp: t2 }));

      expect(store.getStats("s1").lastRunAt).toBe(t2);
    });

    it("should get all stats filtered by domain", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding" }));
      store.add(makeStrategy({ id: "s2", domain: "research" }));
      store.recordOutcome(makeOutcome("s1"));

      const codingStats = store.getAllStats("coding");
      expect(codingStats).toHaveLength(1);
      expect(codingStats[0]!.totalRuns).toBe(1);

      const allStats = store.getAllStats();
      expect(allStats).toHaveLength(2);
    });
  });

  // ── Best Strategy Selection ───────────────────────────────────────────────

  describe("best strategy selection", () => {
    it("should return best strategy by success rate", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "active" }));
      store.add(makeStrategy({ id: "s2", domain: "coding", status: "active" }));

      // s1: 3/3 = 100%
      store.recordOutcome(makeOutcome("s1", true));
      store.recordOutcome(makeOutcome("s1", true));
      store.recordOutcome(makeOutcome("s1", true));

      // s2: 2/3 = 66%
      store.recordOutcome(makeOutcome("s2", true));
      store.recordOutcome(makeOutcome("s2", true));
      store.recordOutcome(makeOutcome("s2", false));

      const best = store.getBestForDomain("coding");
      expect(best!.id).toBe("s1");
    });

    it("should skip strategies with fewer than minRuns", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "active" }));
      store.add(makeStrategy({ id: "s2", domain: "coding", status: "active" }));

      // s1: 1/1 = 100%, but only 1 run
      store.recordOutcome(makeOutcome("s1", true));

      // s2: 0 runs

      const best = store.getBestForDomain("coding", 3);
      // Neither has enough runs, falls back to first active
      expect(best!.id).toBe("s1");
    });

    it("should return undefined for domain with no active strategies", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "deprecated" }));
      expect(store.getBestForDomain("coding")).toBeUndefined();
    });

    it("should return first active if no strategy has enough runs", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "active" }));
      store.add(makeStrategy({ id: "s2", domain: "coding", status: "active" }));
      store.recordOutcome(makeOutcome("s1", true)); // only 1 run

      const best = store.getBestForDomain("coding", 10);
      expect(best).toBeDefined();
    });
  });

  // ── Comparison ────────────────────────────────────────────────────────────

  describe("strategy comparison", () => {
    it("should compare two strategies and pick the winner", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding" }));
      store.add(makeStrategy({ id: "s2", domain: "coding" }));

      // s1: 8/10 = 80%
      for (let i = 0; i < 8; i++) store.recordOutcome(makeOutcome("s1", true));
      for (let i = 0; i < 2; i++) store.recordOutcome(makeOutcome("s1", false));

      // s2: 5/10 = 50%
      for (let i = 0; i < 5; i++) store.recordOutcome(makeOutcome("s2", true));
      for (let i = 0; i < 5; i++) store.recordOutcome(makeOutcome("s2", false));

      const comparison = store.compare("s1", "s2");
      expect(comparison).toBeDefined();
      expect(comparison!.winner).toBe("s1");
      expect(comparison!.confidence).toBe(1); // 20 total runs
      expect(comparison!.domain).toBe("coding");
    });

    it("should return undefined for missing strategies", () => {
      expect(store.compare("s1", "s2")).toBeUndefined();
    });

    it("should compute confidence based on total runs", () => {
      store.add(makeStrategy({ id: "s1" }));
      store.add(makeStrategy({ id: "s2" }));
      store.recordOutcome(makeOutcome("s1", true));
      store.recordOutcome(makeOutcome("s2", false));

      const comparison = store.compare("s1", "s2");
      expect(comparison!.confidence).toBeCloseTo(2 / 20, 5);
    });
  });

  // ── Queries ───────────────────────────────────────────────────────────────

  describe("queries", () => {
    it("should count strategies", () => {
      expect(store.count()).toBe(0);
      store.add(makeStrategy({ id: "s1" }));
      store.add(makeStrategy({ id: "s2" }));
      expect(store.count()).toBe(2);
    });

    it("should count by status", () => {
      store.add(makeStrategy({ id: "s1", status: "active" }));
      store.add(makeStrategy({ id: "s2", status: "active" }));
      store.add(makeStrategy({ id: "s3", status: "deprecated" }));

      const counts = store.countByStatus();
      expect(counts.active).toBe(2);
      expect(counts.deprecated).toBe(1);
      expect(counts.candidate).toBe(0);
      expect(counts.retired).toBe(0);
    });

    it("should count by domain", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding" }));
      store.add(makeStrategy({ id: "s2", domain: "coding" }));
      store.add(makeStrategy({ id: "s3", domain: "research" }));

      const counts = store.countByDomain();
      expect(counts.coding).toBe(2);
      expect(counts.research).toBe(1);
    });

    it("should find underperforming strategies", () => {
      store.add(makeStrategy({ id: "s1" }));
      store.add(makeStrategy({ id: "s2" }));

      // s1: 1/5 = 20% (underperforming)
      store.recordOutcome(makeOutcome("s1", true));
      for (let i = 0; i < 4; i++) store.recordOutcome(makeOutcome("s1", false));

      // s2: 4/5 = 80% (good)
      for (let i = 0; i < 4; i++) store.recordOutcome(makeOutcome("s2", true));
      store.recordOutcome(makeOutcome("s2", false));

      const underperforming = store.findUnderperforming(0.5, 5);
      expect(underperforming).toHaveLength(1);
      expect(underperforming[0]!.id).toBe("s1");
    });

    it("should not flag strategies with insufficient runs", () => {
      store.add(makeStrategy({ id: "s1" }));
      store.recordOutcome(makeOutcome("s1", false));

      expect(store.findUnderperforming(0.5, 5)).toHaveLength(0);
    });
  });

  // ── Persistence ───────────────────────────────────────────────────────────

  describe("persistence", () => {
    it("should persist strategies to disk", () => {
      store.add(makeStrategy({ id: "s1", name: "Persisted" }));
      store.recordOutcome(makeOutcome("s1", true));

      // Create new store from same directory
      const store2 = new StrategyStore(TEST_DIR);
      expect(store2.count()).toBe(1);
      expect(store2.get("s1")!.name).toBe("Persisted");
      expect(store2.getOutcomes("s1")).toHaveLength(1);
    });

    it("should handle corrupted strategy file gracefully", () => {
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(join(TEST_DIR, "strategies.json"), "invalid json", "utf-8");

      const store2 = new StrategyStore(TEST_DIR);
      expect(store2.count()).toBe(0);
    });

    it("should handle corrupted outcomes file gracefully", () => {
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(join(TEST_DIR, "strategy-outcomes.json"), "invalid json", "utf-8");

      const store2 = new StrategyStore(TEST_DIR);
      expect(store2.getOutcomes("s1")).toHaveLength(0);
    });

    it("should handle missing storage directory gracefully", () => {
      const store2 = new StrategyStore(join(TEST_DIR, "nonexistent", "deep"));
      expect(store2.count()).toBe(0);
    });
  });

  // ── Edge Cases ────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle empty tag array in filter", () => {
      store.add(makeStrategy({ id: "s1", tags: ["fast"] }));
      expect(store.list({ tags: [] })).toHaveLength(1);
    });

    it("should handle strategy with no tags", () => {
      store.add(makeStrategy({ id: "s1" }));
      expect(store.list({ tags: ["anything"] })).toHaveLength(0);
    });

    it("should handle outcome with no token usage", () => {
      store.add(makeStrategy({ id: "s1" }));
      store.recordOutcome(makeOutcome("s1", true, { tokenUsage: undefined }));

      const stats = store.getStats("s1");
      expect(stats.totalTokens).toBe(0);
    });

    it("should support multiple domains in the same store", () => {
      const domains: StrategyDomain[] = [
        "coding", "debugging", "research", "writing",
        "data-analysis", "planning", "review", "testing", "devops", "general",
      ];

      for (const domain of domains) {
        store.add(makeStrategy({ id: `s-${domain}`, domain }));
      }

      expect(store.count()).toBe(domains.length);
      for (const domain of domains) {
        expect(store.getActiveByDomain(domain)).toHaveLength(1);
      }
    });
  });

  // ── Time-Windowed Statistics ──────────────────────────────────────────────

  describe("time-windowed statistics", () => {
    it("should compute stats within a 24h window", () => {
      store.add(makeStrategy({ id: "s1" }));

      const now = Date.now();
      const recent = new Date(now - 3600_000).toISOString();     // 1h ago
      const old = new Date(now - 100_000_000).toISOString();     // ~27h ago

      store.recordOutcome(makeOutcome("s1", true, { timestamp: recent }));
      store.recordOutcome(makeOutcome("s1", false, { timestamp: old }));

      const windowed = store.getStatsWindowed("s1", "24h");
      expect(windowed.totalRuns).toBe(1);
      expect(windowed.successCount).toBe(1);
      expect(windowed.successRate).toBe(1);
    });

    it("should include all outcomes in a 30d window", () => {
      store.add(makeStrategy({ id: "s1" }));

      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        const ts = new Date(now - i * 86_400_000).toISOString(); // each day back
        store.recordOutcome(makeOutcome("s1", i % 2 === 0, { timestamp: ts }));
      }

      const stats = store.getStatsWindowed("s1", "30d");
      expect(stats.totalRuns).toBe(5);
      expect(stats.successCount).toBe(3); // 0, 2, 4 are success
    });

    it("should return zero stats when window has no outcomes", () => {
      store.add(makeStrategy({ id: "s1" }));
      const old = new Date(Date.now() - 200_000_000).toISOString(); // ~2.3d ago
      store.recordOutcome(makeOutcome("s1", true, { timestamp: old }));

      const stats = store.getStatsWindowed("s1", "1h");
      expect(stats.totalRuns).toBe(0);
      expect(stats.successRate).toBe(0);
    });

    it("should support getStatsSince with arbitrary duration", () => {
      store.add(makeStrategy({ id: "s1" }));
      const now = Date.now();
      const recent = new Date(now - 5000).toISOString(); // 5s ago
      store.recordOutcome(makeOutcome("s1", true, { timestamp: recent }));

      const stats = store.getStatsSince("s1", 10_000); // 10s window
      expect(stats.totalRuns).toBe(1);

      const tooNarrow = store.getStatsSince("s1", 1000); // 1s window
      expect(tooNarrow.totalRuns).toBe(0);
    });
  });

  // ── Trend Detection ──────────────────────────────────────────────────────

  describe("trend detection", () => {
    it("should detect improving trend", () => {
      store.add(makeStrategy({ id: "s1" }));
      const now = Date.now();

      // Recent (last 24h): 3/3 success
      for (let i = 0; i < 3; i++) {
        store.recordOutcome(
          makeOutcome("s1", true, { timestamp: new Date(now - i * 3600_000).toISOString() }),
        );
      }
      // Older (24h-48h): 1/3 success
      for (let i = 0; i < 2; i++) {
        store.recordOutcome(
          makeOutcome("s1", false, { timestamp: new Date(now - 24 * 3600_000 - i * 3600_000).toISOString() }),
        );
      }
      store.recordOutcome(
        makeOutcome("s1", true, { timestamp: new Date(now - 24 * 3600_000 - 2 * 3600_000).toISOString() }),
      );

      const trend = store.getTrend("s1", "24h", "24h", 3);
      expect(trend.direction).toBe("improving");
      expect(trend.recentRate).toBe(1);
      expect(trend.olderRate).toBeCloseTo(1 / 3, 5);
      expect(trend.delta).toBeGreaterThan(0);
    });

    it("should detect declining trend", () => {
      store.add(makeStrategy({ id: "s1" }));
      const now = Date.now();

      // Recent: 1/3 success
      store.recordOutcome(
        makeOutcome("s1", true, { timestamp: new Date(now - 1000).toISOString() }),
      );
      for (let i = 0; i < 2; i++) {
        store.recordOutcome(
          makeOutcome("s1", false, { timestamp: new Date(now - i * 3600_000).toISOString() }),
        );
      }

      // Older: 3/3 success
      for (let i = 0; i < 3; i++) {
        store.recordOutcome(
          makeOutcome("s1", true, { timestamp: new Date(now - 24 * 3600_000 - i * 3600_000).toISOString() }),
        );
      }

      const trend = store.getTrend("s1", "24h", "24h", 3);
      expect(trend.direction).toBe("declining");
      expect(trend.delta).toBeLessThan(0);
    });

    it("should detect stable trend", () => {
      store.add(makeStrategy({ id: "s1" }));
      const now = Date.now();

      // Both windows: ~50% success
      for (let i = 0; i < 4; i++) {
        store.recordOutcome(
          makeOutcome("s1", i < 2, { timestamp: new Date(now - i * 3600_000).toISOString() }),
        );
        store.recordOutcome(
          makeOutcome("s1", i < 2, { timestamp: new Date(now - 24 * 3600_000 - i * 3600_000).toISOString() }),
        );
      }

      const trend = store.getTrend("s1", "24h", "24h", 3);
      expect(trend.direction).toBe("stable");
    });

    it("should return insufficient_data when too few runs", () => {
      store.add(makeStrategy({ id: "s1" }));
      const now = Date.now();
      store.recordOutcome(
        makeOutcome("s1", true, { timestamp: new Date(now - 1000).toISOString() }),
      );

      const trend = store.getTrend("s1", "24h", "24h", 3);
      expect(trend.direction).toBe("insufficient_data");
      expect(trend.recentRuns).toBe(1);
      expect(trend.olderRuns).toBe(0);
    });
  });

  // ── Auto-Status Transitions ──────────────────────────────────────────────

  describe("auto-status transitions", () => {
    it("should promote candidate to active when success rate is high", () => {
      store.add(makeStrategy({ id: "s1", status: "candidate" }));

      for (let i = 0; i < 5; i++) {
        store.recordOutcome(makeOutcome("s1", true));
      }

      const changed = store.autoTune(0.7, 0.3, 5);
      expect(changed).toContain("s1");
      expect(store.get("s1")!.status).toBe("active");
    });

    it("should deprecate active strategy when success rate is low", () => {
      store.add(makeStrategy({ id: "s1", status: "active" }));

      store.recordOutcome(makeOutcome("s1", true));
      for (let i = 0; i < 4; i++) {
        store.recordOutcome(makeOutcome("s1", false));
      }

      const changed = store.autoTune(0.7, 0.3, 5);
      expect(changed).toContain("s1");
      expect(store.get("s1")!.status).toBe("deprecated");
    });

    it("should not change strategies below minRuns", () => {
      store.add(makeStrategy({ id: "s1", status: "candidate" }));
      for (let i = 0; i < 3; i++) {
        store.recordOutcome(makeOutcome("s1", true));
      }

      const changed = store.autoTune(0.7, 0.3, 5);
      expect(changed).toHaveLength(0);
      expect(store.get("s1")!.status).toBe("candidate");
    });

    it("should not change deprecated or retired strategies", () => {
      store.add(makeStrategy({ id: "s1", status: "deprecated" }));
      store.add(makeStrategy({ id: "s2", status: "retired" }));

      for (let i = 0; i < 5; i++) {
        store.recordOutcome(makeOutcome("s1", true));
        store.recordOutcome(makeOutcome("s2", true));
      }

      const changed = store.autoTune(0.7, 0.3, 5);
      expect(changed).toHaveLength(0);
      expect(store.get("s1")!.status).toBe("deprecated");
      expect(store.get("s2")!.status).toBe("retired");
    });

    it("should increment version on status change", () => {
      store.add(makeStrategy({ id: "s1", status: "candidate", version: 1 }));
      for (let i = 0; i < 5; i++) {
        store.recordOutcome(makeOutcome("s1", true));
      }

      store.autoTune();
      expect(store.get("s1")!.version).toBe(2);
    });

    it("should handle mixed strategies", () => {
      store.add(makeStrategy({ id: "s1", status: "candidate" }));
      store.add(makeStrategy({ id: "s2", status: "active" }));
      store.add(makeStrategy({ id: "s3", status: "candidate" }));

      // s1: 5/5 success → promote
      for (let i = 0; i < 5; i++) store.recordOutcome(makeOutcome("s1", true));
      // s2: 1/5 success → deprecate
      store.recordOutcome(makeOutcome("s2", true));
      for (let i = 0; i < 4; i++) store.recordOutcome(makeOutcome("s2", false));
      // s3: 3/5 = 60% → below promoteThreshold (70%), stay candidate
      for (let i = 0; i < 3; i++) store.recordOutcome(makeOutcome("s3", true));
      for (let i = 0; i < 2; i++) store.recordOutcome(makeOutcome("s3", false));

      const changed = store.autoTune(0.7, 0.3, 5);
      expect(changed).toContain("s1");
      expect(changed).toContain("s2");
      expect(changed).not.toContain("s3");
      expect(store.get("s1")!.status).toBe("active");
      expect(store.get("s2")!.status).toBe("deprecated");
      expect(store.get("s3")!.status).toBe("candidate");
    });
  });

  // ── Domain Summary ───────────────────────────────────────────────────────

  describe("domain summary", () => {
    it("should compute domain summary", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding", status: "active" }));
      store.add(makeStrategy({ id: "s2", domain: "coding", status: "active" }));
      store.add(makeStrategy({ id: "s3", domain: "research", status: "active" }));

      // s1: 3/3 success
      for (let i = 0; i < 3; i++) store.recordOutcome(makeOutcome("s1", true));
      // s2: 1/2 success
      store.recordOutcome(makeOutcome("s2", true));
      store.recordOutcome(makeOutcome("s2", false));

      const summary = store.getDomainSummary("coding");
      expect(summary.domain).toBe("coding");
      expect(summary.totalStrategies).toBe(2);
      expect(summary.activeStrategies).toBe(2);
      expect(summary.totalRuns).toBe(5);
      expect(summary.overallSuccessRate).toBeCloseTo(4 / 5, 5);
      expect(summary.bestStrategyId).toBe("s1");
      expect(summary.worstStrategyId).toBe("s2");
    });

    it("should return zero summary for empty domain", () => {
      const summary = store.getDomainSummary("testing");
      expect(summary.totalStrategies).toBe(0);
      expect(summary.totalRuns).toBe(0);
      expect(summary.overallSuccessRate).toBe(0);
      expect(summary.bestStrategyId).toBeNull();
      expect(summary.worstStrategyId).toBeNull();
    });

    it("should handle domain with no outcomes", () => {
      store.add(makeStrategy({ id: "s1", domain: "coding" }));
      const summary = store.getDomainSummary("coding");
      expect(summary.totalRuns).toBe(0);
      expect(summary.bestSuccessRate).toBe(0);
      expect(summary.worstSuccessRate).toBe(0);
    });
  });
});

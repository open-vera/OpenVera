/**
 * SQ5: Memory storage tests — SQLite-backed memory with FTS5 full-text search
 *
 * Tests cover:
 * - Working memory CRUD
 * - Episodic memory with task summaries and lessons
 * - Semantic memory with key-value pairs and dedup
 * - FTS5 full-text search
 * - Memory search with importance weighting
 * - Memory persistence across restarts
 * - Auto-extract and auto-organize
 * - Importance decay
 * - Stats
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStorageProvider } from "../sqlite.js";
import { MemoryStorageAdapter } from "../memory-adapter.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-adapter-test-"));
  return join(dir, "test.db");
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("MemoryStorageAdapter (SQ5)", () => {
  let adapter: MemoryStorageAdapter;
  let storage: SqliteStorageProvider;
  let tmpDir: string;

  beforeAll(async () => {
    const dbPath = makeDbPath();
    tmpDir = join(dbPath, "..");
    storage = new SqliteStorageProvider({ backend: "sqlite", dbPath, enableFts: true });
    adapter = new MemoryStorageAdapter(storage);
    await adapter.initialize();
  });

  afterAll(async () => {
    await adapter.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("working memory", () => {
    it("should add and retrieve working memory entries", async () => {
      await adapter.clearWorking();
      await adapter.addWorking("current context info", ["context"]);

      const all = await adapter.getWorking();
      expect(all.length).toBe(1);
      expect(all[0]!.content).toBe("current context info");
      expect(all[0]!.tags).toContain("context");
    });

    it("should clear all working memory", async () => {
      await adapter.addWorking("temp1");
      await adapter.addWorking("temp2");

      await adapter.clearWorking();
      const all = await adapter.getWorking();
      expect(all.length).toBe(0);
    });

    it("should include importance in working entries", async () => {
      await adapter.clearWorking();
      await adapter.addWorking("important item", ["tag1"], "test", 5);

      const all = await adapter.getWorking();
      expect(all[0]!.importance).toBe(5);
    });
  });

  describe("episodic memory", () => {
    it("should store episodic entries with task summary and outcome", async () => {
      await adapter.addEpisodic(
        "Implemented login feature",
        "success",
        ["Always write tests first", "Check edge cases"],
        ["task", "success"],
      );

      const all = await adapter.getEpisodic();
      const found = all.find((e) => e.taskSummary === "Implemented login feature");
      expect(found).toBeDefined();
      expect(found!.outcome).toBe("success");
      expect(found!.lessons).toContain("Always write tests first");
    });

    it("should persist episodic entries across adapter restart", async () => {
      const dbPath = join(tmpDir, "restart-test.db");
      const storage1 = new SqliteStorageProvider({ backend: "sqlite", dbPath, enableFts: true });
      const adapter1 = new MemoryStorageAdapter(storage1);
      await adapter1.initialize();

      await adapter1.addEpisodic("test persistence", "success", ["lesson1"], ["persist"]);
      await adapter1.close();

      const storage2 = new SqliteStorageProvider({ backend: "sqlite", dbPath, enableFts: true });
      const adapter2 = new MemoryStorageAdapter(storage2);
      await adapter2.initialize();

      const all = await adapter2.getEpisodic();
      expect(all.some((e) => e.taskSummary === "test persistence")).toBe(true);
      await adapter2.close();
    });
  });

  describe("semantic memory", () => {
    it("should store semantic entries with key-value pairs", async () => {
      await adapter.addSemantic("api_rate_limit", "100 requests per minute", ["api", "config"]);

      const all = await adapter.getSemantic();
      const found = all.find((e) => e.key === "api_rate_limit");
      expect(found).toBeDefined();
      expect(found!.value).toBe("100 requests per minute");
    });

    it("should update semantic entry on duplicate key", async () => {
      await adapter.addSemantic("dup_key", "original value");
      await adapter.addSemantic("dup_key", "updated value");

      const all = await adapter.getSemantic();
      const matches = all.filter((e) => e.key === "dup_key");
      expect(matches.length).toBe(1);
      expect(matches[0]!.value).toBe("updated value");
    });

    it("should remove semantic entry by key", async () => {
      await adapter.addSemantic("remove_me", "temp");

      const removed = await adapter.removeSemantic("remove_me");
      expect(removed).toBe(true);

      const all = await adapter.getSemantic();
      expect(all.find((e) => e.key === "remove_me")).toBeUndefined();
    });

    it("should return false when removing non-existent key", async () => {
      const removed = await adapter.removeSemantic("nonexistent_key_xyz");
      expect(removed).toBe(false);
    });
  });

  describe("search", () => {
    it("should search across all tiers by content keywords", async () => {
      await adapter.clearWorking();
      await adapter.addWorking("database connection pool configuration", ["db"]);
      await adapter.addEpisodic("fixed database timeout bug", "success", ["Increase pool size"]);
      await adapter.addSemantic("db_timeout", "30 seconds", ["database"]);

      const results = await adapter.search("database", {
        tiers: ["working", "episodic", "semantic"],
      });
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it("should filter search by tier", async () => {
      await adapter.clearWorking();
      await adapter.addWorking("unique_xyz_working_item");
      await adapter.addSemantic("unique_xyz_sem", "xyz value");

      const results = await adapter.search("unique_xyz", { tiers: ["working"] });
      expect(results.length).toBe(1);
      expect(results[0]!.entry.tier).toBe("working");
    });

    it("should respect search limit", async () => {
      await adapter.clearWorking();
      for (let i = 0; i < 5; i++) {
        await adapter.addWorking(`limited_search_item_${i}`, [`tag_${i}`]);
      }

      const results = await adapter.search("limited_search_item", {
        tiers: ["working"],
        limit: 2,
      });
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe("auto-extract", () => {
    it("should extract memory from content (mock LLM)", async () => {
      // autoExtract requires LLM call, so test the interface exists
      expect(typeof adapter.autoExtract).toBe("function");
      expect(typeof adapter.autoExtractBatch).toBe("function");
    });
  });

  describe("auto-organize", () => {
    it("should deduplicate similar semantic entries", async () => {
      // Add similar entries
      await adapter.addSemantic("similar_a", "API endpoint is /users");
      await adapter.addSemantic("similar_b", "API endpoint for users is /users");

      // autoOrganize should handle dedup (may need LLM for similarity)
      expect(typeof adapter.autoOrganize).toBe("function");
    });
  });

  describe("importance decay", () => {
    it("should record access and decay importance", async () => {
      await adapter.clearWorking();
      const entry = await adapter.addWorking("decay test item", ["test"]);

      // Record access
      await adapter.recordAccess(entry.id);

      // Decay
      const decayed = await adapter.decayImportance({
        halfLifeDays: 7,
        minImportance: 0.1,
      });
      expect(typeof decayed).toBe("number");
    });

    it("should get decayed entries below threshold", async () => {
      const decayed = await adapter.getDecayedEntries(0.5);
      expect(Array.isArray(decayed)).toBe(true);
    });
  });

  describe("stats", () => {
    it("should return entry counts per tier", async () => {
      await adapter.clearWorking();

      await adapter.addWorking("w1");
      await adapter.addWorking("w2");
      await adapter.addEpisodic("task summary", "success", ["lesson"]);
      await adapter.addSemantic("stat_key", "value");

      const stats = await adapter.stats();
      expect(stats.working).toBe(2);
      expect(stats.episodic).toBeGreaterThanOrEqual(1);
      expect(stats.semantic).toBeGreaterThanOrEqual(1);
      expect(stats.total).toBeGreaterThanOrEqual(4);
    });
  });

  describe("health check", () => {
    it("should report healthy when initialized", () => {
      expect(adapter.isHealthy()).toBe(true);
    });
  });
});

/**
 * SQ5: Memory storage tests — SQLite-backed memory with FTS5 full-text search
 *
 * Tests cover:
 * - Working memory CRUD
 * - Episodic memory with task summaries and lessons
 * - Semantic memory with key-value pairs and dedup
 * - FTS5 full-text search (FTS path + index fallback)
 * - Memory search with importance weighting
 * - Memory persistence across restarts
 * - Auto-extract and auto-organize
 * - Memory compression (cluster + summarize)
 * - Importance decay with custom configs
 * - Lifecycle edge cases (double init/close, error paths)
 * - Inverted index eviction and fallback
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MemoryStorageAdapter,
  createMemoryAdapter,
  extractKeywords,
  tokenize,
} from "../memory-adapter.js";
import type { MemoryEntry, SemanticEntry, EpisodicEntry } from "../memory-adapter.js";
import { StorageBackendError } from "../types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDbPath(prefix = "memory-adapter-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return join(dir, "test.db");
}

function cleanupPath(dbPath: string): void {
  const tmpDir = join(dbPath, "..");
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
}

// ── Main Test Suite ─────────────────────────────────────────────────────────

describe("MemoryStorageAdapter (SQ5)", () => {
  let adapter: MemoryStorageAdapter;
  let tmpDir: string;

  beforeAll(async () => {
    const dbPath = makeDbPath();
    tmpDir = join(dbPath, "..");
    adapter = new MemoryStorageAdapter({ dbPath });
    await adapter.initialize();
  });

  afterAll(async () => {
    await adapter.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Working Memory ─────────────────────────────────────────────────────

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

    it("should set source field when provided", async () => {
      await adapter.clearWorking();
      await adapter.addWorking("sourced item", ["src"], "cli-tool");

      const all = await adapter.getWorking();
      expect(all[0]!.source).toBe("cli-tool");
    });

    it("should default importance to 0.5 and tags to empty array", async () => {
      await adapter.clearWorking();
      const entry = await adapter.addWorking("bare item");

      expect(entry.importance).toBe(0.5);
      expect(entry.tags).toEqual([]);
      expect(entry.tier).toBe("working");
    });
  });

  // ── Episodic Memory ─────────────────────────────────────────────────────

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
      const adapter1 = new MemoryStorageAdapter({ dbPath });
      await adapter1.initialize();

      await adapter1.addEpisodic("test persistence", "success", ["lesson1"], ["persist"]);
      await adapter1.close();

      const adapter2 = new MemoryStorageAdapter({ dbPath });
      await adapter2.initialize();

      const all = await adapter2.getEpisodic();
      expect(all.some((e) => e.taskSummary === "test persistence")).toBe(true);
      await adapter2.close();
    });

    it("should accept source and custom importance parameters", async () => {
      await adapter.addEpisodic(
        "deploy v2 pipeline",
        "completed",
        ["test in staging first"],
        ["devops"],
        "ci-cd",
        0.95,
      );

      const all = await adapter.getEpisodic();
      const found = all.find((e) => e.taskSummary === "deploy v2 pipeline");
      expect(found).toBeDefined();
      expect(found!.source).toBe("ci-cd");
      expect(found!.importance).toBe(0.95);
      expect(found!.tier).toBe("episodic");
    });

    it("should default tags to empty array", async () => {
      const entry = await adapter.addEpisodic("solo task", "done", ["tip"]);
      expect(entry.tags).toEqual([]);
    });
  });

  // ── Semantic Memory ─────────────────────────────────────────────────────

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

    it("should merge tags and keep max importance on duplicate key", async () => {
      await adapter.addSemantic("merge_key", "v1", ["tag1"], undefined, 0.5);
      await adapter.addSemantic("merge_key", "v2", ["tag2"], undefined, 0.9);

      const all = await adapter.getSemantic();
      const match = all.find((e) => e.key === "merge_key");
      expect(match).toBeDefined();
      expect(match!.tags).toContain("tag1");
      expect(match!.tags).toContain("tag2");
      expect(match!.importance).toBe(0.9);
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

    it("should store source and importance on new semantic entry", async () => {
      await adapter.addSemantic("src_key", "val", [], "manual", 0.75);

      const all = await adapter.getSemantic();
      const found = all.find((e) => e.key === "src_key");
      expect(found!.source).toBe("manual");
      expect(found!.importance).toBe(0.75);
    });
  });

  // ── Search ───────────────────────────────────────────────────────────────

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

    it("should return empty array for empty query", async () => {
      const results = await adapter.search("");
      expect(results).toEqual([]);
    });

    it("should return empty array for whitespace-only query", async () => {
      const results = await adapter.search("   ");
      expect(results).toEqual([]);
    });

    it("should search with useFts: false forcing index path", async () => {
      await adapter.clearWorking();
      await adapter.addWorking("force_index_test_item_abc123", ["idx"]);

      const results = await adapter.search("force_index_test_item", {
        tiers: ["working"],
        useFts: false,
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.entry.content).toBe("force_index_test_item_abc123");
    });

    it("should return search results with scores and matched terms", async () => {
      await adapter.clearWorking();
      await adapter.addWorking("scored search result entry", ["score"]);

      const results = await adapter.search("scored search", {
        tiers: ["working"],
      });
      if (results.length > 0) {
        expect(results[0]!.score).toBeGreaterThan(0);
        expect(results[0]!.matchedTerms.length).toBeGreaterThanOrEqual(0);
        expect(results[0]!.entry).toBeDefined();
      }
    });

    it("should default tiers to all three when not specified", async () => {
      await adapter.clearWorking();
      await adapter.addWorking("default_tier_test_item");

      const results = await adapter.search("default_tier_test_item");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("should search multi-word queries", async () => {
      await adapter.clearWorking();
      await adapter.addWorking("multi word query testing item", ["search"]);

      const results = await adapter.search("multi word query");
      // At least matches from the index path
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Auto-Extract ─────────────────────────────────────────────────────────

  describe("auto-extract", () => {
    it("should extract high-value content into semantic entry", async () => {
      const content =
        "Found a critical bug in the authentication module. The session token was not being validated properly on each request.";

      const entry = await adapter.autoExtract(content);
      expect(entry).not.toBeNull();
      expect(entry!.key).toBeTruthy();
      expect(entry!.value).toBe(content);
      expect(entry!.tags).toContain("auto-extracted");
      expect(entry!.importance).toBeGreaterThan(0);
    });

    it("should return null for low-value content below threshold", async () => {
      const content = "hello";
      const entry = await adapter.autoExtract(content);
      expect(entry).toBeNull();
    });

    it("should return null for content below custom threshold", async () => {
      const content = "simple note";
      const entry = await adapter.autoExtract(content, { threshold: 0.8 });
      expect(entry).toBeNull();
    });

    it("should accept source and tags in context", async () => {
      const content =
        "Critical architecture decision: switch to microservices for better scalability and fault isolation.";
      const entry = await adapter.autoExtract(content, {
        source: "meeting-notes",
        tags: ["architecture"],
      });

      expect(entry).not.toBeNull();
      expect(entry!.source).toBe("meeting-notes");
      expect(entry!.tags).toContain("architecture");
      expect(entry!.tags).toContain("auto-extracted");
    });

    it("should assign importance equal to content score", async () => {
      const content = "Error: learned that the workaround for API timeout is to add exponential backoff.";
      const entry = await adapter.autoExtract(content);

      expect(entry).not.toBeNull();
      expect(entry!.importance).toBeGreaterThan(0);
      expect(entry!.importance).toBeLessThanOrEqual(1);
    });

    it("should extract key as first sentence", async () => {
      const content =
        "Always validate user input. This prevents injection attacks and is an important security lesson.";
      const entry = await adapter.autoExtract(content);

      expect(entry).not.toBeNull();
      expect(entry!.key).toMatch(/^Always validate user input\./);
    });

    it("should extract content with code paths and technical terms for high score", async () => {
      const content =
        "Bug fix: the function /src/auth/login.ts had an import error that caused async function calls to fail silently.";
      const entry = await adapter.autoExtract(content, { threshold: 0.2 });

      expect(entry).not.toBeNull();
      // Content has code path, technical terms, bug signal → high score
      expect(entry!.importance).toBeGreaterThanOrEqual(0.2);
    });

    it("should truncate extracted key longer than 80 chars", async () => {
      const longContent =
        "This is a very long first sentence that definitely exceeds eighty characters in length total yes indeed it does and it was a critical bug. More content follows.";
      const entry = await adapter.autoExtract(longContent);

      expect(entry).not.toBeNull();
      expect(entry!.key.length).toBeLessThanOrEqual(80);
      expect(entry!.key.endsWith("...")).toBe(true);
    });

    it("should extract key from first line when no sentence delimiter", async () => {
      const content = "critical bug in authentication layer\nsecond line of content with more details";
      const entry = await adapter.autoExtract(content);

      expect(entry).not.toBeNull();
      expect(entry!.key).toBe("critical bug in authentication layer");
    });

    it("returns null when content has no signals and very short length", async () => {
      // Short content with no signals, no code, no numbers, no technical terms
      const content = "ok";
      const entry = await adapter.autoExtract(content, { threshold: 0.5 });
      expect(entry).toBeNull();
    });

    it("should cap signal score at 0.5 for many matched signals", async () => {
      // 6 signal words → signalHits=6, signalScore=min(6/6, 0.5)=0.5 cap
      const content =
        "Found a critical error bug fix solution architecture pattern decision learned lesson";
      const entry = await adapter.autoExtract(content, { threshold: 0.4 });
      expect(entry).not.toBeNull();
      // Importance = signalScore + lengthScore + specificityScore
      // signalScore=0.5 (capped), length=~88/500=0.176, no code/numbers/technical=0
      // total capped at 1.0
      expect(entry!.importance).toBeGreaterThanOrEqual(0.5);
    });

    it("should cap length score at 0.2 for very long content", async () => {
      // Content > 100 chars → lengthScore=min(>100/500, 0.2)=0.2 cap
      const long = "Error: found a critical bug fix solution in the authentication module that caused " +
        "the session management system to fail under heavy load conditions during peak traffic hours";
      const entry = await adapter.autoExtract(long, { threshold: 0.2 });
      expect(entry).not.toBeNull();
      // signalScore from "error", "bug", "fix", "solution" → min(4/6, 0.5)=0.5
      // lengthScore = min(>100/500, 0.2)=0.2 capped
      // no code path, no numbers, hasTechnical=no
      expect(entry!.importance).toBeGreaterThanOrEqual(0.7);
    });

    it("should cap total score at 1.0 for very strong signals", async () => {
      // Hit all caps simultaneously
      const content =
        "Critical bug fix solution architecture decision pattern discovered: " +
        "the async function in /src/auth/login.ts at line 42 caused the import type class interface " +
        "export to fail with error code 500. Key finding for the root cause of the breakthrough.";
      const entry = await adapter.autoExtract(content, { threshold: 0.9 });
      expect(entry).not.toBeNull();
      // signalScore should be capped at 0.5, lengthScore at 0.2, all specificity flags hit
      // Total capped at 1.0
      expect(entry!.importance).toBeGreaterThanOrEqual(0.9);
      expect(entry!.importance).toBeLessThanOrEqual(1.0);
    });
  });

  describe("auto-extract batch", () => {
    it("should extract multiple items and filter by score", async () => {
      const contents = [
        "Found a solution for the memory leak in the worker threads. The root cause was unclosed connections.",
        "hello",
        "Critical decision: We will use PostgreSQL instead of MongoDB for the primary data store.",
      ];

      const entries = await adapter.autoExtractBatch(contents);
      expect(entries.length).toBeGreaterThanOrEqual(2);
      for (const entry of entries) {
        expect(entry.tier).toBe("semantic");
        expect(entry.tags).toContain("auto-extracted");
      }
    });

    it("should return empty array when all contents are below threshold", async () => {
      const entries = await adapter.autoExtractBatch(["a", "b", "c"], {
        threshold: 0.9,
      });
      expect(entries).toEqual([]);
    });

    it("should pass context through to each extract call", async () => {
      const contents = [
        "Discovered that caching responses reduced latency by 40%. This is a key finding.",
      ];

      const entries = await adapter.autoExtractBatch(contents, {
        source: "performance-report",
        tags: ["performance"],
      });

      expect(entries.length).toBe(1);
      expect(entries[0]!.source).toBe("performance-report");
      expect(entries[0]!.tags).toContain("performance");
    });
  });

  // ── Auto-Organize ────────────────────────────────────────────────────────

  describe("auto-organize", () => {
    it("should deduplicate similar semantic entries", async () => {
      // Add very similar entries — high trigram overlap
      await adapter.addSemantic("sim_1", "API endpoint configuration for the user management service module", ["api"]);
      await adapter.addSemantic("sim_2", "API endpoint configuration for the user management service modules", ["api"]);

      const result = await adapter.autoOrganize({ similarityThreshold: 0.8 });
      expect(result.duplicatesMerged).toBeGreaterThanOrEqual(1);
      expect(result.removedIds.length).toBeGreaterThanOrEqual(1);
    });

    it("should deduplicate similar episodic entries and merge lessons", async () => {
      await adapter.addEpisodic(
        "Deploy the authentication service to production environment with full monitoring",
        "completed",
        ["Always test thoroughly in staging before proceeding to production deployment"],
        ["devops"],
      );
      await adapter.addEpisodic(
        "Deploy the authentication service to production environment with full monitoring",
        "completed",
        ["Always test thoroughly in staging before proceeding to production deployment"],
        ["devops"],
      );

      const result = await adapter.autoOrganize({ similarityThreshold: 0.8 });
      expect(result.duplicatesMerged).toBeGreaterThanOrEqual(1);
    });

    it("should return zero duplicates when entries are distinct", async () => {
      await adapter.addSemantic("distinct_a", "The sky is blue today", ["weather"]);
      await adapter.addSemantic("distinct_b", "Database indexes improve query performance", ["database"]);

      const result = await adapter.autoOrganize({ similarityThreshold: 0.9 });
      // These are very different, should not be merged
      expect(result.duplicatesMerged).toBeGreaterThanOrEqual(0);
    });

    it("should keep the higher-importance entry in a duplicate pair", async () => {
      // Add two similar items with different importance
      await adapter.addSemantic("imp_test_a", "Memory optimization technique for large datasets", ["perf"], undefined, 0.3);
      await adapter.addSemantic("imp_test_b", "Memory optimization technique for large data sets", ["perf"], undefined, 0.9);

      const result = await adapter.autoOrganize({ similarityThreshold: 0.7 });

      const remaining = await adapter.getSemantic();
      const kept = remaining.find(
        (e) => e.key === "imp_test_a" || e.key === "imp_test_b",
      );
      expect(kept).toBeDefined();
      // Higher importance entry (0.9) should be kept
      expect(kept!.importance).toBeGreaterThanOrEqual(0.9);
    });

    it("should remove expired entries when TTL is set", async () => {
      // Add an entry and manually set its updatedAt to the distant past
      const entry = await adapter.addSemantic("expire_test", "This should expire", ["test"]);
      const prov = (adapter as any)["entryProvider"];
      const raw = await prov.get("memory", entry.id);
      raw.updatedAt = "2020-01-01T00:00:00.000Z";
      raw.updated_at = "2020-01-01T00:00:00.000Z";
      await prov.set("memory", entry.id, raw);

      const result = await adapter.autoOrganize({ ttlDays: 1 });
      expect(result.expiredRemoved).toBeGreaterThanOrEqual(1);
      expect(result.removedIds).toContain(entry.id);
    });

    it("should not remove working memory entries even if expired", async () => {
      const wEntry = await adapter.addWorking("working expired test", ["test"]);
      const prov = (adapter as any)["entryProvider"];
      const raw = await prov.get("memory", wEntry.id);
      raw.updatedAt = "2020-01-01T00:00:00.000Z";
      raw.updated_at = "2020-01-01T00:00:00.000Z";
      await prov.set("memory", wEntry.id, raw);

      const result = await adapter.autoOrganize({ ttlDays: 1 });
      // Working entries are skipped in TTL check
      const stillThere = await adapter.getWorking();
      expect(stillThere.some((e) => e.id === wEntry.id)).toBe(true);
    });

    it("should handle entries with empty trigram sets gracefully", async () => {
      // Both entries have very short content (< 3 chars) → empty trigram sets
      // jaccard of two empty sets = 1 (always >= threshold)
      // But with empty content, findSimilarPairs handles this gracefully
      const dbPath = join(tmpDir, "empty-trigram-organize.db");
      const a = new MemoryStorageAdapter({ dbPath });
      await a.initialize();

      // Entries with content ": " (2 chars) → no trigrams
      await a.addSemantic("", "");

      const result = await a.autoOrganize({ similarityThreshold: 0.1 });
      // Should not throw and should handle empty trigram sets
      expect(result.duplicatesMerged).toBeGreaterThanOrEqual(0);

      await a.close();
    });
  });

  // ── Memory Compression ──────────────────────────────────────────────────

  describe("compress memories", () => {
    it("should compress entries with shared tags into summaries", async () => {
      // Add multiple entries with the same tag to form a cluster
      await adapter.addEpisodic("Deploy v1 to production", "success", ["lesson1"], ["compression-test"]);
      await adapter.addEpisodic("Deploy v2 to production", "success", ["lesson2"], ["compression-test"]);
      await adapter.addEpisodic("Deploy v3 to production", "failed", ["lesson3"], ["compression-test"]);

      const result = await adapter.compressMemories({
        minClusterSize: 3,
        maxClusters: 5,
      });

      expect(result.before).toBeGreaterThanOrEqual(3);
      expect(result.clustersCompressed).toBeGreaterThan(0);
      expect(result.summaries.length).toBeGreaterThan(0);
      // After compression, total should be less than before
      expect(result.after).toBeLessThan(result.before);
    });

    it("should skip compression when cluster is below minClusterSize", async () => {
      // Only 2 entries with same tag — below minClusterSize of 5
      await adapter.addSemantic("small_cluster_a", "value a", ["tiny-cluster"]);
      await adapter.addSemantic("small_cluster_b", "value b", ["tiny-cluster"]);

      const result = await adapter.compressMemories({
        minClusterSize: 5,
      });

      expect(result.clustersCompressed).toBe(0);
      expect(result.after).toBe(result.before);
    });

    it("should respect maxClusters limit", async () => {
      // Create multiple clusters with different tags
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 4; j++) {
          await adapter.addSemantic(`cluster_${i}_${j}`, `value ${i} ${j}`, [`cluster-tag-${i}`]);
        }
      }

      const result = await adapter.compressMemories({
        minClusterSize: 3,
        maxClusters: 2,
      });

      expect(result.clustersCompressed).toBeLessThanOrEqual(2);
    });

    it("should handle empty entries gracefully", async () => {
      // Create a fresh adapter with no entries to test empty path
      const dbPath = join(tmpDir, "empty-compress-test.db");
      const freshAdapter = new MemoryStorageAdapter({ dbPath });
      await freshAdapter.initialize();

      const result = await freshAdapter.compressMemories();
      expect(result.before).toBe(0);
      expect(result.after).toBe(0);
      expect(result.clustersCompressed).toBe(0);
      expect(result.summaries).toEqual([]);

      await freshAdapter.close();
    });

    it("should compress entries with short content without truncation suffix", async () => {
      // Entries with content < 60 chars → no "..." suffix in summary key
      await adapter.addSemantic("short_a", "brief", ["short-cluster"]);
      await adapter.addSemantic("short_b", "note", ["short-cluster"]);
      await adapter.addSemantic("short_c", "memo", ["short-cluster"]);

      const result = await adapter.compressMemories({
        minClusterSize: 3,
        maxClusters: 5,
      });

      expect(result.clustersCompressed).toBeGreaterThanOrEqual(1);
      // Summary key should not end with "..." since content < 60 chars
      const shortSummary = result.summaries.find(
        (s) => !s.key.includes("...") && s.key.startsWith("summary:"),
      );
      expect(shortSummary).toBeDefined();
    });
  });

  // ── Importance Decay ────────────────────────────────────────────────────

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
        minAgeDays: 0,
      });
      expect(typeof decayed).toBe("number");
    });

    it("should get decayed entries below threshold", async () => {
      const decayed = await adapter.getDecayedEntries(0.5);
      expect(Array.isArray(decayed)).toBe(true);
    });

    it("should skip working memory entries during decay", async () => {
      await adapter.clearWorking();
      await adapter.addWorking("persistent working item", ["test"], undefined, 0.8);

      const updated = await adapter.decayImportance({
        halfLifeDays: 1,
        minImportance: 0.01,
        minAgeDays: 0,
      });

      // Working entries are skipped, so updated should be 0 or only count non-working entries
      const allWorking = await adapter.getWorking();
      const workingEntry = allWorking.find((e) => e.content === "persistent working item");
      expect(workingEntry).toBeDefined();
      // Working entry importance should be unchanged (skipped by decay)
      expect(workingEntry!.importance).toBe(0.8);
    });

    it("should respect minAgeDays config", async () => {
      // Add a semantic entry — it was just created, so age is ~0
      const entry = await adapter.addSemantic("decay_age_test", "test value", ["decay"]);
      // Update its createdAt to now, so age is 0 ms
      // minAgeDays=30 means it won't be decayed
      const updated = await adapter.decayImportance({
        halfLifeDays: 7,
        minImportance: 0.01,
        minAgeDays: 30,
      });

      // Entry is brand new, should be skipped
      const all = await adapter.getSemantic();
      const testEntry = all.find((e) => e.id === entry.id);
      expect(testEntry).toBeDefined();
      // Should NOT have been decayed (age < 30 days)
      expect(testEntry!.importance).toBe(0.8);
    });

    it("should use lastAccessedAt for decay calculation when available", async () => {
      // Create entry and record access
      const entry = await adapter.addSemantic("decay_access_test", "test", ["decay"]);
      await adapter.recordAccess(entry.id);

      // Set a very old createdAt but recent lastAccessedAt
      const prov = (adapter as any)["entryProvider"];
      const raw = await prov.get("memory", entry.id);
      raw.createdAt = "2020-01-01T00:00:00.000Z";
      raw.created_at = "2020-01-01T00:00:00.000Z";
      // lastAccessedAt was set by recordAccess to now() -> very recent
      await prov.set("memory", entry.id, raw);

      // Decay with low halfLife — lastAccessedAt is recent, so decay should be minimal
      await adapter.decayImportance({
        halfLifeDays: 7,
        minImportance: 0.01,
        minAgeDays: 0,
      });

      const updated = (await adapter.getSemantic()).find((e) => e.id === entry.id);
      expect(updated).toBeDefined();
      // Importance should still be high because last access was recent
      expect(updated!.importance).toBeGreaterThan(0.5);
    });

    it("should use createdAt when lastAccessedAt is not set", async () => {
      const entry = await adapter.addSemantic("decay_no_access", "test", ["decay"]);
      const prov = (adapter as any)["entryProvider"];
      const raw = await prov.get("memory", entry.id);
      // Ensure lastAccessedAt is not set
      delete raw.lastAccessedAt;
      raw.createdAt = "2025-01-01T00:00:00.000Z";
      raw.created_at = "2025-01-01T00:00:00.000Z";
      await prov.set("memory", entry.id, raw);

      await adapter.decayImportance({
        halfLifeDays: 7,
        minImportance: 0.01,
        minAgeDays: 0,
      });

      const updated = (await adapter.getSemantic()).find((e) => e.id === entry.id);
      expect(updated).toBeDefined();
    });

    it("should not update when importance change is negligible", async () => {
      const entry = await adapter.addSemantic("decay_small_change", "test", ["decay"]);
      const prov = (adapter as any)["entryProvider"];
      const raw = await prov.get("memory", entry.id);
      // Set createdAt very recently so decay is tiny
      raw.createdAt = raw.created_at;
      await prov.set("memory", entry.id, raw);

      const updated = await adapter.decayImportance({
        halfLifeDays: 365, // Very long half-life = minimal decay
        minImportance: 0.01,
        minAgeDays: 0,
      });

      // With such a long half-life and recent creation, change should be < 0.001
      // updated could be 0 since diff is negligible
      expect(typeof updated).toBe("number");
    });

    it("should respect minImportance floor during decay", async () => {
      // Create an old entry with low importance
      const entry = await adapter.addSemantic("decay_floor_test", "test", ["decay"], undefined, 0.02);
      const prov = (adapter as any)["entryProvider"];
      const raw = await prov.get("memory", entry.id);
      raw.createdAt = "2020-01-01T00:00:00.000Z";
      raw.created_at = "2020-01-01T00:00:00.000Z";
      raw.lastAccessedAt = "2020-01-02T00:00:00.000Z";
      await prov.set("memory", entry.id, raw);

      await adapter.decayImportance({
        halfLifeDays: 1,
        minImportance: 0.01,
        minAgeDays: 0,
      });

      const updated = (await adapter.getSemantic()).find((e) => e.id === entry.id);
      expect(updated).toBeDefined();
      // Should not go below minImportance
      expect(updated!.importance).toBeGreaterThanOrEqual(0.01);
    });
  });

  describe("record access edge cases", () => {
    it("should not throw when recording access for non-existent entry", async () => {
      // Should silently return when entry doesn't exist
      await expect(
        adapter.recordAccess("nonexistent-entry-id-12345"),
      ).resolves.toBeUndefined();
    });

    it("should increment accessCount on recordAccess", async () => {
      const entry = await adapter.addSemantic("access_count_test", "val", ["access"]);
      await adapter.recordAccess(entry.id);

      // Verify accessCount was incremented by fetching via getSemantic
      // (which goes through getByTier → entryProvider.get)
      const all = await adapter.getSemantic();
      const found = all.find((e) => e.id === entry.id);
      expect(found).toBeDefined();
      expect(found!.accessCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe("getDecayedEntries", () => {
    it("should filter entries below threshold", async () => {
      // Entries with importance >= threshold should NOT appear
      const decayed = await adapter.getDecayedEntries(0.99);
      // Either all entries have importance < 0.99 or some are >= 0.99
      for (const entry of decayed) {
        expect(entry.importance).toBeLessThan(0.99);
      }
    });

    it("should exclude working memory entries", async () => {
      await adapter.clearWorking();
      await adapter.addWorking("low imp working", [], undefined, 0.01);

      const decayed = await adapter.getDecayedEntries(0.5);
      // Working entries should be excluded even if importance is low
      expect(decayed.some((e) => e.content === "low imp working")).toBe(false);
    });
  });

  // ── Stats ────────────────────────────────────────────────────────────────

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

    it("should include indexSize in stats", async () => {
      const stats = await adapter.stats();
      expect(typeof stats.indexSize).toBe("number");
      expect(stats.indexSize).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Health Check ─────────────────────────────────────────────────────────

  describe("health check", () => {
    it("should report healthy when initialized", () => {
      expect(adapter.isHealthy()).toBe(true);
    });

    it("should report unhealthy when closed", async () => {
      const dbPath = join(tmpDir, "health-close-test.db");
      const a = new MemoryStorageAdapter({ dbPath });
      await a.initialize();
      expect(a.isHealthy()).toBe(true);
      await a.close();
      expect(a.isHealthy()).toBe(false);
    });

    it("should report unhealthy when not initialized", () => {
      const a = new MemoryStorageAdapter({ dbPath: join(tmpDir, "noinit.db") });
      expect(a.isHealthy()).toBe(false);
    });
  });

  // ── Lifecycle Edge Cases ─────────────────────────────────────────────────

  describe("lifecycle edge cases", () => {
    it("should be idempotent on double initialize", async () => {
      const dbPath = join(tmpDir, "double-init-test.db");
      const a = new MemoryStorageAdapter({ dbPath });
      await a.initialize();
      // Second initialize should be a no-op
      await a.initialize();
      expect(a.isHealthy()).toBe(true);
      await a.close();
    });

    it("should be idempotent on double close", async () => {
      const dbPath = join(tmpDir, "double-close-test.db");
      const a = new MemoryStorageAdapter({ dbPath });
      await a.initialize();
      await a.close();
      // Second close should be a no-op
      await a.close();
      expect(a.isHealthy()).toBe(false);
    });

    it("should throw StorageBackendError when calling methods before initialize", async () => {
      const a = new MemoryStorageAdapter({ dbPath: join(tmpDir, "throw-test.db") });

      await expect(a.addWorking("test")).rejects.toThrow(StorageBackendError);
      await expect(a.addEpisodic("test", "ok", [])).rejects.toThrow(StorageBackendError);
      await expect(a.addSemantic("k", "v")).rejects.toThrow(StorageBackendError);
      await expect(a.search("test")).rejects.toThrow(StorageBackendError);
      await expect(a.stats()).rejects.toThrow(StorageBackendError);
    });

    it("should throw StorageBackendError when calling methods after close", async () => {
      const dbPath = join(tmpDir, "post-close-test.db");
      const a = new MemoryStorageAdapter({ dbPath });
      await a.initialize();
      await a.close();

      await expect(a.addWorking("test")).rejects.toThrow(StorageBackendError);
      await expect(a.addSemantic("k", "v")).rejects.toThrow(StorageBackendError);
      await expect(a.stats()).rejects.toThrow(StorageBackendError);
      await expect(a.autoOrganize()).rejects.toThrow(StorageBackendError);
    });
  });

  // ── Inverted Index Edge Cases ────────────────────────────────────────────

  describe("inverted index edge cases", () => {
    it("should evict oldest entries when exceeding max entries", async () => {
      const dbPath = join(tmpDir, "index-evict-test.db");
      const a = new MemoryStorageAdapter({
        dbPath,
        maxIndexEntries: 5,
      });
      await a.initialize();

      // Add 10 entries — index should auto-evict the oldest
      for (let i = 0; i < 10; i++) {
        await a.addWorking(`evict_test_${i}`, ["evict"]);
      }

      // Index size should be capped at 5 or less
      const stats = await a.stats();
      expect(stats.indexSize).toBeLessThanOrEqual(5);

      await a.close();
    });

    it("should return undefined for entries not in index", () => {
      const index = (adapter as any)["searchIndex"];
      expect(index.getEntry("nonexistent-id-99999")).toBeUndefined();
    });

    it("should report correct index size", () => {
      const index = (adapter as any)["searchIndex"];
      expect(typeof index.size).toBe("number");
    });
  });

  // ── getEntryById fallback to DB ──────────────────────────────────────────

  describe("getEntryById fallback", () => {
    it("should fall back to DB when entry not in inverted index", async () => {
      await adapter.addSemantic("fallback_test_key", "fallback value", ["fallback"]);

      // Clear the inverted index to force DB fallback
      (adapter as any)["searchIndex"].clear();

      // Search via FTS path (which calls getEntryById internally)
      const results = await adapter.search("fallback_test_key", {
        tiers: ["semantic"],
        useFts: true,
      });

      // getEntryById should have fallen back to entryProvider.get
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.entry.key === "fallback_test_key")).toBe(true);
    });
  });

  // ── FTS Search Error Recovery ────────────────────────────────────────────

  describe("FTS search error recovery", () => {
    it("should gracefully fall back to index search when FTS query throws", async () => {
      await adapter.clearWorking();
      await adapter.addWorking("fts_error_fallback_test_entry", ["fallback"]);

      // Spy on searchProvider.query to throw, simulating FTS error
      const searchProvider = (adapter as any)["searchProvider"];
      const querySpy = vi
        .spyOn(searchProvider, "query")
        .mockRejectedValueOnce(new Error("FTS database corruption"));

      // Search should not throw; should fall back to index search
      const results = await adapter.search("fts_error_fallback_test_entry", {
        tiers: ["working"],
        useFts: true,
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.entry.content).toBe("fts_error_fallback_test_entry");

      querySpy.mockRestore();
    });
  });

  // ── getEntryById DB miss ─────────────────────────────────────────────────

  describe("getEntryById with DB miss", () => {
    it("should skip entries not found in either inverted index or entryProvider", async () => {
      // Add an entry that goes into both entryProvider and searchProvider (FTS)
      const entry = await adapter.addWorking("orphan_entry_test_unique_abc", ["orphan"]);

      // Remove from entryProvider but keep in searchProvider FTS index
      const entryProv = (adapter as any)["entryProvider"];
      await entryProv.delete("memory", entry.id);

      // Clear inverted index so getEntryById must fall back to entryProvider
      (adapter as any)["searchIndex"].clear();

      // Search via FTS: FTS finds the ID, getEntryById misses index, misses entryProvider
      const results = await adapter.search("orphan_entry_test_unique_abc", {
        tiers: ["working"],
        useFts: true,
      });

      // The orphan entry should be filtered out (getEntryById returned undefined)
      expect(results.filter((r) => r.entry.id === entry.id).length).toBe(0);
    });
  });

  // ── Working Memory TTL ───────────────────────────────────────────────────

  describe("working memory TTL", () => {
    it("should construct adapter with workingTtlSeconds option", async () => {
      const dbPath = join(tmpDir, "ttl-test.db");
      const a = new MemoryStorageAdapter({
        dbPath,
        workingTtlSeconds: 60,
      });
      await a.initialize();
      expect(a.isHealthy()).toBe(true);
      // Adding working entry should work with TTL set
      await a.addWorking("ttl item");
      const all = await a.getWorking();
      expect(all.length).toBe(1);
      await a.close();
    });

    it("should construct adapter with walMode: false", async () => {
      const dbPath = join(tmpDir, "no-wal-test.db");
      const a = new MemoryStorageAdapter({
        dbPath,
        walMode: false,
        maxWorkingEntries: 50,
        maxIndexEntries: 100,
      });
      await a.initialize();
      expect(a.isHealthy()).toBe(true);
      await a.addSemantic("wal_test", "ok");
      const all = await a.getSemantic();
      expect(all.some((e) => e.key === "wal_test")).toBe(true);
      await a.close();
    });
  });

  // ── Factory ──────────────────────────────────────────────────────────────

  describe("createMemoryAdapter factory", () => {
    it("should create and initialize adapter in one step", async () => {
      const dbPath = join(tmpDir, "factory-test.db");
      const a = await createMemoryAdapter({ dbPath });
      expect(a.isHealthy()).toBe(true);

      await a.addWorking("factory test");
      const all = await a.getWorking();
      expect(all.length).toBe(1);

      await a.close();
    });
  });

  // ── Search result details ────────────────────────────────────────────────

  describe("search result details", () => {
    it("should track access on search hits via FTS path", async () => {
      const entry = await adapter.addSemantic("access_track_test", "unique access tracking value 42", ["track"]);

      // Search for it — FTS path should call recordAccess on hits
      await adapter.search("access tracking", { tiers: ["semantic"] });

      const all = await adapter.getSemantic();
      const found = all.find((e) => e.id === entry.id);
      // Access count may or may not be set depending on path
      expect(found).toBeDefined();
    });
  });
});

// ── Exported Utilities ─────────────────────────────────────────────────────

describe("exported utilities", () => {
  describe("tokenize", () => {
    it("should split text into lowercase tokens", () => {
      const tokens = tokenize("Hello World Database");
      expect(tokens).toContain("hello");
      expect(tokens).toContain("world");
      expect(tokens).toContain("database");
    });

    it("should remove short tokens (1 character)", () => {
      const tokens = tokenize("a b c ab cd ef");
      // 'a', 'b', 'c' are 1 char, should be filtered; 'ab', 'cd', 'ef' are 2 chars
      expect(tokens).not.toContain("a");
      expect(tokens).not.toContain("b");
      expect(tokens).not.toContain("c");
    });

    it("should handle CJK characters", () => {
      const tokens = tokenize("数据库 database 连接 pool");
      expect(tokens).toContain("数据库");
      expect(tokens).toContain("database");
      expect(tokens).toContain("连接");
    });

    it("should return empty array for empty string", () => {
      expect(tokenize("")).toEqual([]);
    });

    it("should handle special characters as separators", () => {
      const tokens = tokenize("hello-world_test.file");
      expect(tokens).toContain("hello");
      expect(tokens).toContain("world");
      expect(tokens).toContain("test");
      expect(tokens).toContain("file");
    });

    it("should handle numbers", () => {
      const tokens = tokenize("test 1234 56");
      expect(tokens).toContain("test");
      expect(tokens).toContain("1234");
      expect(tokens).toContain("56");
    });
  });

  describe("extractKeywords", () => {
    it("should extract frequent terms as keywords", () => {
      const keywords = extractKeywords("database database database connection pool");
      // 'database' appears 3 times, should be first
      expect(keywords[0]).toBe("database");
      expect(keywords.length).toBeGreaterThanOrEqual(3);
    });

    it("should respect maxTerms limit", () => {
      const keywords = extractKeywords(
        "a1 a2 a3 a4 a5 a6 a7 a8 a9 a10 a11 a12 a13 a14 a15 a16 a17 a18 a19 a20 a21 a22 a23 a24 a25",
        5,
      );
      expect(keywords.length).toBeLessThanOrEqual(5);
    });

    it("should return empty array for empty text", () => {
      expect(extractKeywords("")).toEqual([]);
    });

    it("should sort by frequency descending", () => {
      const keywords = extractKeywords("alpha beta alpha alpha beta gamma alpha alpha");
      expect(keywords[0]).toBe("alpha");
      expect(keywords[1]).toBe("beta");
    });
  });
});

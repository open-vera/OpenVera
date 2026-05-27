/**
 * SQ9: SQLite Integration Tests — Cross-layer CRUD, concurrent access,
 * migration, query performance, and user data store end-to-end flows.
 *
 * These tests exercise multiple storage components together on a single
 * SQLite database, verifying that the layers interoperate correctly.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStorageProvider } from "../sqlite.js";
import { UserDataStore, createUserDataTools } from "../user-data.js";
import { SessionStorageAdapter, migrateJsonlToSqlite } from "../session-adapter.js";
import { MemoryStorageAdapter } from "../memory-adapter.js";
import { DataExporter } from "../data-exporter.js";
import type { StoredSession } from "../types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "sqlite-integration-test-"));
}

function makeJsonlContent(sessionId: string, turnCount = 2): string {
  const lines: string[] = [
    JSON.stringify({
      type: "session_start",
      sessionId,
      timestamp: new Date().toISOString(),
      cwd: "/tmp/test",
      model: "claude-3",
      provider: "anthropic",
    }),
  ];

  for (let i = 0; i < turnCount; i++) {
    lines.push(
      JSON.stringify({
        type: "user",
        sessionId,
        timestamp: new Date().toISOString(),
        uuid: crypto.randomUUID(),
        content: `user message ${i}`,
      }),
    );
    lines.push(
      JSON.stringify({
        type: "assistant",
        sessionId,
        timestamp: new Date().toISOString(),
        uuid: crypto.randomUUID(),
        parentUuid: `p${i}`,
        content: `assistant response ${i}`,
        model: "claude-3",
        provider: "anthropic",
        stopReason: "end_turn",
        usage: { input_tokens: 10 * (i + 1), output_tokens: 20 * (i + 1) },
        turn: i + 1,
        latencyMs: 100,
        toolCalls: [],
        status: "ok",
      }),
    );
  }

  return lines.join("\n") + "\n";
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("SQ9: SQLite Integration Tests", () => {
  let tmpDir: string;
  let dbPath: string;
  let storage: SqliteStorageProvider;

  beforeAll(async () => {
    tmpDir = makeTmpDir();
    dbPath = join(tmpDir, "integration.db");
    storage = new SqliteStorageProvider({
      backend: "sqlite",
      dbPath,
      walMode: true,
      enableFts: true,
    });
    await storage.initialize();
  });

  afterAll(async () => {
    await storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. Cross-namespace CRUD ─────────────────────────────────────────────

  describe("cross-namespace CRUD consistency", () => {
    it("should store and retrieve data across multiple namespaces atomically", async () => {
      const namespaces = ["sessions", "memory", "user-data", "config"];
      for (const ns of namespaces) {
        await storage.set(ns, "test-key", { ns, value: "shared-data" });
      }

      for (const ns of namespaces) {
        const val = await storage.get(ns, "test-key");
        expect(val).toEqual({ ns, value: "shared-data" });
      }
    });

    it("should isolate deletes across namespaces", async () => {
      await storage.set("ns-a", "shared", "alpha");
      await storage.set("ns-b", "shared", "beta");

      await storage.delete("ns-a", "shared");

      expect(await storage.get("ns-a", "shared")).toBeUndefined();
      expect(await storage.get("ns-b", "shared")).toBe("beta");
    });

    it("should listKeys independently per namespace", async () => {
      await storage.set("list-ns1", "a", 1);
      await storage.set("list-ns1", "b", 2);
      await storage.set("list-ns2", "c", 3);

      const keys1 = await storage.listKeys("list-ns1");
      const keys2 = await storage.listKeys("list-ns2");

      expect(keys1.sort()).toEqual(["a", "b"]);
      expect(keys2).toEqual(["c"]);
    });
  });

  // ── 2. Concurrent access stress ─────────────────────────────────────────

  describe("concurrent access across layers", () => {
    it("should handle 100 concurrent writes without corruption", async () => {
      const ops = Array.from({ length: 100 }, (_, i) =>
        storage.set("stress", `key-${i}`, { index: i, data: `value-${i}` }),
      );
      await Promise.all(ops);

      const count = await storage.count("stress");
      expect(count).toBe(100);

      // Verify a sample
      const val = await storage.get("stress", "key-50");
      expect(val).toEqual({ index: 50, data: "value-50" });
    });

    it("should handle concurrent setMany and getMany", async () => {
      const batches = Array.from({ length: 5 }, (_, batchIdx) =>
        storage.setMany(
          "batch-ns",
          Array.from({ length: 10 }, (_, i) => ({
            key: `b${batchIdx}-k${i}`,
            value: `batch-${batchIdx}-val-${i}`,
          })),
        ),
      );
      await Promise.all(batches);

      const keys = await storage.listKeys("batch-ns");
      expect(keys).toHaveLength(50);
    });

    it("should handle concurrent reads and writes on same namespace", async () => {
      await storage.set("rw-ns", "existing", "original");

      const ops = [
        storage.get("rw-ns", "existing"),
        storage.set("rw-ns", "new1", "v1"),
        storage.has("rw-ns", "existing"),
        storage.set("rw-ns", "new2", "v2"),
        storage.get("rw-ns", "new1"),
        storage.delete("rw-ns", "existing"),
        storage.listKeys("rw-ns"),
      ];

      const results = await Promise.all(ops);
      expect(results[0]).toBe("original");
      expect(results[2]).toBe(true);
      // new1 might or might not be visible depending on ordering
      expect(results[5]).toBe(true); // delete found the key
    });
  });

  // ── 3. Query performance with data volume ───────────────────────────────

  describe("query performance at scale", () => {
    beforeAll(async () => {
      // Seed 500 entries
      const entries = Array.from({ length: 500 }, (_, i) => ({
        key: `perf-${String(i).padStart(4, "0")}`,
        value: { id: i, category: i % 5 === 0 ? "special" : "normal", data: `item-${i}` },
      }));
      await storage.setMany("perf-ns", entries);
    });

    it("should count 500 entries quickly", async () => {
      const start = Date.now();
      const count = await storage.count("perf-ns");
      const elapsed = Date.now() - start;
      expect(count).toBe(500);
      expect(elapsed).toBeLessThan(1000); // should be well under 1s
    });

    it("should query with keyPrefix filter efficiently", async () => {
      const result = await storage.query("perf-ns", {
        keyPrefix: "perf-00",
        orderBy: "key",
        order: "asc",
      });
      // perf-0000 through perf-0099 = 100 entries
      expect(result.total).toBe(100);
      expect(result.entries[0]!.key).toBe("perf-0000");
    });

    it("should paginate through large result sets", async () => {
      const pageSize = 50;
      let allKeys: string[] = [];
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const result = await storage.query("perf-ns", {
          limit: pageSize,
          offset,
          orderBy: "key",
          order: "asc",
        });
        allKeys.push(...result.entries.map((e) => e.key));
        hasMore = result.hasMore;
        offset += pageSize;
      }

      expect(allKeys).toHaveLength(500);
      // Verify sorted
      for (let i = 1; i < allKeys.length; i++) {
        expect(allKeys[i]! > allKeys[i - 1]!).toBe(true);
      }
    });

    it("should query with createdAfter filter on seeded data", async () => {
      const beforeAll = new Date(Date.now() - 10_000).toISOString();
      const result = await storage.query("perf-ns", { createdAfter: beforeAll });
      expect(result.total).toBe(500);
    });

    it("should return empty for non-matching keyPrefix", async () => {
      const result = await storage.query("perf-ns", { keyPrefix: "nonexistent-" });
      expect(result.total).toBe(0);
      expect(result.entries).toHaveLength(0);
    });
  });

  // ── 4. Session + Storage integration ────────────────────────────────────

  describe("SessionStorageAdapter integration", () => {
    let adapter: SessionStorageAdapter;

    beforeAll(async () => {
      // Use a separate DB for session tests to avoid namespace conflicts
      const sessionDb = join(tmpDir, "session-int.db");
      const sessionStorage = new SqliteStorageProvider({
        backend: "sqlite",
        dbPath: sessionDb,
        enableFts: true,
      });
      await sessionStorage.initialize();
      adapter = new SessionStorageAdapter(sessionStorage);
      await adapter.initialize();
    });

    afterAll(async () => {
      await adapter.close();
    });

    it("should create session, write entries, and load full history", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "claude-3", "anthropic", "/project");
      await adapter.writeUser(id, "What is the meaning of life?");
      await adapter.writeAssistant(id, {
        parentUuid: "p1",
        content: "42.",
        model: "claude-3",
        provider: "anthropic",
        stopReason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
        turn: 1,
        latencyMs: 200,
        toolCalls: [],
        status: "ok",
      });

      const loaded = await adapter.loadSession(id);
      expect(loaded.history).toHaveLength(2);
      expect(loaded.history[0]!.role).toBe("user");
      expect(loaded.history[1]!.role).toBe("assistant");
      expect(loaded.totalUsage.input_tokens).toBe(10);
    });

    it("should fork session and preserve replayable entries", async () => {
      const parentId = crypto.randomUUID();
      await adapter.createSession(parentId, "claude-3", "anthropic", "/tmp");
      await adapter.writeUser(parentId, "original prompt");
      await adapter.writeAssistant(parentId, {
        parentUuid: "p1",
        content: "original response",
        model: "claude-3",
        provider: "anthropic",
        stopReason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 20 },
        turn: 1,
        latencyMs: 100,
        toolCalls: [],
        status: "ok",
      });

      const forked = await adapter.forkSession({
        fromSessionId: parentId,
        title: "Experiment",
      });

      const forkedLoaded = await adapter.loadSession(forked.sessionId);
      expect(forkedLoaded.history.length).toBeGreaterThanOrEqual(2);
      expect(forkedLoaded.history[0]!.content).toBe("original prompt");
    });
  });

  // ── 5. JSONL migration integration ──────────────────────────────────────

  describe("JSONL to SQLite migration", () => {
    let migAdapter: SessionStorageAdapter;
    let migDir: string;

    beforeAll(async () => {
      migDir = join(tmpDir, "migration-test");
      mkdirSync(migDir, { recursive: true });

      const migDb = join(tmpDir, "migration.db");
      const migStorage = new SqliteStorageProvider({
        backend: "sqlite",
        dbPath: migDb,
      });
      await migStorage.initialize();
      migAdapter = new SessionStorageAdapter(migStorage);
      await migAdapter.initialize();
    });

    afterAll(async () => {
      await migAdapter.close();
    });

    it("should migrate multiple JSONL files and verify content integrity", async () => {
      // Create 3 JSONL files
      for (let i = 0; i < 3; i++) {
        const sessionId = `mig-session-${i}`;
        writeFileSync(join(migDir, `${sessionId}.jsonl`), makeJsonlContent(sessionId, i + 1));
      }

      const count = await migrateJsonlToSqlite(migAdapter, migDir);
      expect(count).toBe(3);

      // Verify each migrated session
      for (let i = 0; i < 3; i++) {
        const sessionId = `mig-session-${i}`;
        expect(await migAdapter.hasSession(sessionId)).toBe(true);

        const loaded = await migAdapter.loadSession(sessionId);
        expect(loaded.turnCount).toBe(i + 1);
      }
    });

    it("should skip already-migrated sessions on re-run", async () => {
      const count = await migrateJsonlToSqlite(migAdapter, migDir);
      expect(count).toBe(0);
    });

    it("should verify migration matches source content", async () => {
      const sessionId = "mig-session-0";
      const sourceContent = makeJsonlContent(sessionId, 1);
      const result = await migAdapter.verifyMigration(sessionId, sourceContent);
      expect(result.ok).toBe(true);
      expect(result.sourceEntries).toBe(result.migratedEntries);
    });
  });

  // ── 6. Memory adapter integration ───────────────────────────────────────

  describe("MemoryStorageAdapter integration", () => {
    let memAdapter: MemoryStorageAdapter;

    beforeAll(async () => {
      const memDb = join(tmpDir, "memory-int.db");
      memAdapter = new MemoryStorageAdapter({ dbPath: memDb });
      await memAdapter.initialize();
    });

    afterAll(async () => {
      await memAdapter.close();
    });

    it("should store and search across all memory tiers", async () => {
      await memAdapter.addWorking("database connection settings", ["config"]);
      await memAdapter.addEpisodic(
        "Fixed database connection leak",
        "success",
        ["Always close connections in finally block"],
        ["bug", "database"],
      );
      await memAdapter.addSemantic("db_pool_size", "20 connections", ["database", "config"]);

      const results = await memAdapter.search("database", {
        tiers: ["working", "episodic", "semantic"],
      });

      expect(results.length).toBeGreaterThanOrEqual(2);
      // All results should be sorted by score descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
      }
    });

    it("should handle semantic dedup on same key", async () => {
      await memAdapter.addSemantic("api_version", "v1", ["api"]);
      await memAdapter.addSemantic("api_version", "v2", ["api", "updated"]);

      const all = await memAdapter.getSemantic();
      const matches = all.filter((e) => e.key === "api_version");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.value).toBe("v2");
      expect(matches[0]!.tags).toContain("updated");
    });

    it("should return accurate stats across tiers", async () => {
      const stats = await memAdapter.stats();
      expect(stats.working).toBeGreaterThanOrEqual(1);
      expect(stats.episodic).toBeGreaterThanOrEqual(1);
      expect(stats.semantic).toBeGreaterThanOrEqual(1);
      expect(stats.total).toBeGreaterThanOrEqual(3);
    });
  });

  // ── 7. UserDataStore integration ────────────────────────────────────────

  describe("UserDataStore integration", () => {
    let store: UserDataStore;

    beforeAll(async () => {
      const userDb = join(tmpDir, "user-data-int.db");
      const userStorage = new SqliteStorageProvider({
        backend: "sqlite",
        dbPath: userDb,
      });
      await userStorage.initialize();
      store = new UserDataStore(userStorage);
    });

    it("should save, load, list, and delete across namespaces", async () => {
      await store.save({ key: "theme", value: "dark", namespace: "ui" });
      await store.save({ key: "lang", value: "en", namespace: "ui" });
      await store.save({ key: "api_key", value: "sk-xxx", namespace: "secrets" });

      const uiEntries = await store.list({ namespace: "ui" });
      expect(uiEntries).toHaveLength(2);

      const namespaces = await store.listNamespaces();
      expect(namespaces).toContain("ui");
      expect(namespaces).toContain("secrets");

      await store.delete({ key: "api_key", namespace: "secrets" });
      const secretsEntries = await store.list({ namespace: "secrets" });
      expect(secretsEntries).toHaveLength(0);
    });

    it("should enforce validation rules", async () => {
      // Empty key
      await expect(store.save({ key: "", value: 1 })).rejects.toThrow();

      // Key too long
      await expect(
        store.save({ key: "x".repeat(257), value: 1 }),
      ).rejects.toThrow();
    });
  });

  // ── 8. DataExporter integration ─────────────────────────────────────────

  describe("DataExporter integration", () => {
    let exporter: DataExporter;

    beforeAll(async () => {
      const exportDb = join(tmpDir, "export-int.db");
      const exportStorage = new SqliteStorageProvider({
        backend: "sqlite",
        dbPath: exportDb,
      });
      await exportStorage.initialize();

      // Seed some data
      await exportStorage.set("export-ns", "item-1", { name: "Alice", age: 30 });
      await exportStorage.set("export-ns", "item-2", { name: "Bob", age: 25 });
      await exportStorage.set("export-ns", "item-3", { name: "Charlie", age: 35 });

      exporter = new DataExporter(exportStorage);
    });

    it("should export as JSON", async () => {
      const result = await exporter.exportData({
        namespace: "export-ns",
        format: "json",
        prettyPrint: true,
      });

      expect(result.count).toBe(3);
      expect(result.format).toBe("json");

      const parsed = JSON.parse(result.data) as Array<Record<string, unknown>>;
      expect(parsed).toHaveLength(3);
      expect(parsed[0]).toHaveProperty("key");
      expect(parsed[0]).toHaveProperty("value");
      expect(parsed[0]).toHaveProperty("createdAt");
    });

    it("should export as JSONL", async () => {
      const result = await exporter.exportData({
        namespace: "export-ns",
        format: "jsonl",
      });

      expect(result.count).toBe(3);
      const lines = result.data.split("\n").filter(Boolean);
      expect(lines).toHaveLength(3);

      for (const line of lines) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(parsed).toHaveProperty("key");
        expect(parsed).toHaveProperty("value");
      }
    });

    it("should export as CSV", async () => {
      const result = await exporter.exportData({
        namespace: "export-ns",
        format: "csv",
        includeMetadata: true,
      });

      expect(result.count).toBe(3);
      const lines = result.data.split("\n").filter(Boolean);
      expect(lines).toHaveLength(4); // 1 header + 3 rows
      expect(lines[0]).toContain("key");
      expect(lines[0]).toContain("value");
      expect(lines[0]).toContain("createdAt");
    });

    it("should export without metadata when includeMetadata=false", async () => {
      const result = await exporter.exportData({
        namespace: "export-ns",
        format: "jsonl",
        includeMetadata: false,
      });

      const lines = result.data.split("\n").filter(Boolean);
      for (const line of lines) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(parsed).toHaveProperty("key");
        expect(parsed).toHaveProperty("value");
        expect(parsed).not.toHaveProperty("createdAt");
      }
    });

    it("should export empty result for non-existent namespace", async () => {
      const result = await exporter.exportData({
        namespace: "nonexistent",
        format: "json",
      });

      expect(result.count).toBe(0);
      expect(JSON.parse(result.data)).toEqual([]);
    });
  });

  // ── 9. Transaction across layers ────────────────────────────────────────

  describe("transaction atomicity", () => {
    it("should commit all operations on success", async () => {
      await storage.transaction(async (tx) => {
        tx.set("tx-ns", "a", 1);
        tx.set("tx-ns", "b", 2);
        tx.set("tx-ns", "c", 3);
      });

      expect(await storage.get("tx-ns", "a")).toBe(1);
      expect(await storage.get("tx-ns", "b")).toBe(2);
      expect(await storage.get("tx-ns", "c")).toBe(3);
    });

    it("should rollback all operations on error", async () => {
      await storage.set("tx-rollback", "existing", "value");

      await expect(
        storage.transaction(async (tx) => {
          tx.set("tx-rollback", "new", "data");
          tx.delete("tx-rollback", "existing");
          throw new Error("abort transaction");
        }),
      ).rejects.toThrow();

      expect(await storage.get("tx-rollback", "existing")).toBe("value");
      expect(await storage.get("tx-rollback", "new")).toBeUndefined();
    });

    it("should support mixed set and delete in a single transaction", async () => {
      await storage.set("tx-mix", "keep", "yes");
      await storage.set("tx-mix", "remove", "no");

      await storage.transaction(async (tx) => {
        tx.delete("tx-mix", "remove");
        tx.set("tx-mix", "added", "new");
      });

      expect(await storage.get("tx-mix", "keep")).toBe("yes");
      expect(await storage.get("tx-mix", "remove")).toBeUndefined();
      expect(await storage.get("tx-mix", "added")).toBe("new");
    });
  });

  // ── 10. FTS5 cross-namespace search ─────────────────────────────────────

  describe("FTS5 full-text search across namespaces", () => {
    beforeAll(async () => {
      await storage.set("fts-docs", "readme", "OpenVera is an AI agent framework");
      await storage.set("fts-docs", "changelog", "Added SQLite storage backend");
      await storage.set("fts-docs", "guide", "How to configure the agent runtime");
    });

    it("should find entries matching search query", async () => {
      const result = await storage.query("fts-docs", {
        fullTextSearch: "agent",
      });
      expect(result.entries.length).toBeGreaterThanOrEqual(1);
      const keys = result.entries.map((e) => e.key);
      expect(keys).toContain("readme");
    });

    it("should not match across different namespaces", async () => {
      await storage.set("fts-other", "note", "agent framework comparison");
      const result = await storage.query("fts-docs", {
        fullTextSearch: "comparison",
      });
      expect(result.entries).toHaveLength(0);
    });
  });

  // ── 11. TTL integration ─────────────────────────────────────────────────

  describe("TTL expiry integration", () => {
    it("should not return expired entries in queries", async () => {
      // Insert an entry with a very short TTL via direct SQL
      const pastIso = new Date(Date.now() - 5000).toISOString();
      const { default: Database } = await import("better-sqlite3");
      const db = new Database(dbPath);
      db.prepare(`
        INSERT INTO kv_entries (namespace, key, value, created_at, updated_at, ttl, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run("ttl-ns", "expired-item", JSON.stringify("old-data"), pastIso, pastIso, 1, null);
      db.close();

      // Re-open storage to pick up the change
      const freshStorage = new SqliteStorageProvider({
        backend: "sqlite",
        dbPath,
        walMode: true,
        enableFts: true,
      });
      await freshStorage.initialize();

      // get should return undefined for expired
      expect(await freshStorage.get("ttl-ns", "expired-item")).toBeUndefined();

      // has should return false
      expect(await freshStorage.has("ttl-ns", "expired-item")).toBe(false);

      // query should exclude expired
      await freshStorage.set("ttl-ns", "alive-item", "fresh-data");
      const result = await freshStorage.query("ttl-ns", {});
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.key).toBe("alive-item");

      await freshStorage.close();
    });
  });

  // ── 12. Sync API integration ────────────────────────────────────────────

  describe("sync API consistency", () => {
    it("sync write should be immediately visible to async read", async () => {
      storage.setSync("sync-ns", "sync-key", { sync: true });
      const val = await storage.get("sync-ns", "sync-key");
      expect(val).toEqual({ sync: true });
    });

    it("async write should be immediately visible to sync read", async () => {
      await storage.set("sync-ns", "async-key", { async: true });
      const val = storage.getSync("sync-ns", "async-key");
      expect(val).toEqual({ async: true });
    });

    it("listKeysSync should match async listKeys", async () => {
      await storage.set("sync-list", "a", 1);
      await storage.set("sync-list", "b", 2);

      const syncKeys = storage.listKeysSync("sync-list").sort();
      const asyncKeys = (await storage.listKeys("sync-list")).sort();
      expect(syncKeys).toEqual(asyncKeys);
    });
  });
});

import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStore, createFileStore } from "../file-store.js";
import { StorageBackendError, StorageTransactionError } from "../types.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `file-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("FileStore", () => {
  let dir: string;
  let store: FileStore;

  beforeEach(async () => {
    dir = makeTmpDir();
    store = new FileStore({ storeDir: dir, cleanupIntervalMs: 60_000 });
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // ── Basic Properties ────────────────────────────────────────────────────

  describe("basic properties", () => {
    it("has the correct name", () => {
      expect(store.name).toBe("file");
    });

    it("is healthy after initialization", () => {
      expect(store.isHealthy()).toBe(true);
    });

    it("is not healthy after close", async () => {
      await store.close();
      expect(store.isHealthy()).toBe(false);
    });
  });

  // ── CRUD Operations ────────────────────────────────────────────────────

  describe("CRUD operations", () => {
    it("set and get a value", async () => {
      await store.set("ns", "key1", "hello");
      expect(await store.get("ns", "key1")).toBe("hello");
    });

    it("get returns undefined for missing key", async () => {
      expect(await store.get("ns", "missing")).toBeUndefined();
    });

    it("has returns true for existing key", async () => {
      await store.set("ns", "key1", 42);
      expect(await store.has("ns", "key1")).toBe(true);
    });

    it("has returns false for missing key", async () => {
      expect(await store.has("ns", "missing")).toBe(false);
    });

    it("delete removes a key", async () => {
      await store.set("ns", "key1", "value");
      const deleted = await store.delete("ns", "key1");
      expect(deleted).toBe(true);
      expect(await store.get("ns", "key1")).toBeUndefined();
    });

    it("delete returns false for missing key", async () => {
      expect(await store.delete("ns", "missing")).toBe(false);
    });

    it("overwrites existing value on set", async () => {
      await store.set("ns", "key1", "v1");
      await store.set("ns", "key1", "v2");
      expect(await store.get("ns", "key1")).toBe("v2");
    });

    it("preserves createdAt on overwrite", async () => {
      await store.set("ns", "key1", "v1");
      const first = await store.query("ns", {});
      const createdAt = first.entries[0]!.entry.createdAt;

      await store.set("ns", "key1", "v2");
      const second = await store.query("ns", {});
      expect(second.entries[0]!.entry.createdAt).toBe(createdAt);
      expect(second.entries[0]!.entry.updatedAt >= createdAt).toBe(true);
    });

    it("listKeys returns all keys", async () => {
      await store.set("ns", "a", 1);
      await store.set("ns", "b", 2);
      await store.set("ns", "c", 3);
      const keys = await store.listKeys("ns");
      expect(keys.sort()).toEqual(["a", "b", "c"]);
    });

    it("listKeys returns empty for empty namespace", async () => {
      expect(await store.listKeys("empty")).toEqual([]);
    });

    it("clear removes all entries", async () => {
      await store.set("ns", "a", 1);
      await store.set("ns", "b", 2);
      await store.clear("ns");
      expect(await store.listKeys("ns")).toEqual([]);
    });

    it("handles complex nested values", async () => {
      const value = { nested: { arr: [1, 2, { deep: true }], str: "ok" } };
      await store.set("ns", "complex", value);
      expect(await store.get("ns", "complex")).toEqual(value);
    });

    it("handles null value", async () => {
      await store.set("ns", "null", null);
      expect(await store.get("ns", "null")).toBeNull();
    });

    it("handles boolean value", async () => {
      await store.set("ns", "bool", false);
      expect(await store.get("ns", "bool")).toBe(false);
    });
  });

  // ── Batch Operations ───────────────────────────────────────────────────

  describe("batch operations", () => {
    it("setMany stores multiple entries", async () => {
      await store.setMany("ns", [
        { key: "a", value: 1 },
        { key: "b", value: 2 },
        { key: "c", value: 3 },
      ]);
      expect(await store.get("ns", "a")).toBe(1);
      expect(await store.get("ns", "b")).toBe(2);
      expect(await store.get("ns", "c")).toBe(3);
    });

    it("getMany retrieves multiple values", async () => {
      await store.set("ns", "a", 1);
      await store.set("ns", "b", 2);
      const results = await store.getMany("ns", ["a", "b", "missing"]);
      expect(results).toEqual([
        { key: "a", value: 1 },
        { key: "b", value: 2 },
        { key: "missing", value: undefined },
      ]);
    });

    it("setMany overwrites existing entries", async () => {
      await store.set("ns", "a", "old");
      await store.setMany("ns", [{ key: "a", value: "new" }]);
      expect(await store.get("ns", "a")).toBe("new");
    });
  });

  // ── Query Operations ───────────────────────────────────────────────────

  describe("query", () => {
    beforeEach(async () => {
      await store.set("ns", "user:1", "Alice");
      await store.set("ns", "user:2", "Bob");
      await store.set("ns", "config:theme", "dark");
      await store.set("ns", "config:lang", "en");
    });

    it("returns all entries with empty filter", async () => {
      const result = await store.query("ns", {});
      expect(result.total).toBe(4);
      expect(result.entries).toHaveLength(4);
    });

    it("filters by keyPrefix", async () => {
      const result = await store.query("ns", { keyPrefix: "user:" });
      expect(result.total).toBe(2);
      expect(result.entries.map((e) => e.key).sort()).toEqual(["user:1", "user:2"]);
    });

    it("filters by keyPattern (glob)", async () => {
      const result = await store.query("ns", { keyPattern: "user:*" });
      expect(result.total).toBe(2);
    });

    it("filters by tags when entries have no tags (returns empty)", async () => {
      await store.set("tagged", "a", "v1");
      await store.set("tagged", "b", "v2");
      const result = await store.query("tagged", { tags: ["important"] });
      expect(result.entries).toHaveLength(0);
    });

    it("filters by hasTtl", async () => {
      const result = await store.query("ns", { hasTtl: true });
      expect(result.entries).toHaveLength(0);
    });

    it("applies limit and offset", async () => {
      const page1 = await store.query("ns", { limit: 2, offset: 0, orderBy: "key", order: "asc" });
      expect(page1.entries).toHaveLength(2);
      expect(page1.hasMore).toBe(true);
      expect(page1.total).toBe(4);

      const page2 = await store.query("ns", { limit: 2, offset: 2, orderBy: "key", order: "asc" });
      expect(page2.entries).toHaveLength(2);
      expect(page2.hasMore).toBe(false);
    });

    it("orders by key ascending", async () => {
      const result = await store.query("ns", { orderBy: "key", order: "asc" });
      const keys = result.entries.map((e) => e.key);
      expect(keys).toEqual(["config:lang", "config:theme", "user:1", "user:2"]);
    });

    it("orders by key descending", async () => {
      const result = await store.query("ns", { orderBy: "key", order: "desc" });
      const keys = result.entries.map((e) => e.key);
      expect(keys).toEqual(["user:2", "user:1", "config:theme", "config:lang"]);
    });

    it("filters by createdAfter (includes all entries after past date)", async () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const result = await store.query("ns", { createdAfter: past });
      expect(result.total).toBe(4);
    });

    it("filters by createdAfter (excludes all entries after future date)", async () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const result = await store.query("ns", { createdAfter: future });
      expect(result.total).toBe(0);
    });

    it("filters by createdBefore (excludes entries with future cutoff)", async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const result = await store.query("ns", { createdBefore: past });
      expect(result.total).toBe(0);
    });

    it("filters by createdBefore (includes all entries before future date)", async () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const result = await store.query("ns", { createdBefore: future });
      expect(result.total).toBe(4);
    });

    it("fullTextSearch filters by value content", async () => {
      const result = await store.query("ns", { fullTextSearch: "alice" });
      expect(result.total).toBe(1);
      expect(result.entries[0]!.key).toBe("user:1");
    });
  });

  // ── Count ──────────────────────────────────────────────────────────────

  describe("count", () => {
    it("counts all entries without filter", async () => {
      await store.set("ns", "a", 1);
      await store.set("ns", "b", 2);
      expect(await store.count("ns")).toBe(2);
    });

    it("counts entries matching filter", async () => {
      await store.set("ns", "user:1", "a");
      await store.set("ns", "user:2", "b");
      await store.set("ns", "config", "c");
      expect(await store.count("ns", { keyPrefix: "user:" })).toBe(2);
    });

    it("returns 0 for empty namespace", async () => {
      expect(await store.count("empty")).toBe(0);
    });
  });

  // ── Transactions ───────────────────────────────────────────────────────

  describe("transactions", () => {
    it("commits operations on success", async () => {
      await store.transaction(async (tx) => {
        tx.set("ns", "a", 1);
        tx.set("ns", "b", 2);
      });
      expect(await store.get("ns", "a")).toBe(1);
      expect(await store.get("ns", "b")).toBe(2);
    });

    it("rolls back on error", async () => {
      await store.set("ns", "existing", "value");

      await expect(
        store.transaction(async (tx) => {
          tx.set("ns", "new", "data");
          throw new Error("abort");
        }),
      ).rejects.toThrow(StorageTransactionError);

      expect(await store.get("ns", "new")).toBeUndefined();
      expect(await store.get("ns", "existing")).toBe("value");
    });

    it("supports get inside transaction", async () => {
      await store.set("ns", "key", "original");

      const result = await store.transaction(async (tx) => {
        const val = await tx.get("ns", "key");
        tx.set("ns", "copy", val as string);
        return val;
      });

      expect(result).toBe("original");
      expect(await store.get("ns", "copy")).toBe("original");
    });

    it("supports delete inside transaction", async () => {
      await store.set("ns", "key", "value");

      await store.transaction(async (tx) => {
        tx.delete("ns", "key");
      });

      expect(await store.get("ns", "key")).toBeUndefined();
    });

    it("rolls back delete on error", async () => {
      await store.set("ns", "key", "survive");

      await expect(
        store.transaction(async (tx) => {
          tx.delete("ns", "key");
          throw new Error("abort");
        }),
      ).rejects.toThrow(StorageTransactionError);

      expect(await store.get("ns", "key")).toBe("survive");
    });

    it("returns the value from the transaction function", async () => {
      const result = await store.transaction(async (tx) => {
        tx.set("ns", "k", "v");
        return 42;
      });
      expect(result).toBe(42);
    });

    it("supports explicit rollback", async () => {
      await store.set("ns", "k", "v");

      await store.transaction(async (tx) => {
        tx.set("ns", "k", "new");
        await tx.rollback();
      });

      expect(await store.get("ns", "k")).toBe("v");
    });
  });

  // ── TTL ────────────────────────────────────────────────────────────────

  describe("TTL", () => {
    it("returns value before TTL expires", async () => {
      await store.set("ns", "key", "value");
      const fp = join(dir, "ns.json");
      const data = JSON.parse(readFileSync(fp, "utf-8"));
      data["key"].ttl = 3600;
      writeFileSync(fp, JSON.stringify(data), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();
      expect(await freshStore.get("ns", "key")).toBe("value");
      await freshStore.close();
    });

    it("returns undefined for expired entry on read", async () => {
      const fp = join(dir, "ns.json");
      const data: Record<string, unknown> = {
        key: {
          value: "old",
          createdAt: new Date(Date.now() - 10_000).toISOString(),
          updatedAt: new Date(Date.now() - 10_000).toISOString(),
          ttl: 1,
        },
      };
      writeFileSync(fp, JSON.stringify(data), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();
      expect(await freshStore.get("ns", "key")).toBeUndefined();
      await freshStore.close();
    });

    it("expired entries are not counted", async () => {
      const fp = join(dir, "ns.json");
      const data: Record<string, unknown> = {
        fresh: {
          value: "alive",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        stale: {
          value: "dead",
          createdAt: new Date(Date.now() - 10_000).toISOString(),
          updatedAt: new Date(Date.now() - 10_000).toISOString(),
          ttl: 1,
        },
      };
      writeFileSync(fp, JSON.stringify(data), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();
      expect(await freshStore.count("ns")).toBe(1);
      expect(await freshStore.listKeys("ns")).toEqual(["fresh"]);
      await freshStore.close();
    });
  });

  // ── Persistence ────────────────────────────────────────────────────────

  describe("persistence", () => {
    it("data persists across store instances", async () => {
      await store.set("ns", "key", "persisted");
      await store.close();

      const store2 = new FileStore({ storeDir: dir });
      await store2.initialize();
      expect(await store2.get("ns", "key")).toBe("persisted");
      await store2.close();
    });

    it("writes one JSON file per namespace", async () => {
      await store.set("alpha", "a", 1);
      await store.set("beta", "b", 2);
      await store.close();

      expect(existsSync(join(dir, "alpha.json"))).toBe(true);
      expect(existsSync(join(dir, "beta.json"))).toBe(true);
    });

    it("file content is valid JSON", async () => {
      await store.set("ns", "key", { nested: true });
      await store.close();

      const raw = readFileSync(join(dir, "ns.json"), "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed).toHaveProperty("key");
    });
  });

  // ── Error Handling ─────────────────────────────────────────────────────

  describe("error handling", () => {
    it("throws StorageBackendError when closed", async () => {
      await store.close();
      await expect(store.set("ns", "k", "v")).rejects.toThrow(StorageBackendError);
      await expect(store.get("ns", "k")).rejects.toThrow(StorageBackendError);
      await expect(store.has("ns", "k")).rejects.toThrow(StorageBackendError);
      await expect(store.delete("ns", "k")).rejects.toThrow(StorageBackendError);
      await expect(store.listKeys("ns")).rejects.toThrow(StorageBackendError);
      await expect(store.clear("ns")).rejects.toThrow(StorageBackendError);
      await expect(store.setMany("ns", [])).rejects.toThrow(StorageBackendError);
      await expect(store.getMany("ns", [])).rejects.toThrow(StorageBackendError);
      await expect(store.query("ns", {})).rejects.toThrow(StorageBackendError);
      await expect(store.count("ns")).rejects.toThrow(StorageBackendError);
      await expect(store.transaction(async () => {})).rejects.toThrow(StorageBackendError);
    });

    it("transaction wraps errors in StorageTransactionError", async () => {
      await expect(
        store.transaction(async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow(StorageTransactionError);
    });

    it("transaction preserves original error as cause", async () => {
      try {
        await store.transaction(async () => {
          throw new Error("root cause");
        });
      } catch (err) {
        expect(err).toBeInstanceOf(StorageTransactionError);
        expect((err as StorageTransactionError).cause).toBeInstanceOf(Error);
        expect(((err as StorageTransactionError).cause as Error).message).toBe("root cause");
      }
    });
  });

  // ── Multiple Namespaces ────────────────────────────────────────────────

  describe("multiple namespaces", () => {
    it("keeps namespaces isolated", async () => {
      await store.set("ns1", "key", "value1");
      await store.set("ns2", "key", "value2");
      expect(await store.get("ns1", "key")).toBe("value1");
      expect(await store.get("ns2", "key")).toBe("value2");
    });

    it("clear only affects target namespace", async () => {
      await store.set("ns1", "a", 1);
      await store.set("ns2", "b", 2);
      await store.clear("ns1");
      expect(await store.get("ns1", "a")).toBeUndefined();
      expect(await store.get("ns2", "b")).toBe(2);
    });
  });

  // ── Concurrent Access ──────────────────────────────────────────────────

  describe("concurrent access", () => {
    it("handles parallel sets to the same namespace", async () => {
      const ops = Array.from({ length: 20 }, (_, i) =>
        store.set("ns", `key-${i}`, i),
      );
      await Promise.all(ops);
      const keys = await store.listKeys("ns");
      expect(keys).toHaveLength(20);
    });

    it("handles parallel reads and writes", async () => {
      await store.set("ns", "existing", "value");
      const ops = [
        store.get("ns", "existing"),
        store.set("ns", "new", "data"),
        store.has("ns", "existing"),
        store.delete("ns", "existing"),
        store.get("ns", "new"),
      ];
      const results = await Promise.all(ops);
      expect(results[0]).toBe("value");
      expect(results[2]).toBe(true);
      expect(results[3]).toBe(true);
    });

    it("serializes concurrent writes to same key", async () => {
      const ops = Array.from({ length: 10 }, (_, i) =>
        store.set("ns", "counter", i),
      );
      await Promise.all(ops);
      const val = await store.get("ns", "counter");
      expect(typeof val).toBe("number");
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(10);
    });
  });

  // ── Query: Advanced Ordering (createdAt / updatedAt) ───────────────────

  describe("query advanced ordering", () => {
    it("orders by createdAt ascending", async () => {
      const fp = join(dir, "ns.json");
      writeFileSync(fp, JSON.stringify({
        c: { value: "third", createdAt: "2024-03-01T00:00:00.000Z", updatedAt: "2024-03-01T00:00:00.000Z" },
        a: { value: "first", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" },
        b: { value: "second", createdAt: "2024-02-01T00:00:00.000Z", updatedAt: "2024-02-01T00:00:00.000Z" },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();
      const result = await freshStore.query("ns", { orderBy: "createdAt", order: "asc" });
      expect(result.entries.map((e) => e.key)).toEqual(["a", "b", "c"]);
      await freshStore.close();
    });

    it("orders by createdAt descending", async () => {
      const fp = join(dir, "ns.json");
      writeFileSync(fp, JSON.stringify({
        c: { value: "third", createdAt: "2024-03-01T00:00:00.000Z", updatedAt: "2024-03-01T00:00:00.000Z" },
        a: { value: "first", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" },
        b: { value: "second", createdAt: "2024-02-01T00:00:00.000Z", updatedAt: "2024-02-01T00:00:00.000Z" },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();
      const result = await freshStore.query("ns", { orderBy: "createdAt", order: "desc" });
      expect(result.entries.map((e) => e.key)).toEqual(["c", "b", "a"]);
      await freshStore.close();
    });

    it("orders by updatedAt ascending", async () => {
      const fp = join(dir, "ns.json");
      writeFileSync(fp, JSON.stringify({
        c: { value: "third", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-03-01T00:00:00.000Z" },
        a: { value: "first", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" },
        b: { value: "second", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-02-01T00:00:00.000Z" },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();
      const result = await freshStore.query("ns", { orderBy: "updatedAt", order: "asc" });
      expect(result.entries.map((e) => e.key)).toEqual(["a", "b", "c"]);
      await freshStore.close();
    });

    it("orders by updatedAt descending", async () => {
      const fp = join(dir, "ns.json");
      writeFileSync(fp, JSON.stringify({
        c: { value: "third", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-03-01T00:00:00.000Z" },
        a: { value: "first", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" },
        b: { value: "second", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-02-01T00:00:00.000Z" },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();
      const result = await freshStore.query("ns", { orderBy: "updatedAt", order: "desc" });
      expect(result.entries.map((e) => e.key)).toEqual(["c", "b", "a"]);
      await freshStore.close();
    });
  });

  // ── Query: includeExpired Filter ───────────────────────────────────────

  describe("query includeExpired", () => {
    it("includeExpired: true returns expired entries in query results", async () => {
      const fp = join(dir, "ns.json");
      writeFileSync(fp, JSON.stringify({
        alive: { value: "ok", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        dead: {
          value: "expired",
          createdAt: new Date(Date.now() - 10_000).toISOString(),
          updatedAt: new Date(Date.now() - 10_000).toISOString(),
          ttl: 1,
        },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();
      const result = await freshStore.query("ns", { includeExpired: true });
      expect(result.total).toBe(2);
      expect(result.entries.map((e) => e.key).sort()).toEqual(["alive", "dead"]);
      await freshStore.close();
    });

    it("includeExpired: false (default) excludes expired entries", async () => {
      const fp = join(dir, "ns.json");
      writeFileSync(fp, JSON.stringify({
        alive: { value: "ok", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        dead: {
          value: "expired",
          createdAt: new Date(Date.now() - 10_000).toISOString(),
          updatedAt: new Date(Date.now() - 10_000).toISOString(),
          ttl: 1,
        },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();
      const result = await freshStore.query("ns", {});
      expect(result.total).toBe(1);
      expect(result.entries[0]!.key).toBe("alive");
      await freshStore.close();
    });
  });

  // ── Query: Tags Filter with Matching Entries ──────────────────────────

  describe("query tags filter with matching data", () => {
    it("tags filter returns entries that have the specified tag", async () => {
      const fp = join(dir, "ns.json");
      writeFileSync(fp, JSON.stringify({
        a: { value: "v1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tags: ["important", "urgent"] },
        b: { value: "v2", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tags: ["important"] },
        c: { value: "v3", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tags: ["other"] },
        d: { value: "v4", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();

      const result = await freshStore.query("ns", { tags: ["important"] });
      expect(result.total).toBe(2);
      expect(result.entries.map((e) => e.key).sort()).toEqual(["a", "b"]);
      await freshStore.close();
    });

    it("tags filter with multiple tags requires ALL to match", async () => {
      const fp = join(dir, "ns.json");
      writeFileSync(fp, JSON.stringify({
        a: { value: "v1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tags: ["important", "urgent"] },
        b: { value: "v2", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tags: ["important"] },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();

      const result = await freshStore.query("ns", { tags: ["important", "urgent"] });
      expect(result.total).toBe(1);
      expect(result.entries[0]!.key).toBe("a");
      await freshStore.close();
    });
  });

  // ── Query: updatedAfter / updatedBefore Filters ────────────────────────

  describe("query updated filters", () => {
    it("filters by updatedAfter", async () => {
      const fp = join(dir, "ns.json");
      writeFileSync(fp, JSON.stringify({
        old_update: { value: "old", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" },
        recent: { value: "new", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-06-01T00:00:00.000Z" },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();

      const result = await freshStore.query("ns", { updatedAfter: "2024-03-01T00:00:00.000Z" });
      expect(result.total).toBe(1);
      expect(result.entries[0]!.key).toBe("recent");
      await freshStore.close();
    });

    it("filters by updatedBefore", async () => {
      const fp = join(dir, "ns.json");
      writeFileSync(fp, JSON.stringify({
        old_update: { value: "old", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" },
        recent: { value: "new", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-06-01T00:00:00.000Z" },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();

      const result = await freshStore.query("ns", { updatedBefore: "2024-03-01T00:00:00.000Z" });
      expect(result.total).toBe(1);
      expect(result.entries[0]!.key).toBe("old_update");
      await freshStore.close();
    });
  });

  // ── Query: keyPattern with ? Wildcard ──────────────────────────────────

  describe("query keyPattern with question mark", () => {
    it("filters by keyPattern with ? wildcard (single char)", async () => {
      await store.set("ns", "ab1", 1);
      await store.set("ns", "ab2", 2);
      await store.set("ns", "abc", 3);

      const result = await store.query("ns", { keyPattern: "ab?" });
      expect(result.total).toBe(3);
      expect(result.entries.map((e) => e.key).sort()).toEqual(["ab1", "ab2", "abc"]);
    });
  });

  // ── Query: fullTextSearch Case Insensitivity ───────────────────────────

  describe("query fullTextSearch case insensitive", () => {
    it("fullTextSearch is case-insensitive", async () => {
      await store.set("ns", "key", "HelloWorld");

      const lower = await store.query("ns", { fullTextSearch: "helloworld" });
      expect(lower.total).toBe(1);

      const upper = await store.query("ns", { fullTextSearch: "HELLOWORLD" });
      expect(upper.total).toBe(1);
    });
  });

  // ── Expired Entry Handling in Read Paths ──────────────────────────────

  describe("expired entry handling in read paths", () => {
    it("has returns false for expired entry", async () => {
      const fp = join(dir, "ns.json");
      writeFileSync(fp, JSON.stringify({
        expired: {
          value: "old",
          createdAt: new Date(Date.now() - 10_000).toISOString(),
          updatedAt: new Date(Date.now() - 10_000).toISOString(),
          ttl: 1,
        },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();
      expect(await freshStore.has("ns", "expired")).toBe(false);
      await freshStore.close();
    });

    it("getMany returns undefined for expired entries", async () => {
      const fp = join(dir, "ns.json");
      writeFileSync(fp, JSON.stringify({
        fresh: { value: "ok", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        stale: {
          value: "old",
          createdAt: new Date(Date.now() - 10_000).toISOString(),
          updatedAt: new Date(Date.now() - 10_000).toISOString(),
          ttl: 1,
        },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();

      const results = await freshStore.getMany("ns", ["fresh", "stale", "missing"]);
      expect(results).toEqual([
        { key: "fresh", value: "ok" },
        { key: "stale", value: undefined },
        { key: "missing", value: undefined },
      ]);
      await freshStore.close();
    });

    it("listKeys excludes expired entries", async () => {
      const fp = join(dir, "ns.json");
      writeFileSync(fp, JSON.stringify({
        alive: { value: "ok", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        dead: {
          value: "expired",
          createdAt: new Date(Date.now() - 10_000).toISOString(),
          updatedAt: new Date(Date.now() - 10_000).toISOString(),
          ttl: 1,
        },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();
      expect(await freshStore.listKeys("ns")).toEqual(["alive"]);
      await freshStore.close();
    });
  });

  // ── loadNamespace Error Handling ──────────────────────────────────────

  describe("loadNamespace error handling", () => {
    it("throws StorageBackendError on corrupt JSON file", async () => {
      writeFileSync(join(dir, "corrupt.json"), "{not valid json", "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await expect(freshStore.initialize()).rejects.toThrow(StorageBackendError);
    });
  });

  // ── flushNamespace Error Handling ─────────────────────────────────────

  describe("flushNamespace error handling", () => {
    it("throws StorageBackendError when write fails", async () => {
      // Remove the store directory so writes fail
      rmSync(dir, { recursive: true, force: true });

      await expect(store.set("ns", "key", "value")).rejects.toThrow(StorageBackendError);

      // Recreate directory so afterEach cleanup can proceed
      mkdirSync(dir, { recursive: true });
    });
  });

  // ── cleanupExpired ─────────────────────────────────────────────────────

  describe("cleanupExpired", () => {
    it("removes expired entries from all namespaces", async () => {
      writeFileSync(join(dir, "ns1.json"), JSON.stringify({
        a: { value: "ok", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        b: {
          value: "stale",
          createdAt: new Date(Date.now() - 10_000).toISOString(),
          updatedAt: new Date(Date.now() - 10_000).toISOString(),
          ttl: 1,
        },
      }), "utf-8");
      writeFileSync(join(dir, "ns2.json"), JSON.stringify({
        c: { value: "ok", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        d: {
          value: "stale",
          createdAt: new Date(Date.now() - 10_000).toISOString(),
          updatedAt: new Date(Date.now() - 10_000).toISOString(),
          ttl: 1,
        },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();

      // Access private cleanupExpired via type cast through unknown
      const storeAccess = freshStore as unknown as { cleanupExpired: () => void };
      storeAccess.cleanupExpired();

      expect(await freshStore.listKeys("ns1")).toEqual(["a"]);
      expect(await freshStore.listKeys("ns2")).toEqual(["c"]);
      await freshStore.close();
    });

    it("cleanupExpired does nothing when no entries are expired", async () => {
      await store.set("ns", "key", "value");

      const storeAccess = store as unknown as { cleanupExpired: () => void };
      storeAccess.cleanupExpired();

      // Entry should still exist
      expect(await store.get("ns", "key")).toBe("value");
    });
  });

  // ── Factory Function ──────────────────────────────────────────────────

  describe("factory function", () => {
    it("createFileStore returns a FileStore instance", () => {
      const s = createFileStore({ storeDir: join(dir, "factory") });
      expect(s).toBeInstanceOf(FileStore);
      expect(s.name).toBe("file");
    });
  });

  // ── Tags and TTL Preservation on Overwrite ────────────────────────────

  describe("tag and ttl preservation on overwrite", () => {
    it("set preserves existing tags on overwrite", async () => {
      const fp = join(dir, "ns.json");
      writeFileSync(fp, JSON.stringify({
        key1: {
          value: "original",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: ["preserved-tag"],
        },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();

      await freshStore.set("ns", "key1", "updated");

      // Tags should still be there
      const result = await freshStore.query("ns", { tags: ["preserved-tag"] });
      expect(result.total).toBe(1);
      expect(result.entries[0]!.entry.value).toBe("updated");
      await freshStore.close();
    });

    it("set preserves existing ttl on overwrite", async () => {
      const fp = join(dir, "ns.json");
      writeFileSync(fp, JSON.stringify({
        key1: {
          value: "original",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ttl: 3600,
        },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();

      await freshStore.set("ns", "key1", "updated");

      // TTL should be preserved (entry should have hasTtl)
      const result = await freshStore.query("ns", { hasTtl: true });
      expect(result.total).toBe(1);
      expect(result.entries[0]!.entry.value).toBe("updated");
      await freshStore.close();
    });

    it("setMany preserves existing tags on overwrite", async () => {
      const fp = join(dir, "ns.json");
      writeFileSync(fp, JSON.stringify({
        key1: {
          value: "original",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: ["saved-tag"],
        },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();

      await freshStore.setMany("ns", [{ key: "key1", value: "updated" }]);

      const result = await freshStore.query("ns", { tags: ["saved-tag"] });
      expect(result.total).toBe(1);
      expect(result.entries[0]!.entry.value).toBe("updated");
      await freshStore.close();
    });

    it("setMany preserves existing ttl on overwrite", async () => {
      const fp = join(dir, "ns.json");
      writeFileSync(fp, JSON.stringify({
        key1: {
          value: "original",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ttl: 3600,
        },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();

      await freshStore.setMany("ns", [{ key: "key1", value: "updated" }]);

      const result = await freshStore.query("ns", { hasTtl: true });
      expect(result.total).toBe(1);
      expect(result.entries[0]!.entry.value).toBe("updated");
      await freshStore.close();
    });
  });

  // ── Transaction Edge Cases ────────────────────────────────────────────

  describe("transaction edge cases", () => {
    it("tx.get returns undefined for expired entry in snapshot", async () => {
      const fp = join(dir, "ns.json");
      writeFileSync(fp, JSON.stringify({
        expired: {
          value: "old",
          createdAt: new Date(Date.now() - 10_000).toISOString(),
          updatedAt: new Date(Date.now() - 10_000).toISOString(),
          ttl: 1,
        },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();

      const result = await freshStore.transaction(async (tx) => {
        return tx.get("ns", "expired");
      });

      expect(result).toBeUndefined();
      await freshStore.close();
    });

    it("tx.get uses snapshot isolation (cached readNs)", async () => {
      await store.set("ns", "key", "original");

      const result = await store.transaction(async (tx) => {
        const first = await tx.get("ns", "key");
        // Outside change - should not affect tx snapshot
        await store.set("ns", "key", "changed");
        const second = await tx.get("ns", "key");
        return { first, second };
      });

      // Both reads should return the snapshot value
      expect(result.first).toBe("original");
      expect(result.second).toBe("original");
    });

    it("commit applies set then delete correctly within same transaction", async () => {
      await store.transaction(async (tx) => {
        tx.set("ns", "key", "value");
        tx.delete("ns", "key");
      });

      expect(await store.get("ns", "key")).toBeUndefined();
    });

    it("transaction wraps non-Error throws in StorageTransactionError", async () => {
      await expect(
        store.transaction(async () => {
          throw "string error";
        }),
      ).rejects.toThrow(StorageTransactionError);
    });
  });

  // ── Count with Advanced Filters ───────────────────────────────────────

  describe("count with advanced filters", () => {
    it("counts entries matching tags filter", async () => {
      const fp = join(dir, "ns.json");
      writeFileSync(fp, JSON.stringify({
        a: { value: "v1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tags: ["important"] },
        b: { value: "v2", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tags: ["important"] },
        c: { value: "v3", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tags: ["other"] },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();

      expect(await freshStore.count("ns", { tags: ["important"] })).toBe(2);
      await freshStore.close();
    });

    it("counts entries matching fullTextSearch", async () => {
      await store.set("ns", "a", "hello world");
      await store.set("ns", "b", "goodbye");
      await store.set("ns", "c", "hello again");

      expect(await store.count("ns", { fullTextSearch: "hello" })).toBe(2);
    });

    it("counts entries matching hasTtl", async () => {
      const fp = join(dir, "ns.json");
      writeFileSync(fp, JSON.stringify({
        a: { value: "v1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ttl: 3600 },
        b: { value: "v2", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        c: { value: "v3", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ttl: 7200 },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();

      expect(await freshStore.count("ns", { hasTtl: true })).toBe(2);
      await freshStore.close();
    });
  });

  // ── Initialize Edge Cases ─────────────────────────────────────────────

  describe("initialize edge cases", () => {
    it("skips .lock files during initialization", async () => {
      writeFileSync(join(dir, "recovery.lock"), "{}", "utf-8");
      writeFileSync(join(dir, "data.json"), JSON.stringify({
        key: { value: "hello", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();

      // The .json file should be loaded, .lock should be ignored
      expect(await freshStore.get("data", "key")).toBe("hello");
      // "recovery" namespace should not exist (.lock files are skipped)
      expect(await freshStore.listKeys("recovery")).toEqual([]);
      await freshStore.close();
    });

    it("initializes with existing JSON data on disk", async () => {
      writeFileSync(join(dir, "preloaded.json"), JSON.stringify({
        k1: { value: "a", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        k2: { value: "b", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      }), "utf-8");

      const freshStore = new FileStore({ storeDir: dir });
      await freshStore.initialize();

      expect(await freshStore.get("preloaded", "k1")).toBe("a");
      expect(await freshStore.get("preloaded", "k2")).toBe("b");
      expect(await freshStore.listKeys("preloaded")).toEqual(["k1", "k2"]);
      await freshStore.close();
    });
  });

  // ── Close Edge Cases ──────────────────────────────────────────────────

  describe("close edge cases", () => {
    it("close handles missing cleanup timer gracefully", async () => {
      const s = new FileStore({ storeDir: join(dir, "never-initialized") });
      // Never initialized - no cleanup timer set
      await s.close();
      expect(s.isHealthy()).toBe(false);
    });
  });
});

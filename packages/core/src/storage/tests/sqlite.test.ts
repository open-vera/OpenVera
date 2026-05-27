import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorageProvider } from "../sqlite.js";
import {
  StorageBackendError,
  StorageTransactionError,
} from "../types.js";
import type { StorageOptions } from "../types.js";

let tmpDir: string;
let dbPath: string;
let provider: SqliteStorageProvider;

async function makeProvider(opts?: Partial<StorageOptions>): Promise<SqliteStorageProvider> {
  const p = new SqliteStorageProvider({
    backend: "sqlite",
    dbPath,
    walMode: true,
    ...opts,
  });
  await p.initialize();
  return p;
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "sqlite-test-"));
  dbPath = join(tmpDir, "test.db");
});

afterEach(async () => {
  if (provider) {
    await provider.close();
  }
  await rm(tmpDir, { recursive: true, force: true });
});

// ── CRUD Operations ────────────────────────────────────────────────────────

describe("CRUD operations", () => {
  it("set and get a string value", async () => {
    provider = await makeProvider();
    await provider.set("ns", "hello", "world");
    const val = await provider.get("ns", "hello");
    expect(val).toBe("world");
  });

  it("set and get a number value", async () => {
    provider = await makeProvider();
    await provider.set("ns", "count", 42);
    const val = await provider.get("ns", "count");
    expect(val).toBe(42);
  });

  it("set and get a boolean value", async () => {
    provider = await makeProvider();
    await provider.set("ns", "flag", true);
    const val = await provider.get("ns", "flag");
    expect(val).toBe(true);
  });

  it("set and get a null value", async () => {
    provider = await makeProvider();
    await provider.set("ns", "empty", null);
    const val = await provider.get("ns", "empty");
    expect(val).toBe(null);
  });

  it("set and get an object value", async () => {
    provider = await makeProvider();
    const obj = { nested: { arr: [1, 2, 3] }, str: "hello" };
    await provider.set("ns", "obj", obj);
    const val = await provider.get("ns", "obj");
    expect(val).toEqual(obj);
  });

  it("set and get an array value", async () => {
    provider = await makeProvider();
    await provider.set("ns", "list", [1, "two", null, true]);
    const val = await provider.get("ns", "list");
    expect(val).toEqual([1, "two", null, true]);
  });

  it("returns undefined for missing key", async () => {
    provider = await makeProvider();
    const val = await provider.get("ns", "nonexistent");
    expect(val).toBeUndefined();
  });

  it("overwrites existing value on set", async () => {
    provider = await makeProvider();
    await provider.set("ns", "key", "first");
    await provider.set("ns", "key", "second");
    const val = await provider.get("ns", "key");
    expect(val).toBe("second");
  });

  it("has returns true for existing key", async () => {
    provider = await makeProvider();
    await provider.set("ns", "exists", "yes");
    expect(await provider.has("ns", "exists")).toBe(true);
  });

  it("has returns false for missing key", async () => {
    provider = await makeProvider();
    expect(await provider.has("ns", "missing")).toBe(false);
  });

  it("delete removes an existing key and returns true", async () => {
    provider = await makeProvider();
    await provider.set("ns", "key", "value");
    const deleted = await provider.delete("ns", "key");
    expect(deleted).toBe(true);
    expect(await provider.get("ns", "key")).toBeUndefined();
  });

  it("delete returns false for missing key", async () => {
    provider = await makeProvider();
    const deleted = await provider.delete("ns", "missing");
    expect(deleted).toBe(false);
  });

  it("listKeys returns all keys in a namespace", async () => {
    provider = await makeProvider();
    await provider.set("ns", "a", 1);
    await provider.set("ns", "b", 2);
    await provider.set("ns", "c", 3);
    const keys = await provider.listKeys("ns");
    expect(keys.sort()).toEqual(["a", "b", "c"]);
  });

  it("listKeys returns empty array for empty namespace", async () => {
    provider = await makeProvider();
    const keys = await provider.listKeys("empty");
    expect(keys).toEqual([]);
  });

  it("clear removes all entries in a namespace", async () => {
    provider = await makeProvider();
    await provider.set("ns", "a", 1);
    await provider.set("ns", "b", 2);
    await provider.set("other", "c", 3);
    await provider.clear("ns");
    expect(await provider.listKeys("ns")).toEqual([]);
    expect(await provider.get("other", "c")).toBe(3);
  });
});

// ── Namespace Isolation ────────────────────────────────────────────────────

describe("namespace isolation", () => {
  it("same key in different namespaces are independent", async () => {
    provider = await makeProvider();
    await provider.set("ns1", "key", "value1");
    await provider.set("ns2", "key", "value2");
    expect(await provider.get("ns1", "key")).toBe("value1");
    expect(await provider.get("ns2", "key")).toBe("value2");
  });

  it("clear one namespace does not affect another", async () => {
    provider = await makeProvider();
    await provider.set("ns1", "a", 1);
    await provider.set("ns2", "b", 2);
    await provider.clear("ns1");
    expect(await provider.get("ns1", "a")).toBeUndefined();
    expect(await provider.get("ns2", "b")).toBe(2);
  });
});

// ── Batch Operations ───────────────────────────────────────────────────────

describe("batch operations", () => {
  it("setMany stores multiple entries atomically", async () => {
    provider = await makeProvider();
    await provider.setMany("ns", [
      { key: "a", value: 1 },
      { key: "b", value: "two" },
      { key: "c", value: { nested: true } },
    ]);
    expect(await provider.get("ns", "a")).toBe(1);
    expect(await provider.get("ns", "b")).toBe("two");
    expect(await provider.get("ns", "c")).toEqual({ nested: true });
  });

  it("setMany with empty array is a no-op", async () => {
    provider = await makeProvider();
    await provider.setMany("ns", []);
    expect(await provider.listKeys("ns")).toEqual([]);
  });

  it("getMany retrieves multiple values", async () => {
    provider = await makeProvider();
    await provider.set("ns", "a", 1);
    await provider.set("ns", "b", 2);
    const results = await provider.getMany("ns", ["a", "b", "missing"]);
    expect(results).toEqual([
      { key: "a", value: 1 },
      { key: "b", value: 2 },
      { key: "missing", value: undefined },
    ]);
  });

  it("getMany with empty keys returns empty array", async () => {
    provider = await makeProvider();
    const results = await provider.getMany("ns", []);
    expect(results).toEqual([]);
  });
});

// ── Query with Filters ─────────────────────────────────────────────────────

describe("query with filters", () => {
  it("query all entries in namespace", async () => {
    provider = await makeProvider();
    await provider.set("ns", "a", 1);
    await provider.set("ns", "b", 2);
    const result = await provider.query("ns", {});
    expect(result.entries).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(false);
  });

  it("query with keyPrefix filter", async () => {
    provider = await makeProvider();
    await provider.set("ns", "user:1", "alice");
    await provider.set("ns", "user:2", "bob");
    await provider.set("ns", "config:db", "sqlite");
    const result = await provider.query("ns", { keyPrefix: "user:" });
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((e) => e.key).sort()).toEqual(["user:1", "user:2"]);
  });

  it("query with keyPattern filter (glob)", async () => {
    provider = await makeProvider();
    await provider.set("ns", "file.txt", 1);
    await provider.set("ns", "file.md", 2);
    await provider.set("ns", "data.json", 3);
    const result = await provider.query("ns", { keyPattern: "file.*" });
    expect(result.entries).toHaveLength(2);
  });

  it("query with limit and offset", async () => {
    provider = await makeProvider();
    for (let i = 0; i < 10; i++) {
      await provider.set("ns", `key${String(i).padStart(2, "0")}`, i);
    }
    const page1 = await provider.query("ns", { limit: 3, offset: 0 });
    expect(page1.entries).toHaveLength(3);
    expect(page1.total).toBe(10);
    expect(page1.hasMore).toBe(true);

    const page2 = await provider.query("ns", { limit: 3, offset: 3 });
    expect(page2.entries).toHaveLength(3);
    expect(page2.hasMore).toBe(true);

    const page4 = await provider.query("ns", { limit: 3, offset: 9 });
    expect(page4.entries).toHaveLength(1);
    expect(page4.hasMore).toBe(false);
  });

  it("query with orderBy key asc", async () => {
    provider = await makeProvider();
    await provider.set("ns", "c", 3);
    await provider.set("ns", "a", 1);
    await provider.set("ns", "b", 2);
    const result = await provider.query("ns", { orderBy: "key", order: "asc" });
    expect(result.entries.map((e) => e.key)).toEqual(["a", "b", "c"]);
  });

  it("query with orderBy key desc", async () => {
    provider = await makeProvider();
    await provider.set("ns", "c", 3);
    await provider.set("ns", "a", 1);
    await provider.set("ns", "b", 2);
    const result = await provider.query("ns", { orderBy: "key", order: "desc" });
    expect(result.entries.map((e) => e.key)).toEqual(["c", "b", "a"]);
  });

  it("query with orderBy createdAt", async () => {
    provider = await makeProvider();
    await provider.set("ns", "first", 1);
    await provider.set("ns", "second", 2);
    const result = await provider.query("ns", { orderBy: "createdAt", order: "asc" });
    expect(result.entries.map((e) => e.key)).toEqual(["first", "second"]);
  });

  it("query with createdAfter filter", async () => {
    provider = await makeProvider();
    await provider.set("ns", "old", 1);
    const futureDate = new Date(Date.now() + 100_000).toISOString();
    const result = await provider.query("ns", { createdAfter: futureDate });
    expect(result.entries).toHaveLength(0);
  });

  it("query returns metadata in entries", async () => {
    provider = await makeProvider();
    await provider.set("ns", "key", "value");
    const result = await provider.query("ns", {});
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0].entry;
    expect(entry.value).toBe("value");
    expect(entry.createdAt).toBeTruthy();
    expect(entry.updatedAt).toBeTruthy();
    expect(new Date(entry.createdAt).toISOString()).toBe(entry.createdAt);
  });

  it("count returns total matching entries", async () => {
    provider = await makeProvider();
    await provider.set("ns", "a", 1);
    await provider.set("ns", "b", 2);
    await provider.set("ns", "c", 3);
    expect(await provider.count("ns")).toBe(3);
  });

  it("count with filter", async () => {
    provider = await makeProvider();
    await provider.set("ns", "user:1", "alice");
    await provider.set("ns", "user:2", "bob");
    await provider.set("ns", "config", "db");
    expect(await provider.count("ns", { keyPrefix: "user:" })).toBe(2);
  });
});

// ── Transaction Support ────────────────────────────────────────────────────

describe("transaction support", () => {
  it("transaction commits pending operations", async () => {
    provider = await makeProvider();
    await provider.transaction(async (tx) => {
      tx.set("ns", "a", 1);
      tx.set("ns", "b", 2);
      await tx.commit();
    });
    expect(await provider.get("ns", "a")).toBe(1);
    expect(await provider.get("ns", "b")).toBe(2);
  });

  it("transaction rollback discards pending operations", async () => {
    provider = await makeProvider();
    await provider.set("ns", "existing", "value");
    await provider.transaction(async (tx) => {
      tx.set("ns", "new", "data");
      tx.delete("ns", "existing");
      await tx.rollback();
    });
    expect(await provider.get("ns", "new")).toBeUndefined();
    expect(await provider.get("ns", "existing")).toBe("value");
  });

  it("transaction get reads current state", async () => {
    provider = await makeProvider();
    await provider.set("ns", "key", "initial");
    await provider.transaction(async (tx) => {
      const val = await tx.get("ns", "key");
      expect(val).toBe("initial");
      tx.set("ns", "key", "updated");
      await tx.commit();
    });
    expect(await provider.get("ns", "key")).toBe("updated");
  });

  it("transaction delete removes entries", async () => {
    provider = await makeProvider();
    await provider.set("ns", "key", "value");
    await provider.transaction(async (tx) => {
      tx.delete("ns", "key");
      await tx.commit();
    });
    expect(await provider.get("ns", "key")).toBeUndefined();
  });

  it("double commit throws", async () => {
    provider = await makeProvider();
    await expect(
      provider.transaction(async (tx) => {
        tx.set("ns", "a", 1);
        await tx.commit();
        await tx.commit();
      })
    ).rejects.toThrow(StorageTransactionError);
  });

  it("double rollback throws", async () => {
    provider = await makeProvider();
    await expect(
      provider.transaction(async (tx) => {
        tx.set("ns", "a", 1);
        await tx.rollback();
        await tx.rollback();
      })
    ).rejects.toThrow(StorageTransactionError);
  });

  it("set after commit throws", async () => {
    provider = await makeProvider();
    await expect(
      provider.transaction(async (tx) => {
        tx.set("ns", "a", 1);
        await tx.commit();
        tx.set("ns", "b", 2);
      })
    ).rejects.toThrow(StorageTransactionError);
  });
});

// ── TTL Expiry ─────────────────────────────────────────────────────────────

describe("TTL expiry", () => {
  it("expired entries are not returned by get", async () => {
    provider = await makeProvider();
    const now = new Date();
    const pastIso = new Date(now.getTime() - 2000).toISOString();
    // Manually insert an expired entry
    const db = new (await import("better-sqlite3")).default(dbPath);
    db.prepare(`
      INSERT INTO kv_entries (namespace, key, value, created_at, updated_at, ttl, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("ns", "expired", JSON.stringify("old"), pastIso, pastIso, 1, null);
    db.close();

    // Re-open with the provider (it already has the file)
    await provider.close();
    provider = await makeProvider();
    const val = await provider.get("ns", "expired");
    expect(val).toBeUndefined();
  });

  it("expired entries are not returned by has", async () => {
    provider = await makeProvider();
    const pastIso = new Date(Date.now() - 5000).toISOString();
    const db = new (await import("better-sqlite3")).default(dbPath);
    db.prepare(`
      INSERT INTO kv_entries (namespace, key, value, created_at, updated_at, ttl, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("ns", "expired", JSON.stringify("old"), pastIso, pastIso, 1, null);
    db.close();

    await provider.close();
    provider = await makeProvider();
    expect(await provider.has("ns", "expired")).toBe(false);
  });

  it("non-expired entries with future TTL are returned", async () => {
    provider = await makeProvider();
    const now = new Date().toISOString();
    const db = new (await import("better-sqlite3")).default(dbPath);
    db.prepare(`
      INSERT INTO kv_entries (namespace, key, value, created_at, updated_at, ttl, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("ns", "alive", JSON.stringify("data"), now, now, 86400, null);
    db.close();

    await provider.close();
    provider = await makeProvider();
    const val = await provider.get("ns", "alive");
    expect(val).toBe("data");
  });

  it("entries without TTL never expire", async () => {
    provider = await makeProvider();
    const pastIso = new Date(Date.now() - 100_000_000).toISOString();
    const db = new (await import("better-sqlite3")).default(dbPath);
    db.prepare(`
      INSERT INTO kv_entries (namespace, key, value, created_at, updated_at, ttl, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("ns", "permanent", JSON.stringify("forever"), pastIso, pastIso, null, null);
    db.close();

    await provider.close();
    provider = await makeProvider();
    const val = await provider.get("ns", "permanent");
    expect(val).toBe("forever");
  });
});

// ── FTS5 Search ────────────────────────────────────────────────────────────

describe("FTS5 full-text search", () => {
  it("fullTextSearch returns matching entries", async () => {
    provider = await makeProvider({ enableFts: true });
    await provider.set("ns", "doc1", "The quick brown fox jumps over the lazy dog");
    await provider.set("ns", "doc2", "A fast red car drives down the highway");
    await provider.set("ns", "doc3", "The brown bear sleeps in the forest");

    const result = await provider.query("ns", { fullTextSearch: "brown" });
    expect(result.entries.length).toBeGreaterThanOrEqual(2);
    const keys = result.entries.map((e) => e.key);
    expect(keys).toContain("doc1");
    expect(keys).toContain("doc3");
  });

  it("fullTextSearch excludes non-matching entries", async () => {
    provider = await makeProvider({ enableFts: true });
    await provider.set("ns", "match", "hello world");
    await provider.set("ns", "nomatch", "goodbye universe");

    const result = await provider.query("ns", { fullTextSearch: "hello" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].key).toBe("match");
  });

  it("query without fullTextSearch works when FTS is enabled", async () => {
    provider = await makeProvider({ enableFts: true });
    await provider.set("ns", "a", "value");
    const result = await provider.query("ns", {});
    expect(result.entries).toHaveLength(1);
  });
});

// ── Error Handling ─────────────────────────────────────────────────────────

describe("error handling", () => {
  it("throws StorageBackendError when dbPath is missing", () => {
    expect(() => new SqliteStorageProvider({ backend: "sqlite" })).toThrow(StorageBackendError);
  });

  it("operations throw after close", async () => {
    provider = await makeProvider();
    await provider.close();
    await expect(provider.set("ns", "key", "val")).rejects.toThrow(StorageBackendError);
    await expect(provider.get("ns", "key")).rejects.toThrow(StorageBackendError);
    await expect(provider.has("ns", "key")).rejects.toThrow(StorageBackendError);
    await expect(provider.delete("ns", "key")).rejects.toThrow(StorageBackendError);
    await expect(provider.listKeys("ns")).rejects.toThrow(StorageBackendError);
    await expect(provider.clear("ns")).rejects.toThrow(StorageBackendError);
    await expect(provider.setMany("ns", [])).rejects.toThrow(StorageBackendError);
    await expect(provider.getMany("ns", [])).rejects.toThrow(StorageBackendError);
    await expect(provider.query("ns", {})).rejects.toThrow(StorageBackendError);
    await expect(provider.count("ns")).rejects.toThrow(StorageBackendError);
  });

  it("close is idempotent", async () => {
    provider = await makeProvider();
    await provider.close();
    await provider.close();
  });

  it("isHealthy returns false after close", async () => {
    provider = await makeProvider();
    expect(provider.isHealthy()).toBe(true);
    await provider.close();
    expect(provider.isHealthy()).toBe(false);
    provider = undefined as unknown as SqliteStorageProvider;
  });
});

// ── Provider Metadata ──────────────────────────────────────────────────────

describe("provider metadata", () => {
  it("name is sqlite", async () => {
    provider = await makeProvider();
    expect(provider.name).toBe("sqlite");
  });
});

// ── Concurrent Access ──────────────────────────────────────────────────────

describe("concurrent access", () => {
  it("multiple set operations do not corrupt data", async () => {
    provider = await makeProvider();
    const ops: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      ops.push(provider.set("ns", `key${i}`, i));
    }
    await Promise.all(ops);
    for (let i = 0; i < 50; i++) {
      const val = await provider.get("ns", `key${i}`);
      expect(val).toBe(i);
    }
  });

  it("multiple getMany operations work concurrently", async () => {
    provider = await makeProvider();
    for (let i = 0; i < 20; i++) {
      await provider.set("ns", `k${i}`, i);
    }
    const keys = Array.from({ length: 20 }, (_, i) => `k${i}`);
    const ops = Array.from({ length: 5 }, () => provider.getMany("ns", keys));
    const results = await Promise.all(ops);
    for (const result of results) {
      expect(result).toHaveLength(20);
      expect(result[0].value).toBe(0);
    }
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorageProvider } from "../sqlite.js";
import {
  UserDataStore,
  ValidationError,
  createDataSaveTool,
  createDataLoadTool,
  createDataListTool,
  createDataDeleteTool,
  createUserDataTools,
} from "../user-data.js";
import type { StorageOptions } from "../types.js";

let tmpDir: string;
let dbPath: string;
let provider: SqliteStorageProvider;
let store: UserDataStore;

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
  tmpDir = await mkdtemp(join(tmpdir(), "user-data-test-"));
  dbPath = join(tmpDir, "test.db");
  provider = await makeProvider();
  store = new UserDataStore(provider);
});

afterEach(async () => {
  await provider.close();
  await rm(tmpDir, { recursive: true, force: true });
});

// ── UserDataStore — Save & Load ──────────────────────────────────────────────

describe("UserDataStore — save and load", () => {
  it("saves and loads a string value", async () => {
    await store.save({ key: "greeting", value: "hello" });
    const entry = await store.load({ key: "greeting" });
    expect(entry.key).toBe("greeting");
    expect(entry.value).toBe("hello");
    expect(entry.namespace).toBe("default");
  });

  it("saves and loads a number value", async () => {
    await store.save({ key: "count", value: 42 });
    const entry = await store.load({ key: "count" });
    expect(entry.value).toBe(42);
  });

  it("saves and loads a boolean value", async () => {
    await store.save({ key: "flag", value: true });
    const entry = await store.load({ key: "flag" });
    expect(entry.value).toBe(true);
  });

  it("saves and loads null", async () => {
    await store.save({ key: "nothing", value: null });
    const entry = await store.load({ key: "nothing" });
    expect(entry.value).toBeNull();
  });

  it("saves and loads an object value", async () => {
    const obj = { name: "Alice", age: 30, tags: ["admin", "user"] };
    await store.save({ key: "user", value: obj });
    const entry = await store.load({ key: "user" });
    expect(entry.value).toEqual(obj);
  });

  it("saves and loads an array value", async () => {
    const arr = [1, "two", null, { nested: true }];
    await store.save({ key: "mixed", value: arr });
    const entry = await store.load({ key: "mixed" });
    expect(entry.value).toEqual(arr);
  });

  it("saves with a description", async () => {
    await store.save({ key: "config", value: { theme: "dark" }, description: "UI preferences" });
    const entry = await store.load({ key: "config" });
    expect(entry.description).toBe("UI preferences");
  });

  it("preserves createdAt on overwrite", async () => {
    await store.save({ key: "counter", value: 1 });
    const first = await store.load({ key: "counter" });

    // Small delay to ensure different updatedAt
    await new Promise((r) => setTimeout(r, 10));

    await store.save({ key: "counter", value: 2 });
    const second = await store.load({ key: "counter" });

    expect(second.value).toBe(2);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
  });

  it("throws StorageNotFoundError for missing key", async () => {
    await expect(store.load({ key: "nonexistent" })).rejects.toThrow();
  });
});

// ── UserDataStore — Namespaces ───────────────────────────────────────────────

describe("UserDataStore — namespaces", () => {
  it("uses 'default' namespace when not specified", async () => {
    await store.save({ key: "x", value: 1 });
    const entry = await store.load({ key: "x" });
    expect(entry.namespace).toBe("default");
  });

  it("saves and loads from explicit namespace", async () => {
    await store.save({ key: "x", value: 1, namespace: "settings" });
    const entry = await store.load({ key: "x", namespace: "settings" });
    expect(entry.value).toBe(1);
    expect(entry.namespace).toBe("settings");
  });

  it("isolates data across namespaces", async () => {
    await store.save({ key: "x", value: "alpha", namespace: "ns1" });
    await store.save({ key: "x", value: "beta", namespace: "ns2" });

    const e1 = await store.load({ key: "x", namespace: "ns1" });
    const e2 = await store.load({ key: "x", namespace: "ns2" });

    expect(e1.value).toBe("alpha");
    expect(e2.value).toBe("beta");
  });

  it("lists entries in a namespace", async () => {
    await store.save({ key: "a", value: 1, namespace: "ns1" });
    await store.save({ key: "b", value: 2, namespace: "ns1" });
    await store.save({ key: "c", value: 3, namespace: "ns2" });

    const entries = await store.list({ namespace: "ns1" });
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.key).sort()).toEqual(["a", "b"]);
  });

  it("lists namespaces", async () => {
    await store.save({ key: "a", value: 1, namespace: "alpha" });
    await store.save({ key: "b", value: 2, namespace: "beta" });
    await store.save({ key: "c", value: 3, namespace: "gamma" });

    const namespaces = await store.listNamespaces();
    expect(namespaces).toEqual(["alpha", "beta", "gamma"]);
  });

  it("deletes from a specific namespace", async () => {
    await store.save({ key: "x", value: "a", namespace: "ns1" });
    await store.save({ key: "x", value: "b", namespace: "ns2" });

    await store.delete({ key: "x", namespace: "ns1" });

    await expect(store.load({ key: "x", namespace: "ns1" })).rejects.toThrow();
    const entry = await store.load({ key: "x", namespace: "ns2" });
    expect(entry.value).toBe("b");
  });

  it("returns empty list for empty namespace", async () => {
    const entries = await store.list({ namespace: "empty" });
    expect(entries).toEqual([]);
  });

  it("rejects empty namespace", async () => {
    await expect(
      store.save({ key: "x", value: 1, namespace: "" })
    ).rejects.toThrow(ValidationError);
  });
});

// ── UserDataStore — Delete ───────────────────────────────────────────────────

describe("UserDataStore — delete", () => {
  it("returns true when deleting an existing entry", async () => {
    await store.save({ key: "temp", value: "data" });
    const result = await store.delete({ key: "temp" });
    expect(result).toBe(true);
  });

  it("returns false when deleting a non-existent entry", async () => {
    const result = await store.delete({ key: "ghost" });
    expect(result).toBe(false);
  });

  it("confirms entry is gone after deletion", async () => {
    await store.save({ key: "gone", value: 1 });
    await store.delete({ key: "gone" });

    const entries = await store.list({});
    expect(entries.find((e) => e.key === "gone")).toBeUndefined();
  });
});

// ── UserDataStore — Overwrite ────────────────────────────────────────────────

describe("UserDataStore — overwrite", () => {
  it("overwrites existing value", async () => {
    await store.save({ key: "key", value: "old" });
    await store.save({ key: "key", value: "new" });

    const entry = await store.load({ key: "key" });
    expect(entry.value).toBe("new");
  });

  it("updates description on overwrite", async () => {
    await store.save({ key: "key", value: 1, description: "v1" });
    await store.save({ key: "key", value: 2, description: "v2" });

    const entry = await store.load({ key: "key" });
    expect(entry.value).toBe(2);
    expect(entry.description).toBe("v2");
  });

  it("count remains 1 after overwrite", async () => {
    await store.save({ key: "dup", value: "a" });
    await store.save({ key: "dup", value: "b" });

    const entries = await store.list({});
    const matches = entries.filter((e) => e.key === "dup");
    expect(matches).toHaveLength(1);
  });
});

// ── UserDataStore — Validation ───────────────────────────────────────────────

describe("UserDataStore — validation", () => {
  it("rejects empty key", async () => {
    await expect(
      store.save({ key: "", value: "data" })
    ).rejects.toThrow(ValidationError);
  });

  it("rejects key exceeding max length (256 chars)", async () => {
    const longKey = "a".repeat(257);
    await expect(
      store.save({ key: longKey, value: "data" })
    ).rejects.toThrow(ValidationError);
  });

  it("accepts key at exactly max length (256 chars)", async () => {
    const maxKey = "b".repeat(256);
    await store.save({ key: maxKey, value: "ok" });
    const entry = await store.load({ key: maxKey });
    expect(entry.key).toBe(maxKey);
  });

  it("rejects value exceeding 1 MB", async () => {
    // Create a string just over 1 MB
    const bigString = "x".repeat(1_048_577);
    await expect(
      store.save({ key: "big", value: bigString })
    ).rejects.toThrow(ValidationError);
  });

  it("accepts value at exactly 1 MB", async () => {
    // JSON string with quotes overhead, so use a slightly smaller string
    const bigString = "y".repeat(1_048_570);
    await store.save({ key: "big-ok", value: bigString });
    const entry = await store.load({ key: "big-ok" });
    expect(entry.value).toBe(bigString);
  });

  it("rejects when namespace limit (50) is exceeded", async () => {
    // Create entries in 50 different namespaces
    for (let i = 0; i < 50; i++) {
      await store.save({ key: "k", value: i, namespace: `ns-${i}` });
    }

    // 51st namespace should fail
    await expect(
      store.save({ key: "k", value: "fail", namespace: "ns-overflow" })
    ).rejects.toThrow(ValidationError);
  });

  it("allows saving to existing namespace when limit is reached", async () => {
    for (let i = 0; i < 50; i++) {
      await store.save({ key: "k", value: i, namespace: `ns-${i}` });
    }

    // Overwrite in existing namespace should work
    await store.save({ key: "k2", value: "ok", namespace: "ns-0" });
    const entry = await store.load({ key: "k2", namespace: "ns-0" });
    expect(entry.value).toBe("ok");
  });
});

// ── UserDataStore — TTL ──────────────────────────────────────────────────────

describe("UserDataStore — TTL", () => {
  it("stores TTL and expiresAt metadata", async () => {
    await store.save({ key: "temp", value: "data", ttl: 60 });
    const entry = await store.load({ key: "temp" });
    // Verify the entry loads correctly (TTL not expired)
    expect(entry.value).toBe("data");
  });

  it("returns expired entry as not found", async () => {
    // TTL of 1 second
    await store.save({ key: "short-lived", value: "bye", ttl: 1 });

    // Wait for expiry
    await new Promise((r) => setTimeout(r, 1100));

    await expect(
      store.load({ key: "short-lived" })
    ).rejects.toThrow();
  });

  it("expired entries are excluded from list", async () => {
    await store.save({ key: "permanent", value: "stay" });
    await store.save({ key: "ephemeral", value: "go", ttl: 1 });

    // Wait for expiry
    await new Promise((r) => setTimeout(r, 1100));

    const entries = await store.list({});
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe("permanent");
  });

  it("expired entries do not count toward namespace list", async () => {
    await store.save({ key: "k", value: "v", namespace: "temp-ns", ttl: 1 });

    // Wait for expiry
    await new Promise((r) => setTimeout(r, 1100));

    const namespaces = await store.listNamespaces();
    expect(namespaces).not.toContain("temp-ns");
  });
});

// ── UserDataStore — Sorted Output ────────────────────────────────────────────

describe("UserDataStore — list ordering", () => {
  it("returns entries sorted by updatedAt descending", async () => {
    await store.save({ key: "first", value: 1 });
    await new Promise((r) => setTimeout(r, 10));
    await store.save({ key: "second", value: 2 });
    await new Promise((r) => setTimeout(r, 10));
    await store.save({ key: "third", value: 3 });

    const entries = await store.list({});
    expect(entries.map((e) => e.key)).toEqual(["third", "second", "first"]);
  });
});

// ── Tool Definitions — data_save ─────────────────────────────────────────────

describe("tool: data_save", () => {
  it("saves data and returns success message", async () => {
    const tool = createDataSaveTool(store);
    const result = await tool.execute(
      { key: "test", value: { a: 1 } },
      { cwd: "/tmp", sessionId: "s1" }
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Saved \"test\"");
    expect(result.content).toContain("namespace \"default\"");
  });

  it("saves with namespace and description", async () => {
    const tool = createDataSaveTool(store);
    const result = await tool.execute(
      { key: "config", value: "dark", namespace: "theme", description: "Color theme" },
      { cwd: "/tmp", sessionId: "s1" }
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("namespace \"theme\"");
  });

  it("reports TTL in message", async () => {
    const tool = createDataSaveTool(store);
    const result = await tool.execute(
      { key: "session", value: "abc", ttl: 300 },
      { cwd: "/tmp", sessionId: "s1" }
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("TTL: 300s");
  });

  it("returns error for validation failure", async () => {
    const tool = createDataSaveTool(store);
    const result = await tool.execute(
      { key: "", value: "data" },
      { cwd: "/tmp", sessionId: "s1" }
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
  });

  it("returns error for oversized value", async () => {
    const tool = createDataSaveTool(store);
    const result = await tool.execute(
      { key: "big", value: "x".repeat(1_048_577) },
      { cwd: "/tmp", sessionId: "s1" }
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
  });
});

// ── Tool Definitions — data_load ─────────────────────────────────────────────

describe("tool: data_load", () => {
  it("loads existing data", async () => {
    await store.save({ key: "mykey", value: 42, namespace: "ns", description: "test" });

    const tool = createDataLoadTool(store);
    const result = await tool.execute(
      { key: "mykey", namespace: "ns" },
      { cwd: "/tmp", sessionId: "s1" }
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("42");
    expect(result.content).toContain("test");
  });

  it("returns NOT_FOUND for missing key", async () => {
    const tool = createDataLoadTool(store);
    const result = await tool.execute(
      { key: "ghost" },
      { cwd: "/tmp", sessionId: "s1" }
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
  });

  it("returns error for empty key", async () => {
    const tool = createDataLoadTool(store);
    const result = await tool.execute(
      { key: "" },
      { cwd: "/tmp", sessionId: "s1" }
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
  });
});

// ── Tool Definitions — data_list ─────────────────────────────────────────────

describe("tool: data_list", () => {
  it("lists entries in a namespace", async () => {
    await store.save({ key: "a", value: 1, namespace: "test" });
    await store.save({ key: "b", value: 2, namespace: "test" });

    const tool = createDataListTool(store);
    const result = await tool.execute(
      { namespace: "test" },
      { cwd: "/tmp", sessionId: "s1" }
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("2 entries");
    expect(result.content).toContain('"a"');
    expect(result.content).toContain('"b"');
  });

  it("lists all namespaces with '*'", async () => {
    await store.save({ key: "x", value: 1, namespace: "ns1" });
    await store.save({ key: "y", value: 2, namespace: "ns2" });

    const tool = createDataListTool(store);
    const result = await tool.execute(
      { namespace: "*" },
      { cwd: "/tmp", sessionId: "s1" }
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("2 namespaces");
  });

  it("returns empty message for empty namespace", async () => {
    const tool = createDataListTool(store);
    const result = await tool.execute(
      { namespace: "empty" },
      { cwd: "/tmp", sessionId: "s1" }
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("No entries found");
  });

  it("lists default namespace when none specified", async () => {
    await store.save({ key: "d", value: "data" });

    const tool = createDataListTool(store);
    const result = await tool.execute({}, { cwd: "/tmp", sessionId: "s1" });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('"d"');
  });

  it("returns empty message when no data at all", async () => {
    const tool = createDataListTool(store);
    const result = await tool.execute(
      { namespace: "*" },
      { cwd: "/tmp", sessionId: "s1" }
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("No data stored yet");
  });
});

// ── Tool Definitions — data_delete ───────────────────────────────────────────

describe("tool: data_delete", () => {
  it("deletes an existing entry", async () => {
    await store.save({ key: "rm", value: "bye" });

    const tool = createDataDeleteTool(store);
    const result = await tool.execute(
      { key: "rm" },
      { cwd: "/tmp", sessionId: "s1" }
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Deleted");
  });

  it("returns NOT_FOUND for missing entry", async () => {
    const tool = createDataDeleteTool(store);
    const result = await tool.execute(
      { key: "ghost" },
      { cwd: "/tmp", sessionId: "s1" }
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
  });

  it("returns error for empty key", async () => {
    const tool = createDataDeleteTool(store);
    const result = await tool.execute(
      { key: "" },
      { cwd: "/tmp", sessionId: "s1" }
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
  });
});

// ── createUserDataTools ──────────────────────────────────────────────────────

describe("createUserDataTools", () => {
  it("returns all four tools", () => {
    const tools = createUserDataTools(store);
    expect(tools.dataSave.name).toBe("data_save");
    expect(tools.dataLoad.name).toBe("data_load");
    expect(tools.dataList.name).toBe("data_list");
    expect(tools.dataDelete.name).toBe("data_delete");
  });

  it("tools work end-to-end", async () => {
    const tools = createUserDataTools(store);
    const ctx = { cwd: "/tmp", sessionId: "s1" };

    // Save
    const saveResult = await tools.dataSave.execute(
      { key: "e2e", value: { test: true }, namespace: "integration" },
      ctx
    );
    expect(saveResult.ok).toBe(true);

    // Load
    const loadResult = await tools.dataLoad.execute(
      { key: "e2e", namespace: "integration" },
      ctx
    );
    expect(loadResult.ok).toBe(true);
    expect(loadResult.content).toContain("true");

    // List
    const listResult = await tools.dataList.execute(
      { namespace: "integration" },
      ctx
    );
    expect(listResult.ok).toBe(true);
    expect(listResult.content).toContain('"e2e"');

    // Delete
    const deleteResult = await tools.dataDelete.execute(
      { key: "e2e", namespace: "integration" },
      ctx
    );
    expect(deleteResult.ok).toBe(true);

    // Verify deleted
    const loadAfterDelete = await tools.dataLoad.execute(
      { key: "e2e", namespace: "integration" },
      ctx
    );
    expect(loadAfterDelete.ok).toBe(false);
    expect(loadAfterDelete.error?.code).toBe("NOT_FOUND");
  });
});

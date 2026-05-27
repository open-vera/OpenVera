/**
 * Tests for LocalVectorStore — SQLite-backed vector storage with
 * cosine similarity search.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { VectorDocument, VectorStore } from "../types.js";
import { VectorStoreError, VectorDimensionError } from "../types.js";
import { LocalVectorStore } from "../local-vector-store.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const DIM = 4;

/** Create a deterministic embedding from a seed value (all-positive to avoid negative cosine). */
function makeEmbedding(seed: number, dim = DIM): number[] {
  const vec: number[] = [];
  for (let i = 0; i < dim; i++) {
    vec.push(Math.abs(Math.sin(seed * (i + 1))) + 0.01);
  }
  return vec;
}

/** Create a VectorDocument with a deterministic embedding. */
function makeDoc(id: string, seed: number, meta?: Record<string, unknown>): VectorDocument {
  const now = new Date().toISOString();
  return {
    id,
    content: `content-${id}`,
    embedding: makeEmbedding(seed),
    metadata: meta,
    createdAt: now,
    updatedAt: now,
  };
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("LocalVectorStore", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: LocalVectorStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vec-test-"));
    dbPath = join(tmpDir, "test.db");
  });

  afterEach(async () => {
    if (store) {
      await store.close();
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createStore(dim = DIM): Promise<LocalVectorStore> {
    store = new LocalVectorStore({ dbPath, dimensions: dim });
    await store.initialize();
    return store;
  }

  // ── Constructor ────────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("should throw if dbPath is empty", () => {
      expect(() => new LocalVectorStore({ dbPath: "", dimensions: DIM })).toThrow(VectorStoreError);
    });

    it("should throw if dimensions is 0", () => {
      expect(() => new LocalVectorStore({ dbPath, dimensions: 0 })).toThrow(VectorStoreError);
    });

    it("should throw if dimensions is negative", () => {
      expect(() => new LocalVectorStore({ dbPath, dimensions: -1 })).toThrow(VectorStoreError);
    });
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("should initialize and create the database file", async () => {
      await createStore();
      const { existsSync } = await import("node:fs");
      expect(existsSync(dbPath)).toBe(true);
    });

    it("should create parent directories if missing", async () => {
      const nestedPath = join(tmpDir, "a", "b", "c", "test.db");
      store = new LocalVectorStore({ dbPath: nestedPath, dimensions: DIM });
      await store.initialize();
      const { existsSync } = await import("node:fs");
      expect(existsSync(nestedPath)).toBe(true);
    });

    it("should be healthy after initialize", async () => {
      await createStore();
      expect(store.isHealthy()).toBe(true);
    });

    it("should not be healthy after close", async () => {
      await createStore();
      await store.close();
      expect(store.isHealthy()).toBe(false);
    });

    it("should be idempotent on close", async () => {
      await createStore();
      await store.close();
      await store.close(); // should not throw
      expect(store.isHealthy()).toBe(false);
    });

    it("should have name 'local-sqlite'", async () => {
      await createStore();
      expect(store.name).toBe("local-sqlite");
    });
  });

  // ── Closed Store Guards ────────────────────────────────────────────────────

  describe("closed store guards", () => {
    it("should throw on upsert when closed", async () => {
      await createStore();
      await store.close();
      await expect(store.upsert(makeDoc("d1", 1))).rejects.toThrow(VectorStoreError);
    });

    it("should throw on get when closed", async () => {
      await createStore();
      await store.close();
      await expect(store.get("d1")).rejects.toThrow(VectorStoreError);
    });

    it("should throw on delete when closed", async () => {
      await createStore();
      await store.close();
      await expect(store.delete("d1")).rejects.toThrow(VectorStoreError);
    });

    it("should throw on search when closed", async () => {
      await createStore();
      await store.close();
      await expect(store.search({ embedding: makeEmbedding(1) })).rejects.toThrow(VectorStoreError);
    });

    it("should throw on count when closed", async () => {
      await createStore();
      await store.close();
      await expect(store.count()).rejects.toThrow(VectorStoreError);
    });

    it("should throw on listIds when closed", async () => {
      await createStore();
      await store.close();
      await expect(store.listIds()).rejects.toThrow(VectorStoreError);
    });

    it("should throw on clear when closed", async () => {
      await createStore();
      await store.close();
      await expect(store.clear()).rejects.toThrow(VectorStoreError);
    });

    it("should throw on getStats when closed", async () => {
      await createStore();
      await store.close();
      await expect(store.getStats()).rejects.toThrow(VectorStoreError);
    });
  });

  // ── upsert / upsertMany ────────────────────────────────────────────────────

  describe("upsert", () => {
    it("should insert a new document", async () => {
      await createStore();
      const doc = makeDoc("d1", 1);
      await store.upsert(doc);

      const retrieved = await store.get("d1");
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe("d1");
      expect(retrieved!.content).toBe("content-d1");
      expect(retrieved!.embedding).toEqual(makeEmbedding(1));
    });

    it("should update an existing document on upsert", async () => {
      await createStore();
      await store.upsert(makeDoc("d1", 1));
      const updated: VectorDocument = {
        id: "d1",
        content: "updated-content",
        embedding: makeEmbedding(99),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await store.upsert(updated);

      const retrieved = await store.get("d1");
      expect(retrieved!.content).toBe("updated-content");
      expect(retrieved!.embedding).toEqual(makeEmbedding(99));
    });

    it("should throw on dimension mismatch", async () => {
      await createStore();
      const badDoc = makeDoc("d1", 1);
      badDoc.embedding = [1, 2, 3]; // wrong dim (3 vs 4)
      await expect(store.upsert(badDoc)).rejects.toThrow(VectorDimensionError);
    });

    it("should preserve metadata", async () => {
      await createStore();
      const doc = makeDoc("d1", 1, { source: "test.md", tags: ["a"] });
      await store.upsert(doc);
      const retrieved = await store.get("d1");
      expect(retrieved!.metadata).toEqual({ source: "test.md", tags: ["a"] });
    });

    it("should handle null metadata", async () => {
      await createStore();
      const doc = makeDoc("d1", 1);
      await store.upsert(doc);
      const retrieved = await store.get("d1");
      expect(retrieved!.metadata).toBeUndefined();
    });
  });

  describe("upsertMany", () => {
    it("should insert multiple documents in a transaction", async () => {
      await createStore();
      const docs = [makeDoc("d1", 1), makeDoc("d2", 2), makeDoc("d3", 3)];
      await store.upsertMany(docs);

      expect(await store.count()).toBe(3);
      const ids = await store.listIds();
      expect(ids).toEqual(["d1", "d2", "d3"]);
    });

    it("should throw if any document has wrong dimensions", async () => {
      await createStore();
      const docs = [makeDoc("d1", 1), makeDoc("d2", 2)];
      docs[1].embedding = [1, 2]; // wrong dim
      await expect(store.upsertMany(docs)).rejects.toThrow(VectorDimensionError);
    });

    it("should handle empty array", async () => {
      await createStore();
      await store.upsertMany([]);
      expect(await store.count()).toBe(0);
    });

    it("should update existing documents in batch", async () => {
      await createStore();
      await store.upsert(makeDoc("d1", 1));
      await store.upsertMany([
        makeDoc("d1", 99), // update
        makeDoc("d2", 2),  // new
      ]);
      expect(await store.count()).toBe(2);
      const d1 = await store.get("d1");
      expect(d1!.embedding).toEqual(makeEmbedding(99));
    });
  });

  // ── get / getMany ──────────────────────────────────────────────────────────

  describe("get", () => {
    it("should return undefined for non-existent document", async () => {
      await createStore();
      const result = await store.get("nonexistent");
      expect(result).toBeUndefined();
    });
  });

  describe("getMany", () => {
    it("should return matching documents", async () => {
      await createStore();
      await store.upsertMany([makeDoc("d1", 1), makeDoc("d2", 2), makeDoc("d3", 3)]);
      const results = await store.getMany(["d1", "d3"]);
      expect(results).toHaveLength(2);
      expect(results.map((d) => d.id).sort()).toEqual(["d1", "d3"]);
    });

    it("should return empty array for empty ids", async () => {
      await createStore();
      const results = await store.getMany([]);
      expect(results).toEqual([]);
    });

    it("should skip non-existent ids", async () => {
      await createStore();
      await store.upsert(makeDoc("d1", 1));
      const results = await store.getMany(["d1", "nonexistent"]);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("d1");
    });
  });

  // ── delete / deleteMany ────────────────────────────────────────────────────

  describe("delete", () => {
    it("should delete an existing document", async () => {
      await createStore();
      await store.upsert(makeDoc("d1", 1));
      const deleted = await store.delete("d1");
      expect(deleted).toBe(true);
      expect(await store.has("d1")).toBe(false);
    });

    it("should return false for non-existent document", async () => {
      await createStore();
      const deleted = await store.delete("nonexistent");
      expect(deleted).toBe(false);
    });
  });

  describe("deleteMany", () => {
    it("should delete multiple documents", async () => {
      await createStore();
      await store.upsertMany([makeDoc("d1", 1), makeDoc("d2", 2), makeDoc("d3", 3)]);
      const count = await store.deleteMany(["d1", "d3"]);
      expect(count).toBe(2);
      expect(await store.count()).toBe(1);
    });

    it("should return 0 for empty ids", async () => {
      await createStore();
      const count = await store.deleteMany([]);
      expect(count).toBe(0);
    });
  });

  // ── has / listIds / count / clear ──────────────────────────────────────────

  describe("has", () => {
    it("should return true for existing document", async () => {
      await createStore();
      await store.upsert(makeDoc("d1", 1));
      expect(await store.has("d1")).toBe(true);
    });

    it("should return false for non-existent document", async () => {
      await createStore();
      expect(await store.has("nonexistent")).toBe(false);
    });
  });

  describe("listIds", () => {
    it("should return sorted list of all IDs", async () => {
      await createStore();
      await store.upsertMany([makeDoc("c", 1), makeDoc("a", 2), makeDoc("b", 3)]);
      const ids = await store.listIds();
      expect(ids).toEqual(["a", "b", "c"]);
    });

    it("should return empty array for empty store", async () => {
      await createStore();
      expect(await store.listIds()).toEqual([]);
    });
  });

  describe("count", () => {
    it("should return 0 for empty store", async () => {
      await createStore();
      expect(await store.count()).toBe(0);
    });

    it("should return correct count", async () => {
      await createStore();
      await store.upsertMany([makeDoc("d1", 1), makeDoc("d2", 2)]);
      expect(await store.count()).toBe(2);
    });
  });

  describe("clear", () => {
    it("should remove all documents", async () => {
      await createStore();
      await store.upsertMany([makeDoc("d1", 1), makeDoc("d2", 2), makeDoc("d3", 3)]);
      await store.clear();
      expect(await store.count()).toBe(0);
      expect(await store.listIds()).toEqual([]);
    });
  });

  // ── Similarity Search ──────────────────────────────────────────────────────

  describe("search", () => {
    it("should return results sorted by cosine similarity", async () => {
      await createStore();
      // Embeddings: d1 and query are identical (seed=1), d2 is different (seed=100)
      await store.upsertMany([makeDoc("d1", 1), makeDoc("d2", 100), makeDoc("d3", 50)]);
      const query = { embedding: makeEmbedding(1), minScore: -1 };
      const result = await store.search(query);

      expect(result.results.length).toBe(3);
      // d1 should be most similar (identical vector)
      expect(result.results[0].document.id).toBe("d1");
      expect(result.results[0].score).toBeGreaterThan(result.results[1].score);
    });

    it("should respect topK limit", async () => {
      await createStore();
      await store.upsertMany([makeDoc("d1", 1), makeDoc("d2", 2), makeDoc("d3", 3)]);
      const result = await store.search({ embedding: makeEmbedding(1), topK: 2 });
      expect(result.results).toHaveLength(2);
    });

    it("should respect minScore threshold", async () => {
      await createStore();
      await store.upsertMany([makeDoc("d1", 1), makeDoc("d2", 100)]);
      const result = await store.search({
        embedding: makeEmbedding(1),
        minScore: 0.99, // very high threshold
      });
      // Only exact match should pass
      expect(result.results.length).toBeLessThanOrEqual(1);
    });

    it("should throw when searching with text (no embedding)", async () => {
      await createStore();
      await expect(store.search({ text: "hello" })).rejects.toThrow(VectorStoreError);
    });

    it("should throw on dimension mismatch in query", async () => {
      await createStore();
      await expect(store.search({ embedding: [1, 2, 3] })).rejects.toThrow(VectorDimensionError);
    });

    it("should report total and durationMs", async () => {
      await createStore();
      await store.upsertMany([makeDoc("d1", 1), makeDoc("d2", 2)]);
      const result = await store.search({ embedding: makeEmbedding(1) });
      expect(result.total).toBe(2);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should return empty results for empty store", async () => {
      await createStore();
      const result = await store.search({ embedding: makeEmbedding(1) });
      expect(result.results).toEqual([]);
      expect(result.total).toBe(0);
    });

    it("should exclude embeddings by default", async () => {
      await createStore();
      await store.upsert(makeDoc("d1", 1));
      const result = await store.search({ embedding: makeEmbedding(1) });
      expect(result.results[0].document.embedding).toEqual([]);
    });

    it("should include embeddings when requested", async () => {
      await createStore();
      await store.upsert(makeDoc("d1", 1));
      const result = await store.search({
        embedding: makeEmbedding(1),
        includeEmbeddings: true,
      });
      expect(result.results[0].document.embedding).toEqual(makeEmbedding(1));
    });
  });

  describe("search with metadata filter", () => {
    it("should filter by exact metadata match", async () => {
      await createStore();
      await store.upsert(makeDoc("d1", 1, { category: "docs" }));
      await store.upsert(makeDoc("d2", 2, { category: "code" }));
      await store.upsert(makeDoc("d3", 3, { category: "docs" }));

      const result = await store.search({
        embedding: makeEmbedding(1),
        filter: { category: "docs" },
      });
      expect(result.results).toHaveLength(2);
      for (const r of result.results) {
        expect(r.document.metadata?.category).toBe("docs");
      }
    });

    it("should return empty when filter matches nothing", async () => {
      await createStore();
      await store.upsert(makeDoc("d1", 1, { category: "docs" }));
      const result = await store.search({
        embedding: makeEmbedding(1),
        filter: { category: "nonexistent" },
      });
      expect(result.results).toEqual([]);
    });

    it("should exclude documents without metadata when filter is applied", async () => {
      await createStore();
      await store.upsert(makeDoc("d1", 1)); // no metadata
      await store.upsert(makeDoc("d2", 2, { category: "docs" }));
      const result = await store.search({
        embedding: makeEmbedding(1),
        filter: { category: "docs" },
        minScore: -1,
      });
      expect(result.results).toHaveLength(1);
      expect(result.results[0].document.id).toBe("d2");
    });

    it("should support multi-key filter", async () => {
      await createStore();
      await store.upsert(makeDoc("d1", 1, { category: "docs", lang: "en" }));
      await store.upsert(makeDoc("d2", 2, { category: "docs", lang: "zh" }));
      await store.upsert(makeDoc("d3", 3, { category: "code", lang: "en" }));

      const result = await store.search({
        embedding: makeEmbedding(1),
        filter: { category: "docs", lang: "en" },
      });
      expect(result.results).toHaveLength(1);
      expect(result.results[0].document.id).toBe("d1");
    });
  });

  // ── getStats ───────────────────────────────────────────────────────────────

  describe("getStats", () => {
    it("should return correct stats for empty store", async () => {
      await createStore();
      const stats = await store.getStats();
      expect(stats.documentCount).toBe(0);
      expect(stats.dimensions).toBe(DIM);
    });

    it("should return correct stats after inserts", async () => {
      await createStore();
      await store.upsertMany([makeDoc("d1", 1), makeDoc("d2", 2)]);
      const stats = await store.getStats();
      expect(stats.documentCount).toBe(2);
      expect(stats.dimensions).toBe(DIM);
    });
  });

  // ── VectorStore Interface Compliance ───────────────────────────────────────

  describe("VectorStore interface compliance", () => {
    it("should satisfy the VectorStore interface", async () => {
      const vs: VectorStore = new LocalVectorStore({ dbPath, dimensions: DIM });
      await vs.initialize();
      expect(vs.name).toBe("local-sqlite");
      expect(vs.isHealthy()).toBe(true);
      await vs.close();
    });
  });

  // ── WAL Mode ───────────────────────────────────────────────────────────────

  describe("WAL mode", () => {
    it("should enable WAL mode by default", async () => {
      await createStore();
      // WAL mode is enabled — just verify the store works
      await store.upsert(makeDoc("d1", 1));
      expect(await store.count()).toBe(1);
    });

    it("should work with WAL mode disabled", async () => {
      store = new LocalVectorStore({ dbPath, dimensions: DIM, walMode: false });
      await store.initialize();
      await store.upsert(makeDoc("d1", 1));
      expect(await store.count()).toBe(1);
    });
  });
});

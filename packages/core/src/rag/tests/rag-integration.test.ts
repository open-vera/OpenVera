/**
 * RAG Integration Tests — End-to-end pipeline tests.
 *
 * Tests the full flow: document loading → embedding → vector indexing → search.
 * Uses LocalVectorStore + LocalEmbeddingAdapter (no external dependencies).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalVectorStore } from "../local-vector-store.js";
import { LocalEmbeddingAdapter } from "../embedding-adapter.js";
import { DocumentLoader } from "../document-loader.js";
import { IncrementalIndexer } from "../incremental-indexer.js";
import type { VectorDocument } from "../types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rag-e2e-"));
}

function writeFile(dir: string, relPath: string, content: string): void {
  const fullPath = join(dir, relPath);
  const dirName = fullPath.substring(0, fullPath.lastIndexOf("/"));
  mkdirSync(dirName, { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("RAG Integration", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: LocalVectorStore;
  let adapter: LocalEmbeddingAdapter;

  beforeEach(async () => {
    tmpDir = createTmpDir();
    dbPath = join(tmpDir, "rag.db");
    store = new LocalVectorStore({ dbPath, dimensions: 384 });
    await store.initialize();
    adapter = new LocalEmbeddingAdapter({ dimensions: 384 });
    await adapter.initialize();
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Full Pipeline ──────────────────────────────────────────────────────────

  describe("full pipeline", () => {
    it("should load, embed, index, and search documents", async () => {
      // Create test files
      writeFile(tmpDir, "typescript.md", "TypeScript is a typed superset of JavaScript that compiles to plain JS.");
      writeFile(tmpDir, "python.md", "Python is a high-level programming language with dynamic typing.");
      writeFile(tmpDir, "rust.md", "Rust is a systems programming language focused on safety and performance.");

      // Load documents
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const loadResult = loader.load();
      expect(loadResult.filesLoaded).toBe(3);

      // Embed and index
      const texts = loadResult.documents.map((d) => d.content);
      const embeddings = await adapter.embedBatch(texts);

      const docs: VectorDocument[] = loadResult.documents.map((input, i) => ({
        id: input.id ?? `doc-${i}`,
        content: input.content,
        embedding: embeddings[i],
        metadata: input.metadata,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      await store.upsertMany(docs);
      expect(await store.count()).toBe(loadResult.documents.length);

      // Search
      const queryEmbedding = await adapter.embed("typed programming language");
      const searchResult = await store.search({
        embedding: queryEmbedding,
        topK: 3,
      });

      expect(searchResult.results.length).toBeGreaterThan(0);
      // TypeScript should rank high for "typed programming language"
      const topSources = searchResult.results.map(
        (r) => r.document.metadata?.source as string,
      );
      expect(topSources.some((s) => s?.includes("typescript"))).toBe(true);
    });

    it("should handle documents with metadata filtering", async () => {
      writeFile(tmpDir, "guide.md", "# User Guide\n\nHow to use the application.");
      writeFile(tmpDir, "api.md", "# API Reference\n\nEndpoint documentation.");
      writeFile(tmpDir, "changelog.md", "# Changelog\n\nVersion history and updates.");

      const loader = new DocumentLoader({ rootDir: tmpDir });
      const loadResult = loader.load();

      const texts = loadResult.documents.map((d) => d.content);
      const embeddings = await adapter.embedBatch(texts);

      const docs: VectorDocument[] = loadResult.documents.map((input, i) => ({
        id: input.id ?? `doc-${i}`,
        content: input.content,
        embedding: embeddings[i],
        metadata: { ...input.metadata, category: i === 0 ? "docs" : "reference" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      await store.upsertMany(docs);

      // Search with filter
      const queryEmbedding = await adapter.embed("how to use");
      const result = await store.search({
        embedding: queryEmbedding,
        filter: { category: "docs" },
      });

      expect(result.results.length).toBeGreaterThan(0);
      for (const r of result.results) {
        expect(r.document.metadata?.category).toBe("docs");
      }
    });

    it("should support incremental indexing", async () => {
      writeFile(tmpDir, "doc1.md", "Initial document about algorithms.");
      writeFile(tmpDir, "doc2.md", "Document about data structures.");

      const loader = new DocumentLoader({ rootDir: tmpDir });
      const indexer = new IncrementalIndexer({
        vectorStore: store,
        embeddingAdapter: adapter,
        documentLoader: loader,
        rootDir: tmpDir,
      });

      // Full index
      const fullResult = await indexer.fullIndex();
      expect(fullResult.filesIndexed).toBe(2);
      const count1 = await store.count();

      // Add a new file
      writeFile(tmpDir, "doc3.md", "New document about machine learning.");
      const incrResult = await indexer.incrementalIndex();
      expect(incrResult.filesIndexed).toBe(1);

      const count2 = await store.count();
      expect(count2).toBeGreaterThan(count1);
    });
  });

  // ── Embedding Adapter ──────────────────────────────────────────────────────

  describe("embedding adapter", () => {
    it("should produce consistent embeddings for the same text", async () => {
      const text = "Consistent embedding test";
      const vec1 = await adapter.embed(text);
      const vec2 = await adapter.embed(text);
      expect(vec1).toEqual(vec2);
    });

    it("should produce different embeddings for different texts", async () => {
      const vec1 = await adapter.embed("machine learning");
      const vec2 = await adapter.embed("cooking recipes");
      // Vectors should be different
      const dot = vec1.reduce((sum, v, i) => sum + v * vec2[i], 0);
      // Dot product of normalized vectors with different content should not be 1
      expect(dot).toBeLessThan(0.99);
    });

    it("should embed batches correctly", async () => {
      const texts = ["hello", "world", "test"];
      const vecs = await adapter.embedBatch(texts);
      expect(vecs).toHaveLength(3);
      for (const vec of vecs) {
        expect(vec).toHaveLength(384);
      }
    });
  });

  // ── Vector Store ───────────────────────────────────────────────────────────

  describe("vector store", () => {
    it("should persist data across store instances", async () => {
      const doc: VectorDocument = {
        id: "persist-test",
        content: "This should persist.",
        embedding: await adapter.embed("This should persist"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await store.upsert(doc);
      await store.close();

      // Reopen
      const store2 = new LocalVectorStore({ dbPath, dimensions: 384 });
      await store2.initialize();
      const retrieved = await store2.get("persist-test");
      expect(retrieved).toBeDefined();
      expect(retrieved!.content).toBe("This should persist.");
      await store2.close();
    });

    it("should handle large batches", async () => {
      const docs: VectorDocument[] = [];
      for (let i = 0; i < 100; i++) {
        docs.push({
          id: `batch-${i}`,
          content: `Document number ${i} about topic ${i % 10}`,
          embedding: await adapter.embed(`Document about topic ${i % 10}`),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
      await store.upsertMany(docs);
      expect(await store.count()).toBe(100);

      // Search should work
      const query = await adapter.embed("topic 5");
      const result = await store.search({ embedding: query, topK: 5 });
      expect(result.results.length).toBe(5);
    });
  });

  // ── Document Loader ────────────────────────────────────────────────────────

  describe("document loader", () => {
    it("should chunk large documents correctly", async () => {
      const longContent = "This is a sentence about testing. ".repeat(50);
      writeFile(tmpDir, "long.md", longContent);

      const loader = new DocumentLoader({
        rootDir: tmpDir,
        chunkSize: 500,
        chunkOverlap: 50,
      });
      const result = loader.load();

      expect(result.chunksProduced).toBeGreaterThan(1);
      // All chunks should have proper metadata
      for (const doc of result.documents) {
        expect(doc.metadata?.fileType).toBe("markdown");
        expect(doc.metadata?.source).toBe("long.md");
        expect(typeof doc.metadata?.chunkIndex).toBe("number");
      }
    });

    it("should exclude patterns correctly", async () => {
      writeFile(tmpDir, "src/code.ts", "const x = 1;");
      writeFile(tmpDir, "node_modules/pkg/index.ts", "module.exports = {};");
      writeFile(tmpDir, "dist/bundle.js", "console.log('built');");

      const loader = new DocumentLoader({
        rootDir: tmpDir,
        exclude: ["node_modules", "dist"],
      });
      const result = loader.load();

      expect(result.filesLoaded).toBe(1);
      expect(result.documents[0].metadata?.source).toBe("src/code.ts");
    });
  });
});

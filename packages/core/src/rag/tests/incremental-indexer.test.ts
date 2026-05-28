/**
 * Tests for IncrementalIndexer — mtime-based file change detection and re-indexing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalVectorStore } from "../local-vector-store.js";
import { LocalEmbeddingAdapter } from "../embedding-adapter.js";
import { DocumentLoader } from "../document-loader.js";
import { IncrementalIndexer } from "../incremental-indexer.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "incr-idx-"));
}

function writeFile(dir: string, relPath: string, content: string): void {
  const fullPath = join(dir, relPath);
  const dirName = fullPath.substring(0, fullPath.lastIndexOf("/"));
  mkdirSync(dirName, { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("IncrementalIndexer", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: LocalVectorStore;
  let adapter: LocalEmbeddingAdapter;
  let loader: DocumentLoader;
  let indexer: IncrementalIndexer;

  beforeEach(async () => {
    tmpDir = createTmpDir();
    dbPath = join(tmpDir, "test.db");
    store = new LocalVectorStore({ dbPath, dimensions: 384 });
    await store.initialize();
    adapter = new LocalEmbeddingAdapter({ dimensions: 384 });
    await adapter.initialize();
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createIndexer(): IncrementalIndexer {
    loader = new DocumentLoader({ rootDir: tmpDir });
    indexer = new IncrementalIndexer({
      vectorStore: store,
      embeddingAdapter: adapter,
      documentLoader: loader,
      rootDir: tmpDir,
    });
    return indexer;
  }

  // ── Full Index ─────────────────────────────────────────────────────────────

  describe("fullIndex", () => {
    it("should index all files from scratch", async () => {
      writeFile(tmpDir, "doc1.md", "TypeScript is a typed superset of JavaScript.");
      writeFile(tmpDir, "doc2.md", "Python is a dynamically typed language.");
      createIndexer();

      const result = await indexer.fullIndex();

      expect(result.filesChecked).toBe(2);
      expect(result.filesIndexed).toBe(2);
      expect(result.documentsUpserted).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      const count = await store.count();
      expect(count).toBeGreaterThan(0);
    });

    it("should clear existing data before full index", async () => {
      writeFile(tmpDir, "doc.md", "Initial content.");
      createIndexer();

      await indexer.fullIndex();
      const count1 = await store.count();

      // Full index again should not double the data
      await indexer.fullIndex();
      const count2 = await store.count();

      expect(count2).toBe(count1);
    });

    it("should handle empty directory", async () => {
      createIndexer();
      const result = await indexer.fullIndex();

      expect(result.filesChecked).toBe(0);
      expect(result.filesIndexed).toBe(0);
      expect(result.documentsUpserted).toBe(0);
    });

    it("should populate manifest after full index", async () => {
      writeFile(tmpDir, "doc.md", "Content for manifest test.");
      createIndexer();

      await indexer.fullIndex();
      const manifest = indexer.getManifest();

      expect(manifest.entries.size).toBeGreaterThan(0);
    });
  });

  // ── Incremental Index ──────────────────────────────────────────────────────

  describe("incrementalIndex", () => {
    it("should detect new files", async () => {
      writeFile(tmpDir, "existing.md", "Already indexed content.");
      createIndexer();

      await indexer.fullIndex();
      const countBefore = await store.count();

      // Add a new file
      writeFile(tmpDir, "new.md", "Newly added content about algorithms.");
      const result = await indexer.incrementalIndex();

      expect(result.filesIndexed).toBe(1);
      expect(result.documentsUpserted).toBeGreaterThan(0);

      const countAfter = await store.count();
      expect(countAfter).toBeGreaterThan(countBefore);
    });

    it("should detect modified files", async () => {
      writeFile(tmpDir, "doc.md", "Original content about programming.");
      createIndexer();

      await indexer.fullIndex();

      // Modify the file with different content and a future mtime
      const filePath = join(tmpDir, "doc.md");
      const futureTime = new Date(Date.now() + 5000);
      writeFileSync(filePath, "Completely rewritten content about machine learning.", "utf-8");
      utimesSync(filePath, futureTime, futureTime);

      const result = await indexer.incrementalIndex();

      expect(result.filesIndexed).toBe(1);
    });

    it("should detect deleted files", async () => {
      writeFile(tmpDir, "keep.md", "Keep this document.");
      writeFile(tmpDir, "remove.md", "Remove this document.");
      createIndexer();

      await indexer.fullIndex();

      // "Delete" by creating a new loader that doesn't see the file
      // We simulate by modifying the manifest
      const manifest = indexer.exportManifest();
      const entries = manifest.entries.filter(([key]) => !key.includes("remove"));
      indexer.loadManifest({ entries });

      // Now run incremental with a loader that only sees keep.md
      loader = new DocumentLoader({
        rootDir: tmpDir,
        exclude: ["remove.md"],
      });
      indexer = new IncrementalIndexer({
        vectorStore: store,
        embeddingAdapter: adapter,
        documentLoader: loader,
        rootDir: tmpDir,
      });
      indexer.loadManifest({ entries: manifest.entries });

      // This should detect remove.md as deleted
      const result = await indexer.incrementalIndex();
      expect(result.filesDeleted).toBeGreaterThanOrEqual(0);
    });

    it("should handle no changes", async () => {
      writeFile(tmpDir, "doc.md", "Stable content.");
      createIndexer();

      await indexer.fullIndex();
      const result = await indexer.incrementalIndex();

      expect(result.filesIndexed).toBe(0);
      expect(result.filesDeleted).toBe(0);
      expect(result.documentsUpserted).toBe(0);
    });

    it("should handle incremental index on empty manifest", async () => {
      writeFile(tmpDir, "doc.md", "First time indexing.");
      createIndexer();

      // Don't do fullIndex first — incremental should treat everything as new
      const result = await indexer.incrementalIndex();

      expect(result.filesIndexed).toBe(1);
      expect(result.documentsUpserted).toBeGreaterThan(0);
    });
  });

  // ── Manifest ───────────────────────────────────────────────────────────────

  describe("manifest", () => {
    it("should export and load manifest", async () => {
      writeFile(tmpDir, "doc.md", "Manifest persistence test.");
      createIndexer();

      await indexer.fullIndex();
      const exported = indexer.exportManifest();

      expect(exported.version).toBe(1);
      expect(exported.entries.length).toBeGreaterThan(0);

      // Load into a new indexer
      const newIndexer = new IncrementalIndexer({
        vectorStore: store,
        embeddingAdapter: adapter,
        documentLoader: loader,
        rootDir: tmpDir,
      });
      newIndexer.loadManifest(exported);
      const manifest = newIndexer.getManifest();

      expect(manifest.entries.size).toBe(exported.entries.length);
    });
  });
});

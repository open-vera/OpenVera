/**
 * Incremental Indexer — Update vector index when source files change.
 *
 * Uses file modification time (mtime) to detect changes and only re-indexes
 * files that have been added or modified since the last indexing run.
 * Supports full re-index and incremental update modes.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import type { VectorStore, VectorDocument, EmbeddingAdapter } from "./types.js";
import type { DocumentLoader } from "./document-loader.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface IndexManifestEntry {
  filePath: string;
  mtimeMs: number;
  docIds: string[];
}

export interface IndexManifest {
  version: number;
  entries: Map<string, IndexManifestEntry>;
}

export interface IndexResult {
  /** Number of files checked */
  filesChecked: number;
  /** Number of files added or updated */
  filesIndexed: number;
  /** Number of files deleted from index */
  filesDeleted: number;
  /** Total documents upserted */
  documentsUpserted: number;
  /** Duration in milliseconds */
  durationMs: number;
}

export interface IncrementalIndexerOptions {
  /** The vector store to index into */
  vectorStore: VectorStore;
  /** The embedding adapter to compute vectors */
  embeddingAdapter: EmbeddingAdapter;
  /** The document loader to scan and chunk files */
  documentLoader: DocumentLoader;
  /** Root directory for resolving relative paths (for mtime stat) */
  rootDir?: string;
}

// ── Incremental Indexer ──────────────────────────────────────────────────────

export class IncrementalIndexer {
  private store: VectorStore;
  private adapter: EmbeddingAdapter;
  private loader: DocumentLoader;
  private rootDir: string;
  private manifest: IndexManifest;

  constructor(options: IncrementalIndexerOptions) {
    this.store = options.vectorStore;
    this.adapter = options.embeddingAdapter;
    this.loader = options.documentLoader;
    this.rootDir = options.rootDir ?? process.cwd();
    this.manifest = { version: 1, entries: new Map() };
  }

  /**
   * Full re-index: clear the store and index all files from scratch.
   */
  async fullIndex(): Promise<IndexResult> {
    const start = performance.now();
    await this.store.clear();
    this.manifest.entries.clear();

    const loadResult = this.loader.load();
    let documentsUpserted = 0;

    // Process documents in batches of 50
    const batchSize = 50;
    for (let i = 0; i < loadResult.documents.length; i += batchSize) {
      const batch = loadResult.documents.slice(i, i + batchSize);
      const texts = batch.map((d) => d.content);
      const embeddings = await this.adapter.embedBatch(texts);

      const docs: VectorDocument[] = batch.map((input, j) => ({
        id: input.id ?? `doc-${i + j}`,
        content: input.content,
        embedding: embeddings[j],
        metadata: input.metadata,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      await this.store.upsertMany(docs);
      documentsUpserted += docs.length;
    }

    // Build manifest from loaded files
    const fileDocIds = new Map<string, string[]>();
    for (const doc of loadResult.documents) {
      const source = (doc.metadata?.source as string) ?? doc.id;
      const id = doc.id ?? "unknown";
      if (!fileDocIds.has(source)) fileDocIds.set(source, []);
      fileDocIds.get(source)!.push(id);
    }
    for (const [source, docIds] of fileDocIds) {
      const absPath = join(this.rootDir, source);
      let mtimeMs = Date.now();
      try {
        const stat = statSync(absPath);
        mtimeMs = stat.mtimeMs;
      } catch {
        // If stat fails, use current time
      }
      this.manifest.entries.set(source, {
        filePath: source,
        mtimeMs,
        docIds,
      });
    }

    return {
      filesChecked: loadResult.filesScanned,
      filesIndexed: loadResult.filesLoaded,
      filesDeleted: 0,
      documentsUpserted,
      durationMs: performance.now() - start,
    };
  }

  /**
   * Incremental index: only re-index files that changed since last run.
   */
  async incrementalIndex(): Promise<IndexResult> {
    const start = performance.now();
    const loadResult = this.loader.load();

    // Group documents by source file
    const fileDocs = new Map<string, typeof loadResult.documents>();
    for (const doc of loadResult.documents) {
      const source = (doc.metadata?.source as string) ?? doc.id;
      if (!fileDocs.has(source)) fileDocs.set(source, []);
      fileDocs.get(source)!.push(doc);
    }

    const currentFiles = new Set(fileDocs.keys());
    const previousFiles = new Set(this.manifest.entries.keys());

    // Detect changes
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    for (const file of currentFiles) {
      const existing = this.manifest.entries.get(file);
      if (!existing) {
        added.push(file);
      } else {
        try {
          const absPath = join(this.rootDir, file);
          const stat = statSync(absPath);
          if (stat.mtimeMs > existing.mtimeMs) {
            modified.push(file);
          }
        } catch {
          modified.push(file);
        }
      }
    }

    for (const file of previousFiles) {
      if (!currentFiles.has(file)) {
        deleted.push(file);
      }
    }

    // Delete removed files from index
    for (const file of deleted) {
      const entry = this.manifest.entries.get(file);
      if (entry) {
        await this.store.deleteMany(entry.docIds);
        this.manifest.entries.delete(file);
      }
    }

    // Re-index added and modified files
    const toIndex = [...added, ...modified];
    let documentsUpserted = 0;

    for (const file of toIndex) {
      const docs = fileDocs.get(file);
      if (!docs || docs.length === 0) continue;

      // Delete old documents for this file
      const existing = this.manifest.entries.get(file);
      if (existing) {
        await this.store.deleteMany(existing.docIds);
      }

      // Compute embeddings and upsert
      const texts = docs.map((d) => d.content);
      const embeddings = await this.adapter.embedBatch(texts);

      const vectorDocs: VectorDocument[] = docs.map((input, j) => ({
        id: input.id ?? `doc-${j}`,
        content: input.content,
        embedding: embeddings[j],
        metadata: input.metadata,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      await this.store.upsertMany(vectorDocs);
      documentsUpserted += vectorDocs.length;

      // Update manifest
      try {
        const absPath = join(this.rootDir, file);
        const stat = statSync(absPath);
        this.manifest.entries.set(file, {
          filePath: file,
          mtimeMs: stat.mtimeMs,
          docIds: vectorDocs.map((d) => d.id),
        });
      } catch {
        // If stat fails, just record the docs
        this.manifest.entries.set(file, {
          filePath: file,
          mtimeMs: Date.now(),
          docIds: vectorDocs.map((d) => d.id),
        });
      }
    }

    return {
      filesChecked: loadResult.filesScanned,
      filesIndexed: toIndex.length,
      filesDeleted: deleted.length,
      documentsUpserted,
      durationMs: performance.now() - start,
    };
  }

  /**
   * Get the current index manifest (for inspection/debugging).
   */
  getManifest(): IndexManifest {
    return this.manifest;
  }

  /**
   * Load a manifest from a previously saved state.
   */
  loadManifest(data: { version?: number; entries: Array<[string, IndexManifestEntry]> }): void {
    this.manifest = {
      version: data.version ?? 1,
      entries: new Map(data.entries),
    };
  }

  /**
   * Export the manifest for persistence.
   */
  exportManifest(): { version: number; entries: Array<[string, IndexManifestEntry]> } {
    return {
      version: this.manifest.version,
      entries: Array.from(this.manifest.entries.entries()),
    };
  }

}

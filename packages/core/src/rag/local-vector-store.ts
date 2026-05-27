/**
 * Local vector store backed by SQLite (better-sqlite3).
 *
 * Stores embeddings as binary BLOBs (Float64Array) and precomputes L2 norms
 * for fast cosine-similarity search.  No external vector index library needed;
 * brute-force scan is used — adequate for <100k documents.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  VectorDocument,
  VectorQuery,
  VectorQueryResult,
  VectorSearchResult,
  VectorIndexStats,
  VectorStore,
} from "./types.js";
import {
  VectorStoreError,
  VectorDimensionError,
} from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a number[] to a compact binary buffer (Float64). */
function embeddingToBuffer(vec: number[]): Buffer {
  const f64 = new Float64Array(vec);
  return Buffer.from(f64.buffer);
}

/** Decode a binary buffer back to number[]. */
function bufferToEmbedding(buf: Buffer): number[] {
  const f64 = new Float64Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float64Array.BYTES_PER_ELEMENT,
  );
  return Array.from(f64);
}

/** Compute the L2 norm of a vector. */
function l2norm(vec: number[]): number {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  return Math.sqrt(sum);
}

/** Cosine similarity between two vectors given their precomputed norms. */
function cosineSimilarity(a: number[], b: number[], normA: number, normB: number): number {
  if (normA === 0 || normB === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (normA * normB);
}

// ── SQLite Row Type ─────────────────────────────────────────────────────────

interface VecRow {
  id: string;
  content: string;
  embedding: Buffer;
  norm: number;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

// ── Implementation ───────────────────────────────────────────────────────────

export interface LocalVectorStoreOptions {
  /** Path to the SQLite database file */
  dbPath: string;
  /** Expected embedding dimensionality (validated on insert) */
  dimensions: number;
  /** Enable WAL mode (default: true) */
  walMode?: boolean;
}

export class LocalVectorStore implements VectorStore {
  readonly name = "local-sqlite";

  private db!: Database.Database;
  private dbPath: string;
  private dim: number;
  private walMode: boolean;
  private closed = false;

  private stmts!: {
    upsert: Database.Statement;
    get: Database.Statement;
    getMany: Database.Statement;
    del: Database.Statement;
    delMany: Database.Statement;
    has: Database.Statement;
    listIds: Database.Statement;
    countAll: Database.Statement;
    clearAll: Database.Statement;
    allDocs: Database.Statement;
  };

  constructor(options: LocalVectorStoreOptions) {
    if (!options.dbPath) {
      throw new VectorStoreError("dbPath is required");
    }
    if (!options.dimensions || options.dimensions <= 0) {
      throw new VectorStoreError("dimensions must be a positive integer");
    }
    this.dbPath = options.dbPath;
    this.dim = options.dimensions;
    this.walMode = options.walMode ?? true;
  }

  async initialize(): Promise<void> {
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);

    if (this.walMode) {
      this.db.pragma("journal_mode = WAL");
    }
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vec_documents (
        id         TEXT PRIMARY KEY,
        content    TEXT NOT NULL,
        embedding  BLOB NOT NULL,
        norm       REAL NOT NULL,
        metadata   TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vec_created ON vec_documents(created_at);
    `);

    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmts = {
      upsert: this.db.prepare(`
        INSERT INTO vec_documents (id, content, embedding, norm, metadata, created_at, updated_at)
        VALUES (@id, @content, @embedding, @norm, @metadata, @createdAt, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET
          content = @content, embedding = @embedding, norm = @norm,
          metadata = @metadata, updated_at = @updatedAt
      `),
      get: this.db.prepare(`SELECT * FROM vec_documents WHERE id = ?`),
      getMany: this.db.prepare(`SELECT * FROM vec_documents WHERE id IN (SELECT value FROM json_each(?))`),
      del: this.db.prepare(`DELETE FROM vec_documents WHERE id = ?`),
      delMany: this.db.prepare(`DELETE FROM vec_documents WHERE id IN (SELECT value FROM json_each(?))`),
      has: this.db.prepare(`SELECT 1 FROM vec_documents WHERE id = ?`),
      listIds: this.db.prepare(`SELECT id FROM vec_documents ORDER BY id`),
      countAll: this.db.prepare(`SELECT COUNT(*) as cnt FROM vec_documents`),
      clearAll: this.db.prepare(`DELETE FROM vec_documents`),
      allDocs: this.db.prepare(`SELECT * FROM vec_documents`),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  isHealthy(): boolean {
    return !this.closed;
  }

  // ── Document Operations ────────────────────────────────────────────────────

  async upsert(doc: VectorDocument): Promise<void> {
    this.ensureOpen();
    this.validateDimension(doc.embedding, doc.id);

    const now = new Date().toISOString();
    try {
      this.stmts.upsert.run({
        id: doc.id,
        content: doc.content,
        embedding: embeddingToBuffer(doc.embedding),
        norm: l2norm(doc.embedding),
        metadata: doc.metadata ? JSON.stringify(doc.metadata) : null,
        createdAt: doc.createdAt ?? now,
        updatedAt: now,
      });
    } catch (err) {
      throw new VectorStoreError(`upsert failed: ${String(err)}`, { cause: err });
    }
  }

  async upsertMany(docs: VectorDocument[]): Promise<void> {
    this.ensureOpen();
    for (const doc of docs) this.validateDimension(doc.embedding, doc.id);

    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      for (const doc of docs) {
        this.stmts.upsert.run({
          id: doc.id,
          content: doc.content,
          embedding: embeddingToBuffer(doc.embedding),
          norm: l2norm(doc.embedding),
          metadata: doc.metadata ? JSON.stringify(doc.metadata) : null,
          createdAt: doc.createdAt ?? now,
          updatedAt: now,
        });
      }
    });
    try {
      tx();
    } catch (err) {
      throw new VectorStoreError(`upsertMany failed: ${String(err)}`, { cause: err });
    }
  }

  async get(id: string): Promise<VectorDocument | undefined> {
    this.ensureOpen();
    const row = this.stmts.get.get(id) as VecRow | undefined;
    return row ? this.rowToDoc(row) : undefined;
  }

  async getMany(ids: string[]): Promise<VectorDocument[]> {
    this.ensureOpen();
    if (ids.length === 0) return [];
    const rows = this.stmts.getMany.all(JSON.stringify(ids)) as VecRow[];
    return rows.map((r) => this.rowToDoc(r));
  }

  async delete(id: string): Promise<boolean> {
    this.ensureOpen();
    return this.stmts.del.run(id).changes > 0;
  }

  async deleteMany(ids: string[]): Promise<number> {
    this.ensureOpen();
    if (ids.length === 0) return 0;
    return this.stmts.delMany.run(JSON.stringify(ids)).changes;
  }

  async has(id: string): Promise<boolean> {
    this.ensureOpen();
    return this.stmts.has.get(id) !== undefined;
  }

  async listIds(): Promise<string[]> {
    this.ensureOpen();
    const rows = this.stmts.listIds.all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  async count(): Promise<number> {
    this.ensureOpen();
    return (this.stmts.countAll.get() as { cnt: number }).cnt;
  }

  async clear(): Promise<void> {
    this.ensureOpen();
    this.stmts.clearAll.run();
  }

  // ── Similarity Search ──────────────────────────────────────────────────────

  async search(query: VectorQuery): Promise<VectorQueryResult> {
    this.ensureOpen();

    const start = performance.now();

    let queryVec: number[];
    if (query.embedding) {
      queryVec = query.embedding;
    } else {
      throw new VectorStoreError(
        "LocalVectorStore.search() requires a pre-computed embedding vector; " +
        "text-based search needs an EmbeddingAdapter to convert text to vector first",
      );
    }

    this.validateDimension(queryVec, "query");
    const queryNorm = l2norm(queryVec);

    const topK = query.topK ?? 10;
    const minScore = query.minScore ?? 0;

    // Fetch candidate rows — apply metadata filter if specified
    let rows: VecRow[];
    if (query.filter && Object.keys(query.filter).length > 0) {
      rows = this.searchWithFilter(query.filter);
    } else {
      rows = this.stmts.allDocs.all() as VecRow[];
    }

    // Score and rank
    const scored: VectorSearchResult[] = [];
    for (const row of rows) {
      const vec = bufferToEmbedding(row.embedding);
      const score = cosineSimilarity(queryVec, vec, queryNorm, row.norm);
      if (score >= minScore) {
        scored.push({
          document: this.rowToDoc(row, query.includeEmbeddings ?? false),
          score,
        });
      }
    }

    // Sort descending by score, take topK
    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, topK);

    const durationMs = performance.now() - start;

    return {
      results,
      total: rows.length,
      durationMs,
    };
  }

  // ── Index Stats ────────────────────────────────────────────────────────────

  async getStats(): Promise<VectorIndexStats> {
    this.ensureOpen();
    const docCount = (this.stmts.countAll.get() as { cnt: number }).cnt;

    return {
      documentCount: docCount,
      dimensions: this.dim,
    };
  }

  // ── Internal Helpers ───────────────────────────────────────────────────────

  private rowToDoc(row: VecRow, includeEmbedding = true): VectorDocument {
    return {
      id: row.id,
      content: row.content,
      embedding: includeEmbedding ? bufferToEmbedding(row.embedding) : [],
      metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private validateDimension(vec: number[], id: string): void {
    if (vec.length !== this.dim) {
      throw new VectorDimensionError(this.dim, vec.length);
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new VectorStoreError("VectorStore is closed");
    }
  }

  /** Fetch all rows then filter by metadata in JS (no JSON index in SQLite). */
  private searchWithFilter(filter: Record<string, unknown>): VecRow[] {
    const allRows = this.stmts.allDocs.all() as VecRow[];
    return allRows.filter((row) => {
      if (!row.metadata) return false;
      const meta = JSON.parse(row.metadata) as Record<string, unknown>;
      for (const [key, value] of Object.entries(filter)) {
        if (meta[key] !== value) return false;
      }
      return true;
    });
  }
}

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  StorageProvider,
  StorageTransaction,
  StorageValue,
  StorageEntry,
  StorageQuery,
  StorageQueryResult,
  StorageOptions,
} from "./types.js";
import {
  StorageBackendError,
  StorageTransactionError,
} from "./types.js";

const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

interface KvRow {
  namespace: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
  ttl: number | null;
  tags: string | null;
}

export class SqliteStorageProvider implements StorageProvider {
  readonly name = "sqlite";

  private db!: Database.Database;
  private dbPath: string;
  private walMode: boolean;
  private enableFts: boolean;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  private stmts!: {
    set: Database.Statement;
    get: Database.Statement;
    has: Database.Statement;
    del: Database.Statement;
    listKeys: Database.Statement;
    clearNs: Database.Statement;
    countAll: Database.Statement;
    cleanupExpired: Database.Statement;
    queryBase: Database.Statement;
    queryCount: Database.Statement;
    queryWithFts?: Database.Statement;
    queryWithFtsCount?: Database.Statement;
  };

  constructor(options: StorageOptions) {
    if (!options.dbPath) {
      throw new StorageBackendError("sqlite", "dbPath is required");
    }
    this.dbPath = options.dbPath;
    this.walMode = options.walMode ?? true;
    this.enableFts = options.enableFts ?? false;
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
      CREATE TABLE IF NOT EXISTS kv_entries (
        namespace TEXT NOT NULL,
        key       TEXT NOT NULL,
        value     TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ttl       INTEGER,
        tags      TEXT,
        PRIMARY KEY (namespace, key)
      );
      CREATE INDEX IF NOT EXISTS idx_kv_ns ON kv_entries(namespace);
      CREATE INDEX IF NOT EXISTS idx_kv_created ON kv_entries(created_at);
      CREATE INDEX IF NOT EXISTS idx_kv_updated ON kv_entries(updated_at);
    `);

    if (this.enableFts) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS kv_fts USING fts5(
          namespace, key, value,
          content='kv_entries',
          content_rowid='rowid'
        );

        CREATE TRIGGER IF NOT EXISTS kv_fts_insert AFTER INSERT ON kv_entries BEGIN
          INSERT INTO kv_fts(rowid, namespace, key, value) VALUES (new.rowid, new.namespace, new.key, new.value);
        END;

        CREATE TRIGGER IF NOT EXISTS kv_fts_delete AFTER DELETE ON kv_entries BEGIN
          INSERT INTO kv_fts(kv_fts, rowid, namespace, key, value) VALUES('delete', old.rowid, old.namespace, old.key, old.value);
        END;

        CREATE TRIGGER IF NOT EXISTS kv_fts_update AFTER UPDATE ON kv_entries BEGIN
          INSERT INTO kv_fts(kv_fts, rowid, namespace, key, value) VALUES('delete', old.rowid, old.namespace, old.key, old.value);
          INSERT INTO kv_fts(rowid, namespace, key, value) VALUES (new.rowid, new.namespace, new.key, new.value);
        END;
      `);
    }

    this.prepareStatements();
    this.startCleanupTimer();
  }

  private prepareStatements(): void {
    this.stmts = {
      set: this.db.prepare(`
        INSERT INTO kv_entries (namespace, key, value, created_at, updated_at, ttl, tags)
        VALUES (@namespace, @key, @value, @now, @now, @ttl, @tags)
        ON CONFLICT(namespace, key) DO UPDATE SET
          value = @value, updated_at = @now, ttl = @ttl, tags = @tags
      `),
      get: this.db.prepare(
        `SELECT * FROM kv_entries WHERE namespace = ? AND key = ?`
      ),
      has: this.db.prepare(
        `SELECT 1 FROM kv_entries WHERE namespace = ? AND key = ?`
      ),
      del: this.db.prepare(
        `DELETE FROM kv_entries WHERE namespace = ? AND key = ?`
      ),
      listKeys: this.db.prepare(
        `SELECT key FROM kv_entries WHERE namespace = ?`
      ),
      clearNs: this.db.prepare(
        `DELETE FROM kv_entries WHERE namespace = ?`
      ),
      countAll: this.db.prepare(
        `SELECT COUNT(*) as cnt FROM kv_entries WHERE namespace = ?`
      ),
      cleanupExpired: this.db.prepare(`
        DELETE FROM kv_entries
        WHERE ttl IS NOT NULL AND ttl > 0
          AND (unixepoch(created_at) + ttl) < unixepoch('now')
      `),
      queryBase: this.db.prepare(`
        SELECT * FROM kv_entries
        WHERE namespace = ?
          AND (ttl IS NULL OR ttl = 0 OR (unixepoch(created_at) + ttl) >= unixepoch('now'))
      `),
      queryCount: this.db.prepare(`
        SELECT COUNT(*) as cnt FROM kv_entries
        WHERE namespace = ?
          AND (ttl IS NULL OR ttl = 0 OR (unixepoch(created_at) + ttl) >= unixepoch('now'))
      `),
    };

    if (this.enableFts) {
      this.stmts.queryWithFts = this.db.prepare(`
        SELECT kv.* FROM kv_entries kv
        JOIN kv_fts fts ON kv.rowid = fts.rowid
        WHERE kv.namespace = ?
          AND kv_fts MATCH ?
          AND (kv.ttl IS NULL OR kv.ttl = 0 OR (unixepoch(kv.created_at) + kv.ttl) >= unixepoch('now'))
      `);
      this.stmts.queryWithFtsCount = this.db.prepare(`
        SELECT COUNT(*) as cnt FROM kv_entries kv
        JOIN kv_fts fts ON kv.rowid = fts.rowid
        WHERE kv.namespace = ?
          AND kv_fts MATCH ?
          AND (kv.ttl IS NULL OR kv.ttl = 0 OR (unixepoch(kv.created_at) + kv.ttl) >= unixepoch('now'))
      `);
    }
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.runCleanup();
    }, DEFAULT_CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  private runCleanup(): void {
    try {
      this.stmts.cleanupExpired.run();
    } catch {
      // best-effort cleanup
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.db.close();
  }

  isHealthy(): boolean {
    return !this.closed;
  }

  async set(namespace: string, key: string, value: StorageValue): Promise<void> {
    this.ensureOpen();
    const now = new Date().toISOString();
    try {
      this.stmts.set.run({
        namespace,
        key,
        value: JSON.stringify(value),
        now,
        ttl: null,
        tags: null,
      });
    } catch (err) {
      throw new StorageBackendError("sqlite", `set failed: ${String(err)}`, { cause: err });
    }
  }

  async get(namespace: string, key: string): Promise<StorageValue | undefined> {
    this.ensureOpen();
    const row = this.stmts.get.get(namespace, key) as KvRow | undefined;
    if (!row) return undefined;
    if (this.isExpired(row)) {
      this.stmts.del.run(namespace, key);
      return undefined;
    }
    return JSON.parse(row.value) as StorageValue;
  }

  async has(namespace: string, key: string): Promise<boolean> {
    this.ensureOpen();
    const row = this.stmts.get.get(namespace, key) as KvRow | undefined;
    if (!row) return false;
    if (this.isExpired(row)) {
      this.stmts.del.run(namespace, key);
      return false;
    }
    return true;
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    this.ensureOpen();
    const info = this.stmts.del.run(namespace, key);
    return info.changes > 0;
  }

  async listKeys(namespace: string): Promise<string[]> {
    this.ensureOpen();
    const rows = this.stmts.listKeys.all(namespace) as Array<{ key: string }>;
    return rows.map((r) => r.key);
  }

  async clear(namespace: string): Promise<void> {
    this.ensureOpen();
    this.stmts.clearNs.run(namespace);
  }

  async setMany(namespace: string, entries: Array<{ key: string; value: StorageValue }>): Promise<void> {
    this.ensureOpen();
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      for (const { key, value } of entries) {
        this.stmts.set.run({
          namespace,
          key,
          value: JSON.stringify(value),
          now,
          ttl: null,
          tags: null,
        });
      }
    });
    try {
      tx();
    } catch (err) {
      throw new StorageBackendError("sqlite", `setMany failed: ${String(err)}`, { cause: err });
    }
  }

  async getMany(namespace: string, keys: string[]): Promise<Array<{ key: string; value: StorageValue | undefined }>> {
    this.ensureOpen();
    return keys.map((key) => {
      const row = this.stmts.get.get(namespace, key) as KvRow | undefined;
      if (!row) return { key, value: undefined };
      if (this.isExpired(row)) {
        this.stmts.del.run(namespace, key);
        return { key, value: undefined };
      }
      return { key, value: JSON.parse(row.value) as StorageValue };
    });
  }

  async query(namespace: string, filter: StorageQuery): Promise<StorageQueryResult> {
    this.ensureOpen();
    const { sql, params, countSql, countParams } = this.buildQuery(namespace, filter);

    const countRow = this.db.prepare(countSql).get(...countParams) as { cnt: number };
    const total = countRow.cnt;

    const rows = this.db.prepare(sql).all(...params) as KvRow[];
    const entries = rows
      .filter((r) => !this.isExpired(r))
      .map((r) => ({
        key: r.key,
        entry: this.rowToEntry(r),
      }));

    const limit = filter.limit ?? total;
    const offset = filter.offset ?? 0;

    return {
      entries,
      total,
      hasMore: offset + entries.length < total,
    };
  }

  async count(namespace: string, filter?: StorageQuery): Promise<number> {
    this.ensureOpen();
    if (!filter) {
      const row = this.stmts.countAll.get(namespace) as { cnt: number };
      return row.cnt;
    }
    const { countSql, countParams } = this.buildQuery(namespace, filter);
    const row = this.db.prepare(countSql).get(...countParams) as { cnt: number };
    return row.cnt;
  }

  async transaction<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    this.ensureOpen();
    const txImpl = new SqliteStorageTransaction(this.db, this);
    try {
      const result = await fn(txImpl);
      if (!txImpl.isCommitted && !txImpl.isRolledBack) {
        txImpl.applyCommit();
      }
      return result;
    } catch (err) {
      if (!txImpl.isCommitted && !txImpl.isRolledBack) {
        txImpl.applyRollback();
      }
      if (err instanceof StorageTransactionError) throw err;
      throw new StorageTransactionError(`Transaction failed: ${String(err)}`, { cause: err });
    }
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  setWithMeta(namespace: string, key: string, value: StorageValue, ttl?: number, tags?: string[]): void {
    const now = new Date().toISOString();
    this.stmts.set.run({
      namespace,
      key,
      value: JSON.stringify(value),
      now,
      ttl: ttl ?? null,
      tags: tags ? JSON.stringify(tags) : null,
    });
  }

  getRow(namespace: string, key: string): KvRow | undefined {
    return this.stmts.get.get(namespace, key) as KvRow | undefined;
  }

  deleteRow(namespace: string, key: string): boolean {
    return this.stmts.del.run(namespace, key).changes > 0;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new StorageBackendError("sqlite", "Storage is closed");
    }
  }

  private isExpired(row: KvRow): boolean {
    if (!row.ttl || row.ttl <= 0) return false;
    const createdAt = new Date(row.created_at).getTime() / 1000;
    return createdAt + row.ttl < Date.now() / 1000;
  }

  private rowToEntry(row: KvRow): StorageEntry {
    return {
      value: JSON.parse(row.value) as StorageValue,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ttl: row.ttl ?? undefined,
      tags: row.tags ? (JSON.parse(row.tags) as string[]) : undefined,
    };
  }

  private buildQuery(namespace: string, filter: StorageQuery): {
    sql: string;
    params: unknown[];
    countSql: string;
    countParams: unknown[];
  } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    const isFts = !!filter.fullTextSearch && this.enableFts;
    const baseTable = isFts
      ? `kv_entries kv JOIN kv_fts fts ON kv.rowid = fts.rowid`
      : `kv_entries kv`;
    const prefix = isFts ? `kv.` : `kv.`;

    conditions.push(`${prefix}namespace = ?`);
    params.push(namespace);

    if (!isFts) {
      conditions.push(
        `(${prefix}ttl IS NULL OR ${prefix}ttl = 0 OR (unixepoch(${prefix}created_at) + ${prefix}ttl) >= unixepoch('now'))`
      );
    } else {
      conditions.push(`kv_fts MATCH ?`);
      params.push(filter.fullTextSearch);
    }

    if (filter.tags && filter.tags.length > 0) {
      for (const tag of filter.tags) {
        conditions.push(`EXISTS (SELECT 1 FROM json_each(${prefix}tags) WHERE json_each.value = ?)`);
        params.push(tag);
      }
    }

    if (filter.createdAfter) {
      conditions.push(`${prefix}created_at >= ?`);
      params.push(filter.createdAfter);
    }
    if (filter.createdBefore) {
      conditions.push(`${prefix}created_at <= ?`);
      params.push(filter.createdBefore);
    }
    if (filter.updatedAfter) {
      conditions.push(`${prefix}updated_at >= ?`);
      params.push(filter.updatedAfter);
    }
    if (filter.updatedBefore) {
      conditions.push(`${prefix}updated_at <= ?`);
      params.push(filter.updatedBefore);
    }

    if (filter.hasTtl !== undefined) {
      conditions.push(filter.hasTtl
        ? `(${prefix}ttl IS NOT NULL AND ${prefix}ttl > 0)`
        : `(${prefix}ttl IS NULL OR ${prefix}ttl = 0)`
      );
    }

    if (filter.keyPrefix) {
      conditions.push(`${prefix}key LIKE ?`);
      params.push(`${filter.keyPrefix}%`);
    }

    if (filter.keyPattern) {
      conditions.push(`${prefix}key GLOB ?`);
      params.push(filter.keyPattern);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const orderByCol = filter.orderBy === "createdAt" ? `${prefix}created_at`
      : filter.orderBy === "updatedAt" ? `${prefix}updated_at`
      : `${prefix}key`;
    const order = filter.order === "desc" ? "DESC" : "ASC";
    const orderClause = `ORDER BY ${orderByCol} ${order}`;

    const countSql = `SELECT COUNT(*) as cnt FROM ${baseTable} ${where}`;

    let limitClause = "";
    const limitParams: unknown[] = [];
    if (filter.limit !== undefined) {
      limitClause += ` LIMIT ?`;
      limitParams.push(filter.limit);
    }
    if (filter.offset !== undefined) {
      limitClause += ` OFFSET ?`;
      limitParams.push(filter.offset);
    }

    const sql = `SELECT ${prefix}* FROM ${baseTable} ${where} ${orderClause}${limitClause}`;
    const allParams = [...params, ...limitParams];

    return { sql, params: allParams, countSql, countParams: [...params] };
  }
}

// ── Transaction Implementation ─────────────────────────────────────────────

class SqliteStorageTransaction implements StorageTransaction {
  private pendingSets: Array<{ namespace: string; key: string; value: StorageValue }> = [];
  private pendingDeletes: Array<{ namespace: string; key: string }> = [];
  private _committed = false;
  private _rolledBack = false;

  constructor(
    private db: Database.Database,
    private provider: SqliteStorageProvider,
  ) {}

  get isCommitted(): boolean { return this._committed; }
  get isRolledBack(): boolean { return this._rolledBack; }

  set(namespace: string, key: string, value: StorageValue): void {
    this.ensureActive();
    this.pendingSets.push({ namespace, key, value });
  }

  async get(namespace: string, key: string): Promise<StorageValue | undefined> {
    this.ensureActive();
    const row = this.provider.getRow(namespace, key);
    if (!row) return undefined;
    return JSON.parse(row.value) as StorageValue;
  }

  delete(namespace: string, key: string): void {
    this.ensureActive();
    this.pendingDeletes.push({ namespace, key });
  }

  async commit(): Promise<void> {
    this.ensureActive();
    this.applyCommit();
  }

  async rollback(): Promise<void> {
    this.ensureActive();
    this.applyRollback();
  }

  applyCommit(): void {
    this.ensureActive();
    try {
      const applyAll = this.db.transaction(() => {
        for (const { namespace, key, value } of this.pendingSets) {
          this.provider.setWithMeta(namespace, key, value);
        }
        for (const { namespace, key } of this.pendingDeletes) {
          this.provider.deleteRow(namespace, key);
        }
      });
      applyAll();
      this._committed = true;
    } catch (err) {
      throw new StorageTransactionError(`Commit failed: ${String(err)}`, { cause: err });
    }
  }

  applyRollback(): void {
    this.pendingSets = [];
    this.pendingDeletes = [];
    this._rolledBack = true;
  }

  private ensureActive(): void {
    if (this._committed) throw new StorageTransactionError("Transaction already committed");
    if (this._rolledBack) throw new StorageTransactionError("Transaction already rolled back");
  }
}

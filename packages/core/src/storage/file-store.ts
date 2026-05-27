import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  StorageProvider,
  StorageTransaction,
  StorageValue,
  StorageEntry,
  StorageQuery,
  StorageQueryResult,
} from "./types.js";
import { StorageBackendError, StorageTransactionError } from "./types.js";

interface NamespaceData {
  entries: Record<string, StorageEntry>;
  dirty: boolean;
}

interface PendingOp {
  type: "set" | "delete";
  namespace: string;
  key: string;
  value?: StorageValue;
}

export interface FileStoreOptions {
  storeDir: string;
  cleanupIntervalMs?: number;
}

export class FileStore implements StorageProvider {
  readonly name = "file";
  private readonly storeDir: string;
  private readonly cleanupIntervalMs: number;
  private namespaces = new Map<string, NamespaceData>();
  private nsLocks = new Map<string, Promise<void>>();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(options: FileStoreOptions) {
    this.storeDir = options.storeDir;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;
    mkdirSync(this.storeDir, { recursive: true });
  }

  async initialize(): Promise<void> {
    for (const file of readdirSync(this.storeDir)) {
      if (file.endsWith(".json") && !file.endsWith(".lock")) {
        const ns = file.slice(0, -5);
        this.loadNamespace(ns);
      }
    }
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), this.cleanupIntervalMs);
    if (typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  async close(): Promise<void> {
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    for (const [ns, data] of this.namespaces) {
      if (data.dirty) {
        this.flushNamespace(ns, data);
      }
    }
    this.closed = true;
  }

  isHealthy(): boolean {
    return !this.closed;
  }

  // ── Key-Value Operations ────────────────────────────────────────────────

  async set(namespace: string, key: string, value: StorageValue): Promise<void> {
    this.assertOpen();
    return this.withNsLock(namespace, () => {
      const data = this.getOrCreateNs(namespace);
      const now = new Date().toISOString();
      const existing = data.entries[key];
      data.entries[key] = {
        value,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ttl: existing?.ttl,
        tags: existing?.tags,
      };
      data.dirty = true;
      this.flushNamespace(namespace, data);
    });
  }

  async get(namespace: string, key: string): Promise<StorageValue | undefined> {
    this.assertOpen();
    const data = this.loadNamespace(namespace);
    const entry = data.entries[key];
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      delete data.entries[key];
      data.dirty = true;
      this.flushNamespace(namespace, data);
      return undefined;
    }
    return entry.value;
  }

  async has(namespace: string, key: string): Promise<boolean> {
    this.assertOpen();
    const data = this.loadNamespace(namespace);
    const entry = data.entries[key];
    if (!entry) return false;
    if (this.isExpired(entry)) {
      delete data.entries[key];
      data.dirty = true;
      this.flushNamespace(namespace, data);
      return false;
    }
    return true;
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    this.assertOpen();
    return this.withNsLock(namespace, () => {
      const data = this.loadNamespace(namespace);
      if (!(key in data.entries)) return false;
      delete data.entries[key];
      data.dirty = true;
      this.flushNamespace(namespace, data);
      return true;
    });
  }

  async listKeys(namespace: string): Promise<string[]> {
    this.assertOpen();
    const data = this.loadNamespace(namespace);
    const keys: string[] = [];
    for (const [key, entry] of Object.entries(data.entries)) {
      if (!this.isExpired(entry)) {
        keys.push(key);
      }
    }
    return keys;
  }

  async clear(namespace: string): Promise<void> {
    this.assertOpen();
    return this.withNsLock(namespace, () => {
      const data = this.loadNamespace(namespace);
      data.entries = {};
      data.dirty = true;
      this.flushNamespace(namespace, data);
    });
  }

  // ── Batch Operations ────────────────────────────────────────────────────

  async setMany(namespace: string, entries: Array<{ key: string; value: StorageValue }>): Promise<void> {
    this.assertOpen();
    return this.withNsLock(namespace, () => {
      const data = this.getOrCreateNs(namespace);
      const now = new Date().toISOString();
      for (const { key, value } of entries) {
        const existing = data.entries[key];
        data.entries[key] = {
          value,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          ttl: existing?.ttl,
          tags: existing?.tags,
        };
      }
      data.dirty = true;
      this.flushNamespace(namespace, data);
    });
  }

  async getMany(namespace: string, keys: string[]): Promise<Array<{ key: string; value: StorageValue | undefined }>> {
    this.assertOpen();
    const data = this.loadNamespace(namespace);
    return keys.map((key) => {
      const entry = data.entries[key];
      if (!entry || this.isExpired(entry)) return { key, value: undefined };
      return { key, value: entry.value };
    });
  }

  // ── Query Operations ────────────────────────────────────────────────────

  async query(namespace: string, filter: StorageQuery): Promise<StorageQueryResult> {
    this.assertOpen();
    const data = this.loadNamespace(namespace);
    let matched = this.filterEntries(data.entries, filter);
    const total = matched.length;

    if (filter.orderBy) {
      const dir = filter.order === "desc" ? -1 : 1;
      const orderBy = filter.orderBy;
      matched.sort((a, b) => {
        if (orderBy === "key") return a.key.localeCompare(b.key) * dir;
        const aVal = a.entry[orderBy] ?? "";
        const bVal = b.entry[orderBy] ?? "";
        return aVal.localeCompare(bVal) * dir;
      });
    }

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? matched.length;
    const page = matched.slice(offset, offset + limit);

    return {
      entries: page,
      total,
      hasMore: offset + limit < total,
    };
  }

  async count(namespace: string, filter?: StorageQuery): Promise<number> {
    this.assertOpen();
    const data = this.loadNamespace(namespace);
    if (!filter) {
      return Object.values(data.entries).filter((e) => !this.isExpired(e)).length;
    }
    return this.filterEntries(data.entries, filter).length;
  }

  // ── Transaction Support ─────────────────────────────────────────────────

  async transaction<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    this.assertOpen();
    const self = this;
    const pending: PendingOp[] = [];
    const readNs = new Map<string, NamespaceData>();

    const tx: StorageTransaction = {
      set(namespace: string, key: string, value: StorageValue): void {
        pending.push({ type: "set", namespace, key, value });
      },
      async get(namespace: string, key: string): Promise<StorageValue | undefined> {
        if (!readNs.has(namespace)) {
          readNs.set(namespace, JSON.parse(JSON.stringify(self.getOrCreateNs(namespace))) as NamespaceData);
        }
        const snapshot = readNs.get(namespace)!;
        const entry = snapshot.entries[key];
        if (!entry || self.isExpired(entry)) return undefined;
        return entry.value;
      },
      delete(namespace: string, key: string): void {
        pending.push({ type: "delete", namespace, key });
      },
      async commit(): Promise<void> {
        const nsOps = new Map<string, PendingOp[]>();
        for (const op of pending) {
          const list = nsOps.get(op.namespace) ?? [];
          list.push(op);
          nsOps.set(op.namespace, list);
        }

        for (const [ns, ops] of nsOps) {
          await self.withNsLock(ns, () => {
            const data = self.getOrCreateNs(ns);
            const now = new Date().toISOString();
            for (const op of ops) {
              if (op.type === "set") {
                const existing = data.entries[op.key];
                data.entries[op.key] = {
                  value: op.value!,
                  createdAt: existing?.createdAt ?? now,
                  updatedAt: now,
                  ttl: existing?.ttl,
                  tags: existing?.tags,
                };
              } else {
                delete data.entries[op.key];
              }
            }
            data.dirty = true;
            self.flushNamespace(ns, data);
          });
        }
        pending.length = 0;
      },
      async rollback(): Promise<void> {
        pending.length = 0;
      },
    };

    try {
      const result = await fn(tx);
      await tx.commit();
      return result;
    } catch (err) {
      await tx.rollback();
      throw new StorageTransactionError(
        err instanceof Error ? err.message : String(err),
        { cause: err },
      );
    }
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageBackendError("file", "Store is closed");
    }
  }

  private filePath(namespace: string): string {
    return join(this.storeDir, `${namespace}.json`);
  }

  private loadNamespace(namespace: string): NamespaceData {
    const cached = this.namespaces.get(namespace);
    if (cached) return cached;

    const fp = this.filePath(namespace);
    let entries: Record<string, StorageEntry> = {};

    if (existsSync(fp)) {
      try {
        const raw = readFileSync(fp, "utf-8");
        entries = JSON.parse(raw) as Record<string, StorageEntry>;
      } catch (err) {
        throw new StorageBackendError("file", `Failed to read namespace "${namespace}": ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
    }

    const data: NamespaceData = { entries, dirty: false };
    this.namespaces.set(namespace, data);
    return data;
  }

  private getOrCreateNs(namespace: string): NamespaceData {
    let data = this.namespaces.get(namespace);
    if (!data) {
      data = { entries: {}, dirty: false };
      this.namespaces.set(namespace, data);
    }
    return data;
  }

  private flushNamespace(namespace: string, data: NamespaceData): void {
    if (!data.dirty) return;
    const fp = this.filePath(namespace);
    const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(data.entries), "utf-8");
      renameSync(tmp, fp);
      data.dirty = false;
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
      throw new StorageBackendError("file", `Failed to write namespace "${namespace}": ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  private isExpired(entry: StorageEntry): boolean {
    if (!entry.ttl || entry.ttl <= 0) return false;
    const created = new Date(entry.createdAt).getTime();
    return Date.now() - created > entry.ttl * 1000;
  }

  private cleanupExpired(): void {
    for (const [ns, data] of this.namespaces) {
      let changed = false;
      for (const [key, entry] of Object.entries(data.entries)) {
        if (this.isExpired(entry)) {
          delete data.entries[key];
          changed = true;
        }
      }
      if (changed) {
        data.dirty = true;
        this.flushNamespace(ns, data);
      }
    }
  }

  private filterEntries(
    entries: Record<string, StorageEntry>,
    filter: StorageQuery,
  ): Array<{ key: string; entry: StorageEntry }> {
    const results: Array<{ key: string; entry: StorageEntry }> = [];

    for (const [key, entry] of Object.entries(entries)) {
      if (!filter.includeExpired && this.isExpired(entry)) continue;

      if (filter.keyPrefix && !key.startsWith(filter.keyPrefix)) continue;

      if (filter.keyPattern) {
        if (!this.matchGlob(key, filter.keyPattern)) continue;
      }

      if (filter.tags?.length) {
        const entryTags = entry.tags ?? [];
        if (!filter.tags.every((t) => entryTags.includes(t))) continue;
      }

      if (filter.hasTtl !== undefined) {
        const hasTtl = Boolean(entry.ttl && entry.ttl > 0);
        if (filter.hasTtl !== hasTtl) continue;
      }

      if (filter.createdAfter && entry.createdAt <= filter.createdAfter) continue;
      if (filter.createdBefore && entry.createdAt >= filter.createdBefore) continue;
      if (filter.updatedAfter && entry.updatedAt <= filter.updatedAfter) continue;
      if (filter.updatedBefore && entry.updatedAt >= filter.updatedBefore) continue;

      if (filter.fullTextSearch) {
        const needle = filter.fullTextSearch.toLowerCase();
        const haystack = JSON.stringify(entry.value).toLowerCase();
        if (!haystack.includes(needle)) continue;
      }

      results.push({ key, entry });
    }

    return results;
  }

  private matchGlob(value: string, pattern: string): boolean {
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${regexStr}$`).test(value);
  }

  private withNsLock<T>(namespace: string, fn: () => T): Promise<T> {
    const prev = this.nsLocks.get(namespace) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.nsLocks.set(namespace, next.then(() => {}, () => {}));
    return next;
  }
}

export function createFileStore(options: FileStoreOptions): FileStore {
  return new FileStore(options);
}

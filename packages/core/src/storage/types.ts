/**
 * Storage Abstraction Layer — Unified storage interface for OpenVera.
 *
 * Provides a StorageProvider interface that abstracts over different backends
 * (SQLite, file-based, in-memory) so that session, memory, and user data
 * can be stored and queried uniformly.
 */

// ── Storage Provider Interface ──────────────────────────────────────────────

/**
 * Core storage provider interface. All backends (SQLite, file, in-memory)
 * implement this interface.
 */
export interface StorageProvider {
  /** Unique name of this provider (e.g., "sqlite", "file", "memory") */
  readonly name: string;

  /** Initialize the storage backend (create tables, directories, etc.) */
  initialize(): Promise<void>;

  /** Close the storage backend and release resources */
  close(): Promise<void>;

  /** Check if the storage backend is healthy */
  isHealthy(): boolean;

  // ── Key-Value Operations ─────────────────────────────────────────────────

  /** Store a value under a namespace + key */
  set(namespace: string, key: string, value: StorageValue): Promise<void>;

  /** Retrieve a value by namespace + key. Returns undefined if not found. */
  get(namespace: string, key: string): Promise<StorageValue | undefined>;

  /** Check if a key exists in the namespace */
  has(namespace: string, key: string): Promise<boolean>;

  /** Delete a key from the namespace */
  delete(namespace: string, key: string): Promise<boolean>;

  /** List all keys in a namespace */
  listKeys(namespace: string): Promise<string[]>;

  /** Clear all entries in a namespace */
  clear(namespace: string): Promise<void>;

  // ── Batch Operations ─────────────────────────────────────────────────────

  /** Store multiple key-value pairs atomically */
  setMany(namespace: string, entries: Array<{ key: string; value: StorageValue }>): Promise<void>;

  /** Retrieve multiple values by keys */
  getMany(namespace: string, keys: string[]): Promise<Array<{ key: string; value: StorageValue | undefined }>>;

  // ── Query Operations ─────────────────────────────────────────────────────

  /** Query entries matching a filter */
  query(namespace: string, filter: StorageQuery): Promise<StorageQueryResult>;

  /** Count entries in a namespace matching an optional filter */
  count(namespace: string, filter?: StorageQuery): Promise<number>;

  // ── Transaction Support ──────────────────────────────────────────────────

  /** Execute multiple operations in a transaction */
  transaction<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T>;
}

// ── Transaction Interface ───────────────────────────────────────────────────

export interface StorageTransaction {
  set(namespace: string, key: string, value: StorageValue): void;
  get(namespace: string, key: string): Promise<StorageValue | undefined>;
  delete(namespace: string, key: string): void;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

// ── Storage Value Types ─────────────────────────────────────────────────────

/** Supported value types for storage */
export type StorageValue =
  | string
  | number
  | boolean
  | null
  | StorageValue[]
  | { [key: string]: StorageValue };

/** Metadata stored alongside each entry */
export interface StorageEntry<T extends StorageValue = StorageValue> {
  /** The stored value */
  value: T;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
  /** Optional TTL in seconds (0 = no expiry) */
  ttl?: number;
  /** Optional tags for categorization */
  tags?: string[];
}

// ── Query Types ─────────────────────────────────────────────────────────────

/** Query filter for storage entries */
export interface StorageQuery {
  /** Filter by tags (entries must have ALL specified tags) */
  tags?: string[];
  /** Filter by creation time (ISO timestamp) */
  createdAfter?: string;
  createdBefore?: string;
  /** Filter by update time (ISO timestamp) */
  updatedAfter?: string;
  updatedBefore?: string;
  /** Filter by TTL (entries with TTL set) */
  hasTtl?: boolean;
  /** Filter expired entries */
  includeExpired?: boolean;
  /** Key prefix filter */
  keyPrefix?: string;
  /** Key pattern (glob-style) */
  keyPattern?: string;
  /** Full-text search across values (if supported by backend) */
  fullTextSearch?: string;
  /** Maximum number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Sort order */
  orderBy?: "createdAt" | "updatedAt" | "key";
  /** Sort direction */
  order?: "asc" | "desc";
}

/** Result of a storage query */
export interface StorageQueryResult {
  /** Matching entries */
  entries: Array<{ key: string; entry: StorageEntry }>;
  /** Total count of matching entries (before limit/offset) */
  total: number;
  /** Whether there are more results */
  hasMore: boolean;
}

// ── Session Storage Types ───────────────────────────────────────────────────

/** Session entry stored in the database */
export interface StoredSession {
  sessionId: string;
  /** JSONL content of the session */
  content: string;
  /** ISO timestamp */
  createdAt: string;
  /** ISO timestamp */
  updatedAt: string;
  /** Session metadata */
  metadata: SessionMetadata;
}

/** Session metadata for indexing and querying */
export interface SessionMetadata {
  model?: string;
  provider?: string;
  cwd?: string;
  turnCount?: number;
  totalCostUsd?: number;
  tags?: string[];
  /** First user prompt (for search) */
  firstPrompt?: string;
  /** AI-generated title */
  title?: string;
}

// ── Memory Storage Types ────────────────────────────────────────────────────

/** Memory entry stored in the database */
export interface StoredMemory {
  id: string;
  tier: "working" | "episodic" | "semantic";
  content: string;
  tags: string[];
  importance: number;
  source?: string;
  /** ISO timestamp */
  createdAt: string;
  /** ISO timestamp */
  updatedAt: string;
  /** Access tracking for decay */
  accessCount?: number;
  lastAccessedAt?: string;
  /** Episodic-specific fields */
  taskSummary?: string;
  outcome?: string;
  lessons?: string[];
  /** Semantic-specific fields */
  key?: string;
  value?: string;
}

// ── User Data Types ─────────────────────────────────────────────────────────

/** User data entry for data_save/data_load tools */
export interface UserDataEntry {
  /** User-defined key */
  key: string;
  /** Arbitrary JSON value */
  value: StorageValue;
  /** User-defined namespace (optional) */
  namespace?: string;
  /** ISO timestamp */
  createdAt: string;
  /** ISO timestamp */
  updatedAt: string;
  /** Optional description */
  description?: string;
}

// ── Storage Options ─────────────────────────────────────────────────────────

/** Options for creating a storage provider */
export interface StorageOptions {
  /** Backend type */
  backend: "sqlite" | "file" | "memory";
  /** Database file path (for SQLite) */
  dbPath?: string;
  /** Directory path (for file-based storage) */
  storeDir?: string;
  /** Enable WAL mode for SQLite (better concurrent read performance) */
  walMode?: boolean;
  /** Enable auto-vacuum for SQLite */
  autoVacuum?: boolean;
  /** Cache size in pages for SQLite */
  cacheSize?: number;
  /** Maximum database size in bytes */
  maxSize?: number;
  /** Enable full-text search (FTS5) for SQLite */
  enableFts?: boolean;
}

// ── Error Types ─────────────────────────────────────────────────────────────

export class StorageError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
    this.code = code;
  }
}

export class StorageNotFoundError extends StorageError {
  constructor(namespace: string, key: string) {
    super("STORAGE_NOT_FOUND", `Entry not found: ${namespace}/${key}`);
    this.name = "StorageNotFoundError";
  }
}

export class StorageConflictError extends StorageError {
  constructor(namespace: string, key: string) {
    super("STORAGE_CONFLICT", `Entry already exists: ${namespace}/${key}`);
    this.name = "StorageConflictError";
  }
}

export class StorageTransactionError extends StorageError {
  constructor(message: string, options?: ErrorOptions) {
    super("STORAGE_TRANSACTION", message, options);
    this.name = "StorageTransactionError";
  }
}

export class StorageBackendError extends StorageError {
  constructor(backend: string, detail: string, options?: ErrorOptions) {
    super("STORAGE_BACKEND", `${backend} error: ${detail}`, options);
    this.name = "StorageBackendError";
  }
}

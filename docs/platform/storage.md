# Storage Architecture

> This document describes OpenVera's persistence storage system, including the SQLite storage engine, data model, migration strategy, and performance design.

## Overview

OpenVera's storage layer provides a unified key-value abstraction interface with support for multiple backend implementations. The current primary backend is SQLite (based on `better-sqlite3`), offering WAL mode, FTS5 full-text search, TTL expiry, and transaction support.

Core code is located in `packages/core/src/storage/`.

## Architecture Layers

```
Session / Memory / UserData  (Business layer)
        |
SessionStorageAdapter / MemoryStorageAdapter / UserDataStore  (Adapter layer)
        |
SqliteStorageProvider / FileStorageProvider  (Engine layer)
        |
better-sqlite3 / fs  (Foundation)
```

- **Engine layer** (`StorageProvider` interface): Unified key-value CRUD + query + transaction abstraction
- **Adapter layer**: Maps business data models (Session, Memory, UserData) to key-value storage
- **Business layer**: `SessionStore`, `MemoryStore`, etc., as external interfaces

## Core Interface: StorageProvider

```typescript
// packages/core/src/storage/types.ts
export interface StorageProvider {
  readonly name: string;
  initialize(): Promise<void>;
  close(): Promise<void>;
  isHealthy(): boolean;

  // Basic KV operations
  set(namespace: string, key: string, value: StorageValue): Promise<void>;
  get(namespace: string, key: string): Promise<StorageValue | undefined>;
  has(namespace: string, key: string): Promise<boolean>;
  delete(namespace: string, key: string): Promise<boolean>;
  listKeys(namespace: string): Promise<string[]>;
  clear(namespace: string): Promise<void>;

  // Batch operations
  setMany(namespace: string, entries: Array<{ key: string; value: StorageValue }>): Promise<void>;
  getMany(namespace: string, keys: string[]): Promise<Array<{ key: string; value: StorageValue | undefined }>>;

  // Query
  query(namespace: string, filter: StorageQuery): Promise<StorageQueryResult>;
  count(namespace: string, filter?: StorageQuery): Promise<number>;

  // Transaction
  transaction<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T>;
}
```

All backends implement this interface. Namespaces are used for logical partitioning, e.g. `sessions`, `memories`, `user-data`.

## SQLite Engine: SqliteStorageProvider

### Table Structure

```sql
CREATE TABLE IF NOT EXISTS kv_entries (
  namespace  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,     -- JSON serialized
  created_at TEXT NOT NULL,     -- ISO-8601
  updated_at TEXT NOT NULL,     -- ISO-8601
  ttl        INTEGER,           -- Expiry in seconds, NULL = never expires
  tags       TEXT,              -- JSON array
  PRIMARY KEY (namespace, key)
);

CREATE INDEX IF NOT EXISTS idx_kv_ns ON kv_entries(namespace);
CREATE INDEX IF NOT EXISTS idx_kv_created ON kv_entries(created_at);
CREATE INDEX IF NOT EXISTS idx_kv_updated ON kv_entries(updated_at);
```

### FTS5 Full-Text Search (Optional)

Created when `enableFts` is enabled:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS kv_fts USING fts5(
  namespace, key, value,
  content='kv_entries',
  content_rowid='rowid'
);
```

Automatically kept in sync via triggers: INSERT / DELETE / UPDATE on the main table automatically update the FTS index.

### Performance Configuration

Pragmas set automatically in the constructor:

```typescript
// WAL mode: enables concurrent reads and writes, improves write performance
this.db.pragma("journal_mode = WAL");

// Busy timeout 5 seconds: handles lock contention (better-sqlite3 default is immediate failure)
this.db.pragma("busy_timeout = 5000");

// NORMAL synchronous: balance between safety and performance (FULL is unnecessary with WAL)
this.db.pragma("synchronous = NORMAL");
```

Optional configuration via `StorageOptions`:

| Option | Default | Description |
|--------|---------|-------------|
| `walMode` | `true` | Enable WAL mode |
| `enableFts` | `false` | Enable FTS5 full-text search |
| `autoVacuum` | `false` | Enable automatic space reclamation |
| `cacheSize` | - | SQLite cache page count |
| `maxSize` | - | Maximum database file size (bytes) |

### Query Capabilities

`StorageQuery` supported filters:

```typescript
interface StorageQuery {
  tags?: string[];           // Exact tag match (AND logic)
  createdAfter?: string;     // ISO timestamp
  createdBefore?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  hasTtl?: boolean;          // Whether TTL is set
  keyPrefix?: string;        // Key prefix match (LIKE)
  keyPattern?: string;       // Key glob match
  fullTextSearch?: string;   // FTS5 full-text search (requires enableFts)
  limit?: number;
  offset?: number;
  orderBy?: "createdAt" | "updatedAt" | "key";
  order?: "asc" | "desc";
}
```

### Synchronous API

The SQLite engine additionally provides synchronous methods (bypassing async wrappers) for use by `SQLiteSessionBackend` in synchronous interfaces:

```typescript
setSync(namespace, key, value): void
getSync(namespace, key): StorageValue | undefined
listKeysSync(namespace): string[]
```

These methods directly use `better-sqlite3`'s synchronous API, suitable for fast reads that do not require transaction isolation.

### TTL and Auto-Cleanup

- Each record can set `ttl` in seconds
- A timer scans every 60 seconds for expired records and auto-deletes them
- Queries also filter out expired records (`isExpired()` check)
- The timer uses `unref()` so it does not prevent process exit

### Transactions

```typescript
await storage.transaction(async (tx) => {
  tx.set("sessions", "id-1", sessionData);
  tx.delete("sessions", "id-2");
  // Transaction auto-commits; on exception, rolls back
});
```

Transaction implementation uses `better-sqlite3`'s `db.transaction()`, managing commit/rollback automatically. The transaction object provides `set`, `get`, and `delete` methods.

## Data Models

### Session Storage

Managed by `SessionStorageAdapter`, stored in the `sessions` namespace.

```typescript
interface StoredSession {
  sessionId: string;
  content: string;         // Complete JSONL content
  createdAt: string;
  updatedAt: string;
  metadata: SessionMetadata;
}

interface SessionMetadata {
  model?: string;
  provider?: string;
  cwd?: string;
  turnCount?: number;
  totalCostUsd?: number;
  tags?: string[];
  firstPrompt?: string;    // First user prompt (for search)
  title?: string;          // AI or user-defined title
}
```

**Design note**: The SQLite backend retains the full JSONL `content` field for backward compatibility. Metadata is extracted from content and redundantly stored for fast indexing and filtering without parsing JSONL.

### Memory Storage

Stored in the `memories` namespace, across three tiers:

```typescript
interface StoredMemory {
  id: string;
  tier: "working" | "episodic" | "semantic";
  content: string;
  tags: string[];
  importance: number;          // Importance score (0-1)
  source?: string;             // Source session ID
  createdAt: string;
  updatedAt: string;
  accessCount?: number;        // Access count (for decay)
  lastAccessedAt?: string;     // Last access time
  taskSummary?: string;        // Episodic-specific
  outcome?: string;            // Episodic-specific
  lessons?: string[];          // Episodic-specific
  key?: string;                // Semantic-specific
  value?: string;              // Semantic-specific
}
```

### User Data (UserData)

Stores data written by the `data_save` / `data_load` tools:

```typescript
interface UserDataEntry {
  key: string;                 // User-defined key
  value: StorageValue;         // Arbitrary JSON value
  namespace?: string;          // User-defined namespace
  createdAt: string;
  updatedAt: string;
  description?: string;
}
```

## Migration Strategy

### JSONL to SQLite

```typescript
const backend = new SQLiteSessionBackend("~/.vera/sessions.db", true);
await backend.initialize();

// Migrate all JSONL files
const count = await backend.migrateFromJsonl("~/.vera/projects");
console.log(`Migrated ${count} sessions`);
```

Migration flow (`migrateJsonlToSqlite`):
1. Scan the target directory for all `.jsonl` files
2. Parse content, extract metadata
3. Skip sessions already in SQLite (dedup by sessionId)
4. Skip empty or unparseable files
5. Write `StoredSession` to SQLite

### Migration Verification

`SessionStorageAdapter.verifyMigration()` compares source file and database JSONL content entry by entry:

```typescript
const result = await adapter.verifyMigration(sessionId, sourceContent);
// MigrationVerificationResult {
//   ok: boolean,
//   sessionId,
//   sourceEntries: number,
//   migratedEntries: number,
//   contentMatch?: boolean,
//   sourceCorruptLines?: number,
//   reason?: string
// }
```

### Export to JSONL

Sessions in SQLite can be exported back to JSONL format at any time:

```typescript
const jsonl = await adapter.exportJsonl(sessionId);
// Identical to the original JSONL file content
```

## File Paths and Conventions

```
~/.vera/
  sessions.db              # SQLite database (optional, when SQLite backend is enabled)
  projects/                # JSONL file storage directory
    <sanitized_cwd>/       # Project directory, path processed by sanitizePath()
      <uuid>.jsonl         # Single session file
  settings.json            # Global configuration
  memories/                # Memory files (optional)
```

Path sanitization rules (`sanitizePath`):
- Non-alphanumeric characters replaced with `-`
- Over-long paths (>80 chars): truncated with djb2 hash suffix to ensure uniqueness
- Paths resolved via `realpathSync` then NFC-normalized

## Backup and Recovery

### Backup

Two approaches:

1. **SQLite backup**: Copy the `.db` file directly (in WAL mode, also copy `-wal` and `-shm` files, or use `sqlite3 .backup` command)
2. **JSONL backup**: `.jsonl` files under `~/.vera/projects/` can be backed up with `tar` / `rsync`

### Recovery

- **SQLite**: Restore the backed-up `.db` file; Vera auto-detects and loads it
- **JSONL**: Place `.jsonl` files back into `~/.vera/projects/<sanitized_cwd>/` for session list discovery

## Performance Considerations

### WAL Mode

With WAL (Write-Ahead Logging) enabled, reads do not block writes, significantly improving performance under concurrent scenarios. The trade-off is slightly larger database file size (extra `.db-wal` and `.db-shm` files).

### Index Strategy

- `idx_kv_ns`: Used for namespace filtering, covers most business queries
- `idx_kv_created` and `idx_kv_updated`: Used for time-based sorting and filtering
- FTS5 index: Only enabled when full-text search is explicitly needed; increases write overhead and storage

### Batch Operations

For large bulk writes, prefer `setMany()` or transactions, which can be several times faster than individual `set()` calls.

### Session List Optimization

Session listing is a high-frequency operation. The SQLite backend extracts summaries directly from metadata without parsing full JSONL content. The JSONL backend uses progressive loading (reads only the first and last 64KB).

## Error Types

```typescript
class StorageError extends Error          // STORAGE_BACKEND, STORAGE_NOT_FOUND, ...
class StorageNotFoundError extends StorageError
class StorageConflictError extends StorageError
class StorageTransactionError extends StorageError
class StorageBackendError extends StorageError
```

## Current Test Coverage Status

Per the test plan in `docs/testing/storage/README.md`:

**Verified baseline**:
- Core: 75 test files, 1054 test cases
- Harness: 15 test files, 268 test cases
- Root typecheck passes

**Covered**:
- `SqliteStorageProvider`: Basic CRUD, query filtering, TTL expiry, synchronous API
- `SessionStorageAdapter`: Session CRUD, summary extraction, fork/branch
- `MemoryStorageAdapter`: Three-tier storage, search
- `UserDataStore`: data_save/data_load/data_list/data_delete

**Pending (P0)**:
1. `DataExporter` JSONL/CSV/JSON export tests
2. SQLite migration edge case tests (corrupt row handling, duplicate migration, verification reports)
3. SQLite branch error paths (adopt/merge on non-branch sessions, etc.)
4. Full memory persistence and search tests

**Pending (P1)**:
- User data TTL expiry and namespace isolation
- Combined query sorting and pagination
- Large-scale data performance tests (1K/10K sessions, 10K memory entries)

---

**Related files**:
- `packages/core/src/storage/types.ts` -- Storage interfaces and data models
- `packages/core/src/storage/sqlite.ts` -- SQLite engine implementation
- `packages/core/src/storage/session-adapter.ts` -- Session storage adapter
- `packages/core/src/session/sqlite-backend.ts` -- Session SQLite backend
- `docs/testing/storage/README.md` -- Test coverage plan

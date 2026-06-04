# Storage Test Coverage

> Module: `packages/core/src/storage/` | Test framework: Vitest
> Last updated: 2026-06-04

## Overview

Vera's storage layer is designed around the abstract `StorageProvider` interface. The current primary implementation is SQLite (via `better-sqlite3`), with auxiliary storage capabilities including file storage (`FileStore`) and object storage (`ObjectStore` + multi-cloud adapters). The storage layer supports three business domains -- session, memory, and user-data -- serving as the data foundation of the entire agent runtime.

The test directory `packages/core/src/storage/tests/` contains **26 test files**, totaling approximately **14,000 lines** of test code (source code approximately 6,300 lines), yielding a test-to-source ratio of approximately **2.2:1**.

## Test Layering Strategy

Storage tests are divided into four layers, integrated from the inside out:

| Layer | Test Files | Focus |
|---|---|---|
| **Unit Tests** | `sqlite.test.ts`, `entry-filter.test.ts` | Independent behavior of the SQLite provider, pure filter function logic |
| **Adapter Tests** | `session-adapter.*.test.ts`, `memory-adapter.test.ts`, `user-data.test.ts`, `data-exporter.test.ts`, `file-store.test.ts` | Business adapter correctness at their semantic level |
| **Object Storage Tests** | `object-store.test.ts`, `local-fs-adapter.test.ts`, `s3-adapter.test.ts`, `oss-adapter.test.ts`, `tos-adapter.test.ts` | Multi-cloud object storage adapters |
| **Integration Tests** | `integration.test.ts`, `migrate-jsonl.test.ts` | Cross-layer interaction, concurrent load, data migration |

## SQLite Testing Approach

### Core Strategy

SQLite tests use a **real database + temp directory** strategy, without mocks:

```
beforeEach: mkdtemp() create temp dir → create SqliteStorageProvider → initialize()
afterEach:  provider.close() → rm(tmpDir, { recursive: true })
```

Rationale:
- `better-sqlite3` is a synchronous C++ binding; mocking is costly and of limited value
- Temp directories ensure test isolation without needing to mock the filesystem
- WAL mode is tested out of the box, consistent with production

### Test Coverage Matrix

#### SqliteStorageProvider Core CRUD (sqlite.test.ts, 586 lines)

| Capability | Test Cases | Coverage Details |
|---|---|---|
| `set` / `get` | 6 | string, number, boolean, null, object, array -- covers all `StorageValue` types |
| `has` | 2 | returns true when exists, false when missing |
| `delete` | 2 | returns true when deleted, false when deleting non-existent |
| `listKeys` | 2 | multi-key sorted comparison, empty namespace returns [] |
| `clear` | 1 | only clears target namespace, does not affect other namespaces |
| Overwrite | 1 | second `set` on same key updates old value |
| Missing read | 1 | non-existent key returns undefined |

**Status**: Complete, well-covered.

#### Namespace Isolation (sqlite.test.ts)

| Capability | Test Cases |
|---|---|
| Different namespaces, same key independent | 1 |
| clear scope limited | 1 |

**Status**: Complete.

#### Batch Operations (sqlite.test.ts)

| Capability | Test Cases |
|---|---|
| `setMany` atomic batch write | 1 |
| `setMany` empty array (no-op) | 1 |
| `getMany` batch read (including missing keys) | 1 |
| `getMany` empty keys returns [] | 1 |

**Status**: Complete.

#### Query & Filtering (sqlite.test.ts + entry-filter.test.ts)

| Capability | Test Cases | Coverage Details |
|---|---|---|
| Full query | 1 | empty filter, verify entries / total / hasMore |
| `keyPrefix` filter | 1 | prefix filter, verify returned key list |
| `keyPattern` glob filter | 1 | `file.*` pattern matching |
| Paging (limit + offset) | 1 | 4-page traversal, verify hasMore boundaries |
| `orderBy` key asc/desc | 2 | alphabetical ascending/descending |
| `orderBy` createdAt | 1 | chronological order |
| `createdAfter` filter | 1 | future time returns empty |
| metadata (createdAt/updatedAt) | 1 | verify ISO format |
| `count` all | 1 | total matches |
| `count` filtered | 1 | count under keyPrefix |
| entry-filter pure functions | 3 | prefix+tags+FTS combination, expiry exclusion, glob pattern |

**Status**: Complete. Query dynamic SQL construction paths (including tags, hasTtl, updatedAfter/Before) are covered additionally by integration tests.

#### Transaction Support (sqlite.test.ts)

| Capability | Test Cases | Coverage Details |
|---|---|---|
| Normal commit | 1 | tx.set → commit → visible externally |
| Rollback | 1 | set + delete → rollback → no side effects |
| Read within transaction | 1 | tx.get reads externally committed data |
| Delete within transaction | 1 | tx.delete → commit → not visible externally |
| Double commit throws | 1 | second commit throws StorageTransactionError |
| Double rollback throws | 1 | second rollback throws StorageTransactionError |
| set after commit throws | 1 | checks ensureActive guard |

**Status**: Complete, covers all state transitions in the transaction lifecycle.

#### TTL Expiry Mechanism (sqlite.test.ts)

| Capability | Test Cases | Test Method |
|---|---|---|
| Expired entry `get` | 1 | manually insert expired entry (ttl=1, 2 seconds ago), verify returns undefined |
| Expired entry `has` | 1 | same scenario, has returns false |
| Unexpired entry (future TTL) | 1 | ttl=86400, verify normal return |
| TTL=null (permanent) | 1 | ancient timestamp, verify no reclamation |

**Status**: Complete. Expired data is triggered via lazy deletion on `get`/`has`.

**Known limitations**: No direct test for `cleanupExpired` periodic cleanup (`startCleanupTimer`). Cleanup logic relies solely on internal `setInterval` + `unref()`. Tests depend on time waiting.

#### FTS5 Full-Text Search (sqlite.test.ts)

| Capability | Test Cases |
|---|---|
| Keyword matches multiple entries | 1 |
| Excludes non-matching entries | 1 |
| Query with no keywords works when FTS enabled | 1 |

**Status**: Basic coverage complete.

**Known limitations**:
- Not covering FTS5 Chinese tokenization capability (better-sqlite3 default tokenizer is `unicode61`, limited Chinese support)
- Not covering `fullTextSearch` parameter degradation when FTS5 is not enabled (currently silently ignored, controlled by `isFts` flag in buildQuery; non-FTS paths won't enter MATCH clause)
- Not covering FTS trigger correctness (FTS index sync after INSERT/UPDATE/DELETE)

#### Error Handling (sqlite.test.ts)

| Scenario | Test |
|---|---|
| Missing `dbPath` at construction | Throws `StorageBackendError` |
| All operations after close throw | Covers set / get / has / delete / listKeys / clear / setMany / getMany / query / count -- 10 methods |
| close is idempotent | Second close does not throw |
| isHealthy state | Correctly switches before/after close |

**Status**: Complete.

#### Concurrent Access (sqlite.test.ts + integration.test.ts)

| Scenario | Data Volume | Test File |
|---|---|---|
| 50 concurrent set → per-key validation | 50 | sqlite.test.ts |
| 5 concurrent getMany (same key set) | 20×5 | sqlite.test.ts |
| 100 concurrent write | 100 | integration.test.ts |
| 5 concurrent setMany (10 entries each) | 50 | integration.test.ts |
| Concurrent read/write mix | 7 operations concurrent | integration.test.ts |

**Status**: Lightweight concurrency tests complete. SQLite WAL mode + `busy_timeout=5000` provides basic concurrency safety.

**Known limitations**: No multi-connection concurrency tests (always using a single `Database` instance), no WAL file growth or checkpoint scenario simulation.

## Migration Testing

### JSONL → SQLite Migration (migrate-jsonl.test.ts + integration.test.ts)

JSONL migration is the critical path for Vera's transition from early file storage to SQLite.

| Test Scenario | Cases |
|---|---|
| Basic migration (single file) | 1 |
| Skip already-migrated session | 1 |
| Empty directory | 1 |
| Non-existent directory | 1 |
| Empty file | 1 |
| Multi-file batch migration | 1 |
| Skip unparseable content | 1 |
| Mix of valid/invalid lines | 1 |
| session_end extracts metadata (turnCount/costUsd) | 1 |
| custom-title extracts title | 1 |
| ai-title extracts title | 1 |
| tag extraction | 1 |
| Integration: post-migration content integrity validation | 1 |

**Status**: Complete, covering both normal and error paths.

**Known limitations**:
- Not tested for large-scale migration performance (>1000 session files)
- Not tested for crash-consistency during migration
- Not tested for deep `contentMatch` comparison in `MigrationVerificationResult` (currently only validates entryCount)

## Backup & Recovery Testing

**Status: Not implemented (planned).**

No explicit backup/recovery mechanism exists in the current codebase:

- `StorageOptions` defines `autoVacuum?: boolean`, but `SqliteStorageProvider`'s `initialize()` method does not use this parameter
- No `backup()` / `restore()` API exists
- No WAL checkpoint or `VACUUM` invocation code exists
- No point-in-time recovery concept exists

Current "recovery" capability relies on:
- Crash-safe guarantees provided by WAL mode (no lost writes)
- `DataExporter` can export all data (JSONL/CSV/JSON), usable as a semi-automated backup

**Planned tests**:
- `PRAGMA integrity_check` database health check
- `PRAGMA wal_checkpoint` manual checkpoint test
- `VACUUM` space reclamation test
- Simulated WAL crash recovery (kill process mid-write, verify data not lost on reopen)
- API-based backup (`sqlite3_backup_init` or `.dump` export test)

## Performance Baselines

**Status: Basic coverage (no formal baseline system established).**

### Existing Performance-Related Tests

| Test | Data Volume | Verification Method |
|---|---|---|
| count operation timing | 500 entries | `elapsed < 1000ms` (loose upper bound) |
| keyPrefix query + orderBy | 500 entries | Correctness verification (no timing) |
| Full pagination traversal | 500 entries, pageSize=50 | Correctness + sort integrity |
| 100 concurrent writes | 100 entries | No data corruption |

**Known limitations**:
- 500 entries cannot reflect real production load (expected single-user sessions can reach tens of thousands of messages)
- No large-scale insertion baselines (10K, 100K, 1M entries)
- No WAL vs DELETE journal mode comparison
- No FTS5 index query performance impact test
- No batch insert (transaction vs row-by-row) performance comparison
- No cross-platform performance consistency verification

### Planned Performance Test System

| Scenario | Data Scale | Metrics of Interest |
|---|---|---|
| Batch insert | 1K / 10K / 100K entries | tps, peak memory |
| Paginated query | Query within 100K entries | P50/P99 latency |
| FTS5 full-text search | 10K text entries | Search latency vs no index |
| WAL checkpoint | After 10K writes | Checkpoint duration, WAL file size |
| Concurrent read/write | 5 read + 5 write goroutines | Throughput, busy retry count |

## Test Coverage Summary

### SQLite Core (sqlite.ts)

| Capability | Coverage | Status |
|---|---|---|
| Basic CRUD | Comprehensive | Complete |
| Namespace isolation | Comprehensive | Complete |
| Batch operations | Comprehensive | Complete |
| Query + filtering (8 filter types) | Comprehensive | Complete |
| Transactions (7 states) | Comprehensive | Complete |
| TTL expiry (4 scenarios) | Comprehensive | Complete |
| FTS5 full-text search | Basic | Complete (pending Chinese/perf extensions) |
| Error handling (11 scenarios) | Comprehensive | Complete |
| Concurrent access | Basic | Complete (pending multi-connection) |
| sync helper methods (setSync/getSync/listKeysSync) | Not covered | Used indirectly by SessionAdapter / MemoryAdapter |
| setWithMeta / getRow / deleteRow | Not covered | Used internally by Transaction implementation |

### Adapter Layer

| Adapter | Test Files | Test Lines | Status |
|---|---|---|---|
| SessionStorageAdapter | 4 files (crud / write / transcript / advanced) | 1,447 | Complete |
| MemoryStorageAdapter | memory-adapter.test.ts | 1,207 | Complete |
| UserDataStore | user-data.test.ts | 601 | Complete |
| DataExporter | data-exporter.test.ts | 1,394 | Complete |
| FileStore | file-store.test.ts | 1,141 | Complete |
| ContentUploader | 6 files | 1,600+ | Complete |
| ArtifactUploader | No standalone tests | 0 | Planned |

### Object Storage Adapters

| Adapter | Test Files | Test Lines | Status |
|---|---|---|---|
| ObjectStore interface | object-store.test.ts | 987 | Complete |
| LocalFsAdapter | local-fs-adapter*.test.ts | 759 | Complete |
| S3Adapter | s3-adapter.test.ts | 1,254 | Complete |
| OssAdapter | oss-adapter.test.ts | 1,233 | Complete |
| TosAdapter | tos-adapter.test.ts | 1,042 | Complete |

### Integration

| Test | Lines | Status |
|---|---|---|
| Cross-layer integration (SQ9) | 719 | Complete |
| JSONL migration (SQ4) | 190 | Complete |

## Running Tests

```bash
# Run all storage tests
pnpm --filter @open-vera/core test -- src/storage/

# Run SQLite core tests only
pnpm --filter @open-vera/core test -- src/storage/tests/sqlite.test.ts

# Run integration tests
pnpm --filter @open-vera/core test -- src/storage/tests/integration.test.ts

# Run coverage
pnpm --filter @open-vera/core run test:coverage
```

## TODOs & Improvements

| Priority | Item | Description |
|---|---|---|
| P1 | Backup/recovery API | Provide `backup(destPath)` / `restore(srcPath)` API + tests |
| P1 | Database integrity check | `PRAGMA integrity_check` periodic validation + tests |
| P1 | WAL checkpoint | Manual trigger + auto-threshold checkpoint tests |
| P2 | Large-scale performance baselines | 10K/100K-level data insert and query benchmarks |
| P2 | FTS5 Chinese search | Chinese tokenizer verification |
| P2 | Multi-connection concurrency | Safety tests for concurrent read/write with multiple Database instances |
| P2 | ArtifactUploader tests | Add standalone unit tests |
| P3 | Cross-platform compatibility | Windows paths, case sensitivity tests |
| P3 | Disk full / write failure simulation | Error recovery path tests |
| P3 | Schema version upgrades | Migration tests for future table structure changes |

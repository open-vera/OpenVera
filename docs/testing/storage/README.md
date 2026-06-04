# Storage & UI Test Coverage Plan

> Scope: Phase 9 SQLite/file storage, session migration, memory storage, user data, data export, and the new UI/API surfaces.
> Status: Draft coverage plan for SQ9 and black-box regression.

## Current Verified Baseline

Run these before and after storage-related changes:

```bash
pnpm typecheck
pnpm test
pnpm --filter @open-vera/core typecheck
pnpm --filter @open-vera/core test
pnpm --filter @open-vera/gateway build
pnpm --filter @vera/gateway-ui-server build
pnpm --filter @vera/gateway-ui-web build
```

Current passing baseline after the latest merge:

- Core: 75 test files, 1054 tests
- Harness: 15 test files, 268 tests
- Root typecheck: core, harness, benchmark, gateway packages
- UI builds: gateway-ui server, gateway-ui web

## Feature Surface To Cover

### Storage Providers

- `SqliteStorageProvider`: key/value CRUD, query filters, TTL, tags, FTS, transactions, sync helpers.
- `FileStorageProvider`: file-backed key/value CRUD and query behavior.
- `SessionStorageAdapter`: session JSONL content stored in SQLite, summary/list/load APIs, fork/branch APIs, import/export/verification.
- `MemoryStorageAdapter`: working/episodic/semantic tiers, FTS/search, persistence, decay, compression/organize entry points.
- `UserDataStore`: `data_save`, `data_load`, `data_list`, `data_delete`, namespace, TTL, validation.
- `DataExporter`: generic namespace export plus sessions/memory/user-data export to JSONL/CSV/JSON.

### Session Backends

- JSONL backend remains the default.
- SQLite backend is opt-in through `SessionStore.configureSqlite()` or direct `SQLiteSessionBackend`.
- SQLite backend must preserve JSONL compatibility and branch/session semantics.

### UI/API

- Harness UI server:
  - `GET /api/runs`
  - `POST /api/runs`
  - `GET /api/flows`
  - `GET /api/runs/:runId`
  - `GET /api/runs/:runId/timeline`
  - `GET /api/runs/:runId/memory`
  - `GET /api/runs/:runId/checkpoints`
  - `GET /api/runs/:runId/checkpoints/:checkpointId`
  - `GET /api/runs/:runId/subagents`
- Admin UI server:
  - `GET /api/admin/overview`
  - `GET /api/admin/containers`
  - `GET /api/admin/resources`
  - `GET /api/admin/spaces`
  - `GET /api/admin/spaces/:scopeId`
  - `GET /api/admin/heatmap`
- Core UI web:
  - Runs list
  - Run detail
  - Memory
  - Checkpoints
  - Subagents

## Coverage Gaps

### P0: Add First

1. **DataExporter unit tests**
   - `exportData()` JSONL/CSV/JSON.
   - `includeMetadata=false`.
   - CSV escaping for comma, quote, newline, nested object.
   - Empty result.
   - Query filter passthrough.
   - `exportSessions()` with selected session IDs.
   - `exportMemory()` tier filtering.
   - `exportUserData()` namespace filtering.

2. **SQLite session migration edge cases**
   - Corrupt JSONL line handling in `verifyMigration()`.
   - Missing session verification result.
   - Duplicate `importSession()` behavior: document and assert overwrite semantics.
   - `exportJsonl()` exact raw content round-trip.
   - Migration skips empty files and already-migrated sessions.

3. **SQLite backend branch/error paths**
   - `adoptBranch()` and `markBranchMerged()` on non-branch sessions.
   - `writeUser()` / `writeAssistant()` / `writeEnd()` on missing session.
   - `listBranches(parent, cwd)` respects cwd when branch sessions have different cwd.
   - Latest `git-branch`, tag, title, and branch status win when multiple metadata entries exist.

4. **Memory adapter persistence/search**
   - Restart rebuilds searchable state.
   - `maxWorkingEntries` eviction.
   - `workingTtlSeconds` expiry.
   - FTS/search handles punctuation, mixed case, and Chinese text.
   - Concurrent add/search smoke.

### P1: Broaden

1. **User data**
   - TTL expiry.
   - Namespace isolation.
   - Overwrite preserves `createdAt` and updates `updatedAt`.
   - Validation errors for invalid key/namespace/value.

2. **Storage query**
   - Combined tags + time filters.
   - Pagination with `limit`/`offset`.
   - Sort by `createdAt`, `updatedAt`, and key where supported.
   - Expired rows excluded by default.

3. **UI/API**
   - Server route smoke for success, 404, invalid method, empty data.
   - Web build plus Playwright smoke for route rendering.
   - Empty/loading/error states render without layout overlap.

### P2: Hardening

1. **Performance**
   - Session list on 1k, 10k sessions.
   - Memory search on 10k entries.
   - Export large namespace to JSONL without excessive memory growth.

2. **Reliability**
   - SQLite close/reopen cycles.
   - WAL mode on/off.
   - Transaction rollback.
   - Process interruption during migration, followed by rerun.

3. **Compatibility**
   - JSONL created by old file backend imports into SQLite.
   - SQLite export can be consumed by JSONL backend or external tools.

## Proposed Test Files

```text
packages/core/src/storage/tests/data-exporter.test.ts
packages/core/src/storage/tests/session-migration-edge.test.ts
packages/core/src/storage/tests/storage-query-integration.test.ts
packages/core/src/storage/tests/memory-persistence-search.test.ts
packages/core/tests/session-sqlite-branch-errors.test.ts
apps/gateway-ui/server/tests/routes.test.ts
apps/gateway-ui/web/tests/smoke.spec.ts
```

If UI Playwright is too heavy for this phase, start with server route smoke tests and keep browser smoke as a follow-up.

## Black-Box Test Plan

### 1. SQLite Session End-To-End

Goal: verify public APIs, not implementation details.

Steps:

1. Create a temp SQLite DB.
2. Configure `SessionStore` with SQLite.
3. Write session start, user, assistant, tool call/result, metadata, end.
4. Immediately load session and transcript preview.
5. List sessions with cwd filter.
6. Fork session.
7. Adopt, merge, discard branch.
8. Export JSONL.
9. Import JSONL into a second DB.
10. Verify migration and load imported session.

Expected:

- Writes are immediately visible.
- Transcript preview includes tool use and result.
- Summary contains title, tag, git branch, usage, turn count.
- Branch statuses transition correctly.
- Exported JSONL imports into a second DB with matching entry count/content.

### 2. Storage Export End-To-End

Steps:

1. Seed sessions, memory, and user-data into SQLite.
2. Export each to JSONL, CSV, and JSON.
3. Parse JSON output.
4. Parse JSONL line by line.
5. Validate CSV headers and row count.
6. Repeat with filters: memory tier, user namespace, selected session IDs.

Expected:

- Export count matches seeded data.
- JSON and JSONL are parseable.
- CSV escapes commas/quotes/newlines.
- Filters exclude unrelated records.

### 3. Memory Persistence And Search

Steps:

1. Create SQLite DB.
2. Add working, episodic, semantic memories.
3. Search by keyword across tiers.
4. Close adapter.
5. Reopen adapter on same DB.
6. Search again.
7. Record access and run decay.

Expected:

- Entries persist after restart.
- Search returns expected tiers.
- Decay never drops below configured minimum.
- Access updates metadata.

### 4. User Data Tool Flow

Steps:

1. Use `data_save` to store values in two namespaces.
2. Use `data_load` for exact key lookup.
3. Use `data_list` by namespace.
4. Overwrite one key.
5. Delete one key.

Expected:

- Namespace isolation holds.
- Overwrite updates value without duplicating key.
- Deleted key cannot be loaded.
- Invalid inputs return validation errors.

### 5. UI/API Smoke

Start services:

```bash
pnpm serve
pnpm admin-serve
pnpm ui
pnpm admin
pnpm core
```

API checks:

```bash
curl -fsS http://localhost:7700/api/runs
curl -fsS http://localhost:7700/api/flows
curl -fsS http://localhost:7710/api/admin/overview
curl -fsS http://localhost:7710/api/admin/spaces
curl -fsS http://localhost:7710/api/admin/heatmap
```

Browser checks:

- Harness UI loads run list and handles empty state.
- Admin UI loads dashboard, spaces, settings.
- Core UI loads runs, detail, memory, checkpoints, subagents.
- Refresh each route directly and confirm it still renders.

Expected:

- No blank pages.
- No console errors for normal empty state.
- API 404s are structured and CORS preflight works.
- Text does not overlap at desktop and mobile widths.

## Manual Regression Checklist

Use this before merging storage/UI changes:

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm --filter @open-vera/core test`
- [ ] `pnpm --filter @open-vera/gateway build`
- [ ] `pnpm --filter @vera/gateway-ui-server build`
- [ ] `pnpm --filter @vera/gateway-ui-web build`
- [ ] SQLite session black-box flow passes.
- [ ] Data export black-box flow passes.
- [ ] UI/API smoke passes.
- [ ] No `package-lock.json` with private registry URLs is staged.
- [ ] No conflict markers: `rg -n "<<<<<<<|=======|>>>>>>>"`.

## SQ9 Acceptance Criteria

SQ9 can be marked complete when:

- At least 12 new integration tests cover SQLite CRUD, migration, export, memory, and user data.
- `DataExporter` has direct tests for JSONL/CSV/JSON.
- A black-box SQLite session flow exists as a script or test.
- UI/API route smoke exists for harness-ui server and admin-ui server.
- Root `pnpm typecheck` and `pnpm test` pass.

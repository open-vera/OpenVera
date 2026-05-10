# Changelog

All notable changes to OpenVera will be documented in this file.

## [Unreleased] — feature/p1-checkpoint-resume

> Branch: `feature/p1-checkpoint-resume` | 2026-05-10

### Added

#### Checkpoint & Resume
- **`CheckpointStore`** — JSONL-based persistent checkpoint store with auto-compaction, dedup, and configurable `compactAfter`/`compactToKeep` thresholds
- **`checkpointFromFlow`** — Converts a live `TaskFlow` + artifacts into a serializable checkpoint record
- **Flow state machine** — `canTransition` / `isFlowDone` / `assertTransition` for valid Harness state transitions
- **Checkpoint compaction** — `InvertedIndex`-backed compression for memory-bounded stats; configurable `maxRecords` (default 1000)

#### Memory System
- **Thread-safe concurrent writes** — Mutex-protected episodic/working stores; multi-instance interleaving safety
- **Atomic crash-safety** — Sync temp-file write + atomic rename; corrupted JSONL entries auto-skipped with warning
- **Tier separation** — Semantic search index / episodic JSONL store / working ephemeral map maintained independently
- **Memory search perf** — InvertedIndex for O(1) tag lookups; batch insert with linear search fallback

#### Subagent System
- **Subagent Pool** — Queue-based concurrency limiter; `submit`/`complete`/`fail`/`cancel`/`status`; configurable `maxConcurrent`
- **Subagent Orchestrator** — Dependency DAG runner; parallel execution; abort/timeout support; graceful error propagation
- **Agent Runner Registry** — Capability-tagged runner lookup; `findByCapabilities`; `getAvailable` with multi-level fallback chains

#### Tool Middleware
- **Multi-layer pipeline** — `before` (args transform/validate/reject) → `after` (result transform) → `onError` (recovery)
- **Error isolation** — Each middleware layer catches its own errors; `onError` fires on any upstream failure
- **`skip` support** — Middleware can return `{ skip: true, result }` to bypass execution

#### Type Safety
- **Agent barrel export** — `@open-vera/harness/agent` exports loop, subagent, pool, orchestrator types
- **Typed session errors** — `SessionNotFoundError` / `SessionNotBranchError` replaces raw `throw new Error()`
- **`ToolDef` default generic** — `TArgs = Record<string, unknown>` eliminates `ToolDef<any>` boilerplate

### Fixed

- **`-v` / `--version` / `-h` CLI flags** — Lazy import `flow-run`/`repl-run` to avoid `ERR_MODULE_NOT_FOUND` on minimal invocations
- **Memory search off-by-one** — Fixed `i < 50` → `i <= 50` in InvertedIndex test (was skipping 50th entry)
- **SubagentPool error message** — `Error("Pool full")` → `Error("Queue is full")` to match implementation
- **Checkpoint dedup** — `compact()` returns `Set` instead of array for O(1) duplicate detection

### Testing

- **22 new tests** — SubagentPool (submit/complete/fail/cancel/status/edge cases)
- **28 new tests** — SubagentOrchestrator (run, dependencies, errors, abort, timeout)
- **21 new tests** — MemoryStore persistence (concurrent writes, corrupted JSONL, edge cases, atomic crash safety)
- **21 new tests** — CheckpointStore boundary cases (empty/corrupt JSONL, oversized checkpoints, filesystem safety)
- **4 new tests** — Tool middleware error isolation (before errors, onError priority, skip behavior, middleware ordering)
- **33 new tests** — Checkpoint compaction (dedup, prune-to-N, auto-compact on save, atomic write safety)
- **10 new tests** — Checkpoint resume flow (plan → checkpoint → resume → fork → compact)
- **22 new tests** — AgentRunnerRegistry fallback (multi-chain, missing runners, isReady resilience, capability separation)
- **10 new tests** — Tool middleware pipeline (args chaining, after result modification, error propagation, non-existent tool)
- **5 new tests** — E2E smoke (plan → checkpoint → tool → agent → state machine full pipeline)
- **7 new tests** — Typed session errors (`SessionNotFoundError` / `SessionNotBranchError` verification)
- **2 new tests** — ToolStatsCollector memory bounds (`maxRecords` = 1000)

**Total: 605 tests across 64 files — all passing**

---

## Prior Releases

See git history for earlier changes.

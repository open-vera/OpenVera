# OpenVera P0 Improvement Plan — Continuous Improvement Tracker

> Generated: 2026-05-10 16:07 | Branch: feature/p1-checkpoint-resume
> Status: 59 test files | 513 passed / 0 failed | 225 source files

---

## I. Known Issues (Must Fix)

### 1. CLI Test Failures (3 tests) -- Fixed
- **File**: `packages/harness/tests/cli-flags.test.ts`
- **Fix**: Changed static imports of `flow-run.ts` and `repl-run.ts` to dynamic `await import()`, avoiding ERR_MODULE_NOT_FOUND when `-v`/`-h` flags don't need those modules.

### 2. P1 #5 Subagent Enhancement Code Not Committed
- `subagent-pool.ts` and `subagent-orchestrator.ts` written but untested, uncommitted.
- Needed: write tests -> fix issues -> commit.

---

## II. P0 Feature Completion Checklist

### A. Code Quality & Robustness

| # | Item | Description | Status |
|---|------|-------------|--------|
| A1 | CLI flags fix | Fix `-v`/`--version`/`-h` to pass tests | Done |
| A2 | Subagent Pool tests | Full tests for `subagent-pool.ts` | Done |
| A3 | Subagent Orchestrator tests | Full tests for `subagent-orchestrator.ts` | Done |
| A4 | Memory Store persistence validation | Verify Episodic/Semantic JSONL file read/write safety under concurrency | Done |
| A5 | Checkpoint Store edge case tests | Empty checkpoints, corrupted JSONL, oversized checkpoints | Done |
| A6 | Tool Registry middleware error isolation | One middleware throwing must not affect others | Done |

### B. Performance Optimization

| # | Item | Description | Status |
|---|------|-------------|--------|
| B1 | Memory Search performance | Current O(n) scan may be slow at scale, consider indexing or limits | Done |
| B2 | Checkpoint compaction | Checkpoint JSONL can grow unbounded, needs periodic compaction | Done |
| B3 | Tool Stats memory control | ToolStatsCollector already has maxRecords, verify default is reasonable | Done |

### C. Architecture Improvements

| # | Item | Description | Status |
|---|------|-------------|--------|
| C1 | Agent index exports | `packages/core/src/agent/index.ts` needs to export pool/orchestrator | Done |
| C2 | Type safety hardening | Global search for `any` usage, progressively replace with concrete types | Done |
| C3 | Error handling unification | Ensure all modules use unified error types, no mixing Error + string | Done |

### D. Test Coverage

| # | Item | Description | Status |
|---|------|-------------|--------|
| D1 | Memory Store concurrent write tests | Multiple async writes don't lose data | Done |
| D2 | Checkpoint resume full flow test | plan -> checkpoint -> resume -> verify | Done |
| D3 | AgentRunnerRegistry fallback tests | Fallback chain with multiple runners | Done |
| D4 | Tool Middleware full pipeline test | before -> execute -> after -> onError full chain | Not Done |
| D5 | End-to-end smoke test | Simulate full agent loop: plan -> dispatch -> execute -> checkpoint | Not Done |

### E. Documentation & Cleanup

| # | Item | Description | Status |
|---|------|-------------|--------|
| E1 | API documentation | Generate TypeDoc or write README for new modules | Not Done |
| E2 | CHANGELOG update | Record P1 milestone | Not Done |
| E3 | Unused import cleanup | grep and remove unused imports | Not Done |

---

## III. Execution Strategy

1. **Auto-check every 5 minutes**, execute by priority:
   - Fix failing tests (A1) -> Add tests (A2-A6) -> Architecture (C1-C3) -> Test coverage (D1-D5) -> Performance (B1-B3) -> Documentation (E1-E3)
2. **Complete one item per cycle**, commit, then continue to next
3. **When all items complete**, cancel scheduled task

---

## IV. Progress Tracking

| Time | Completed | Test Delta |
|------|-----------|------------|
| 2026-05-10 16:16 | A1 | 430/0 (CLI flags fix: lazy-import flow-run/repl-run) |
| 2026-05-10 16:21 | A2 | +34 tests (SubagentPool: submit/complete/fail/cancel/status/edge cases) |
| 2026-05-10 16:30 | A3 | +28 tests (SubagentOrchestrator: run, dependencies, errors, abort, etc.) |
| 2026-05-10 16:42 | A4 | +21 tests (Memory Persistence: concurrent write safety, corrupted JSONL skip, edge cases, atomic write crash safety) |
| 2026-05-10 16:48 | A5 | +21 tests (Checkpoint Edge Cases: empty/blank files, corrupted JSONL skip, oversized checkpoints, filesystem edge values, duplicate IDs, rapid sequential saves) |
| 2026-05-10 16:51 | A6 | +4 tests (Tool Middleware Isolation: before error isolation, onError first-recovery priority, skip still executes after, middleware order preserved) |
| 2026-05-10 17:10 | B1 | Fixed memory-search-perf off-by-one bug (i<50->i<=50), confirmed InvertedIndex perf correct |
| 2026-05-10 17:20 | B2 | +33 tests (Checkpoint Compaction: dedup, prune to N, auto-compact on save, atomic write safety, lineCount/needsCompaction) |
| 2026-05-10 17:24 | B3 | +2 tests (ToolStatsCollector default maxRecords=1000, registry also uses 1000; reduced from 10000 to limit memory) |
| 2026-05-10 17:30 | C1 | New agent/index.ts barrel export (loop + subagent + pool + orchestrator), tsc + 563 tests pass |
| 2026-05-10 17:37 | C2 | Removed 3 `ToolDef<any>` -> `ToolDef` in ToolRegistry (using default generic TArgs=Record<string,unknown>), 563 tests pass |
| 2026-05-10 17:59 | C3 | session/store.ts 4 `throw new Error` -> `SessionNotFoundError`/`SessionNotBranchError`, +7 tests (typed error verification), 570 tests pass |
| 2026-05-10 20:58 | D3 | +21 tests (AgentRunnerRegistry fallback chain: primary always ready, long chain, no isReady, capability separation, register overwrite/edge, get/has edge, findByCapabilities edge, toMap empty/non-empty); 43 tests total, all pass |
| 2026-05-10 21:42 | D5 | +5 tests (E2E smoke: plan->checkpoint->tool->agent->state machine pipeline; 605 total tests pass) |

*This document is maintained by the automated improvement workflow, updated each cycle.*

# Test Coverage Overview

> Project: open-vera (monorepo) | Test framework: Vitest + v8 coverage
> Last updated: 2026-06-04

## Overview

The Vera project uses Vitest as its test framework with v8 as the coverage provider. Testing is a prerequisite for commits, and coverage threshold checks are enforced in CI.

## Coverage Targets and Thresholds

Per the project CLAUDE.md requirements:

| Target | Threshold |
|--------|-----------|
| Global lines coverage | >= 90% |
| Core modules (tools/ storage/ adapters/ config/ memory/ context/ utils/) | >= 80% |
| E2E tests | Located in `packages/harness/tests/e2e-*.ts` |

> Note: CLAUDE.md mandates >= 90% coverage. The `vitest.config.ts` does not set hard `thresholds` config -- thresholds are enforced via scripts in CI and pre-commit checks.

### Pre-Commit Checklist

1. Run `pnpm --filter @open-vera/core run test:coverage`, confirm lines coverage >= 90%
2. Run `bash .claude/skills/quality-scan/scan.sh`, oxlint / sonarjs must have no `error`-level findings
3. New business logic must have corresponding unit tests
4. Pure type definitions, config files, and docs may skip tests

## Running Coverage

```bash
# Core package coverage (most common)
pnpm --filter @open-vera/core run test:coverage

# Full coverage (all packages)
pnpm test:coverage

# Run tests only (no coverage)
pnpm test
pnpm --filter @open-vera/core test
pnpm --filter @open-vera/harness test
```

### Vitest Configuration

**File**: `packages/core/vitest.config.ts`

```typescript
export default defineConfig({
  test: {
    globals: true,
    exclude: ["dist/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**"],
    },
  },
});
```

Output formats:
- `text`: terminal table output (summarized by module)
- `lcov`: generates `coverage/lcov.info`, viewable with VS Code plugins or `lcov-html` for detailed line-level coverage

## Current Coverage Status

Below is the coverage snapshot from the most recent run (by module):

| Module | Statements | Branches | Functions | Lines |
|--------|-----------|----------|-----------|-------|
| **Global aggregate** | 78.39% | 69.88% | 79.97% | 79.76% |
| **src/tools/** | 98.28% | 95.18% | 99.14% | 98.45% |
| **src/storage/** | 97.70% | 92.93% | 98.64% | 98.71% |
| **src/context/** | 94.96% | 89.91% | 100% | 95.99% |
| **src/config/** | 98.90% | 96.23% | 100% | 100% |
| **src/memory/** | 96.79% | 89.54% | 100% | 97.39% |
| **src/adapters/** | 97.24% | 88.32% | 100% | 98.09% |
| **src/session/** | ~97% | ~92% | ~100% | ~97% |
| **src/agent/** | ~94% | ~83% | ~100% | ~96% |
| **src/utils/** | 97.12% | 88.13% | 100% | 100% |
| **src/rag/** | ~98% | ~92% | ~90% | ~98% |
| **src/sandbox/** | ~95% | ~86% | ~100% | ~96% |
| **src/worktree/** | 83.33% | 68.57% | 100% | 85.96% |
| **src/tools/index.ts** | 71.79% | 55.55% | 100% | 71.79% |

> Note: The global aggregate of 78.39% is below the 90% target, primarily dragged down by `src/worktree/` and `src/tools/index.ts` (the latter is a factory function with many conditional branches, tested at 71.79%).

### Core Module Threshold Compliance

| Core Module | Lines Coverage | >= 80% Threshold? |
|-------------|---------------|-------------------|
| tools/ | 98.45% | Pass |
| storage/ | 98.71% | Pass |
| adapters/ | 98.09% | Pass |
| config/ | 100% | Pass |
| memory/ | 97.39% | Pass |
| context/ | 95.99% | Pass |
| utils/ | 100% | Pass |

All core modules exceed the 80% threshold.

## Test File Structure

```
packages/core/src/
  context/tests/           # compression.test.ts, tokens.test.ts, window.test.ts
  tools/tests/             # Per-tool test files (20+)
  storage/tests/           # Storage layer tests (SQLite, session, data-exporter, etc.)
  memory/tests/            # Memory system tests
  adapters/tests/          # LLM adapter tests
  rag/tests/               # RAG vector store tests
  sandbox/tests/           # Sandbox tests
  session/tests/           # Session management tests
  agent/tests/             # Agent Loop tests

packages/harness/tests/    # Harness integration tests
  e2e-*.ts                 # E2E tests
```

Test framework conventions:
- Test files live alongside source files, in a `tests/` subdirectory
- Test file naming: `<module-name>.test.ts`
- Use `describe` / `it` / `expect`
- Mock only external API calls (LLM adapters, network requests), never internal modules

## Coverage Gaps and Known Deficiencies

### Primary Gaps

1. **`src/worktree/`** (Lines: 85.96%) -- Git worktree management, with branches in error handling and edge cases not fully covered.
2. **`src/tools/index.ts`** (Lines: 71.79%) -- `createToolRegistry()` factory function contains many conditional branches (`if (opts.memoryStore) ...` etc.); each `if` branch needs its own test scenario.
3. **`src/tools/computer-use.ts`** (Lines: 94.96%) -- Some error paths and timeout scenarios in Computer Use not covered.
4. **`src/tools/bash.ts`** (Lines: 98.59%) -- Process group kill signal paths and spawn error edge cases not fully covered (lines 13 and 75-84).

### Planned Supplementary Tests

Per the coverage plan in `docs/testing/storage/README.md`:

- **P0**: DataExporter unit tests, SQLite migration edge cases, branch error paths, Memory persistence/search tests
- **P1**: User Data TTL/namespace tests, Storage query combined filtering, UI/API route smoke tests
- **P2**: Performance tests (large session lists, memory search), reliability tests (SQLite close/reopen, WAL, transaction rollback)

### Tool File Test Checklist

Each tool file has a corresponding test file. Current status:

| Tool File | Test File | Lines Coverage |
|-----------|-----------|----------------|
| `read-file.ts` | `read-file.test.ts` | 100% |
| `write-file.ts` | `write-file.test.ts` | ~99% |
| `edit-file.ts` | `edit-file.test.ts` | 100% |
| `list-dir.ts` | `list-dir.test.ts` | ~98% |
| `glob.ts` | `glob.test.ts` | ~97% |
| `grep.ts` | `grep.test.ts` | 97.43% |
| `bash.ts` | `bash.test.ts` | 98.59% |
| `security.ts` | `security.test.ts` | 100% |
| `registry.ts` | `registry.test.ts` | 99.23% |
| `tool-stats.ts` | `tool-stats.test.ts` | 97.61% |

## Static Analysis Tools

Beyond coverage, the project uses three static analysis tools for quality assurance (see `docs/code-governance/static-analysis.md`):

### oxlint -- Structural Metrics

Rust implementation, multi-threaded parallelism, extremely fast (~0.1s).

| Metric | Rule | Warn | Error |
|--------|------|------|-------|
| File total lines | `max-lines` | 300 | 600 |
| Function body lines | `max-lines-per-function` | 50 | 100 |
| Cyclomatic complexity | `complexity` | 10 | 20 |
| Nesting depth | `max-depth` | 4 | 6 |
| Parameter count | `max-params` | 4 | 7 |

### eslint-plugin-sonarjs -- Cognitive Complexity

Parses AST only (no projectService), 10-20x faster than full lint.

| Rule | Threshold |
|------|-----------|
| `cognitive-complexity` | warn at 15 |
| `no-identical-functions` | warn |
| `no-duplicated-branches` | warn |

### jscpd -- Duplication Detection

Token-level matching (unaffected by variable renaming). Threshold: min-tokens = 50.

### Execution

```bash
# One-command full static analysis + coverage
bash .claude/skills/quality-scan/scan.sh
```

Outputs terminal summary + `docs/code-governance/report-<date>.md`.

## Test Run Pipeline

### Local Development

```bash
# Type check
pnpm typecheck

# Core package tests
pnpm --filter @open-vera/core test

# Core package coverage
pnpm --filter @open-vera/core run test:coverage

# Harness tests
pnpm --filter @open-vera/harness test

# Full test suite
pnpm test

# Quality scan (oxlint + sonarjs + jscpd)
bash .claude/skills/quality-scan/scan.sh
```

### Mandatory Pre-Commit Flow

```
1. pnpm --filter @open-vera/core run test:coverage  # lines >= 90%
2. bash .claude/skills/quality-scan/scan.sh          # no errors
3. git add <specific files>                          # no git add -A
4. git commit -m "feat(scope): description"          # follow conventions
```

### CI Integration (Planned)

Per pending items in static-analysis.md:

- [ ] Auto-run coverage + quality scan on PR
- [ ] Post coverage report and scan summary as PR comment
- [ ] Trend tracking: compare multiple scan results, observe quality trends

## Test Scale

| Package | Test Files | Test Cases |
|---------|-----------|------------|
| @open-vera/core | ~75 | ~1054 |
| @open-vera/harness | ~15 | ~268 |

## FAQ

### Coverage numbers seem inaccurate?

Ensure you are running `test:coverage` not `test`. The `vitest.config.ts` sets `coverage.include` to `["src/**"]`, excluding test files and config files.

### How do I see which specific lines are uncovered?

```bash
pnpm --filter @open-vera/core run test:coverage
npx lcov-html coverage/lcov.info -o coverage/html
open coverage/html/index.html
```

Or install the Coverage Gutters VS Code plugin, which auto-reads `lcov.info` and highlights uncovered lines in the editor.

### Need to write tests but unsure where to start?

1. Look at the coverage report and find the lowest-coverage module
2. Read that module's source and existing tests to understand the test style
3. Focus on edge cases: error paths, empty input, extreme values, concurrency, etc.
4. Pure type definition files (like `types.ts`) do not need tests

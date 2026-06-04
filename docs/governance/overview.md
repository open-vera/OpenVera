# Evaluation & Governance Overview

> Vera's quality assurance system covers five major subsystems: Benchmark Evaluation, Test Coverage, Static Code Analysis, Storage-specific Testing, and Agent Work Review. This document serves as the main entry point, introducing the positioning and relationships of each subsystem and linking to detailed documentation.

---

## System Landscape

Vera's evaluation and governance system is built around three goals: "code quality is quantifiable, agent behavior is reproducible, improvement directions are traceable":

```
+---------------------------------------------------------------------+
|                   Evaluation & Governance System                      |
+-----------------+-----------------+----------------+-----------------+
|  Benchmark      |  Test Coverage  |  Static        |  Agent Work     |
|  Evaluation     |                 |  Analysis      |  Review         |
|                 |                 |                |                 |
|  Capability     |  Code-level     |  Structural    |  AI collab      |
|  boundary       |  quality        |  health        |  traceability   |
|  measurement    |  change gate    |  complexity    |  change audit   |
|  regression     |                 |  control       |                 |
|  comparison     |                 |                |                 |
+-----------------+-----------------+----------------+-----------------+
|                    Storage & UI Specific Testing                      |
|            SQLite / Persistence / API / Black-box Regression          |
+---------------------------------------------------------------------+
```

Subsystem positioning:

| Subsystem | Focus | Trigger | Detailed Doc |
|---|---|---|---|
| Benchmark Evaluation | Agent capability boundaries, task completion rate, model comparison | Model switch, prompt change | [benchmark.md](./benchmark.md) |
| Test Coverage | Code line/branch/function coverage, untested paths | Before every commit (gate) | [coverage.md](./coverage.md) |
| Static Code Analysis | File length, cyclomatic complexity, cognitive complexity, duplicate code | On demand / periodically | [static.md](./static.md) |
| Storage-specific Testing | SQLite, persistence, export, UI/API smoke | Storage-related changes | See section 4 |
| Agent Work Review | Claude Code / Cursor work records, change audit | On-demand query | See section 5 |

---

## 1. Benchmark Evaluation

Benchmarking is not about "chasing scores" -- it answers three questions: which task categories can this agent reliably complete? Which ones fail and why? After a model/prompt change, did capabilities improve or regress?

Evaluation has three tiers: L1 atomic tasks (single-step tool calls), L2 multi-step tasks (multi-tool chaining), L3 planning tasks (autonomous step planning). Evaluation dimensions cover task completion rate, tool call accuracy, step efficiency, token efficiency, and stability.

Four evaluation methods are supported: `exact` exact match, `contains` keyword match, `tool_match` tool call validation (all implemented), and `llm_judge` semantic scoring (to be implemented). External benchmark suites such as GAIA, SWE-bench Verified, and AgentBench serve as references.

**Detailed doc**: [benchmark.md](./benchmark.md)

---

## 2. Test Coverage

### Goals and Gates

| Goal | Threshold | Enforced |
|---|---|---|
| Global lines coverage | >= 90% | Pre-commit check |
| Core module coverage | >= 80% | CI gate |
| New business logic | Must have corresponding unit tests | Yes |

Core modules: `tools/` `storage/` `adapters/` `config/` `memory/` `context/` `utils/`. Pure type definitions and config files can be skipped.

### Tech Stack

- **Framework**: Vitest + v8 coverage, output text + lcov
- **Scale**: Core ~75 files ~1054 cases, Harness ~15 files ~268 cases
- **Status**: Core module coverage all meets thresholds (98%+); global aggregate pulled down by `worktree/` (~86%) and `tools/index.ts` (~72%)

**Detailed doc**: [coverage.md](./coverage.md)

---

## 3. Static Code Analysis

Three tools run in parallel, total time approximately 4 seconds:

```
quality-scan
├── oxlint (structural metrics)              ~0.1s ─┐
├── ESLint + sonarjs (cognitive complexity)   ~3s  ─┤─→ merge reports
└── jscpd (duplication)                       ~4s ─┘
```

### Threshold Summary

| Metric | Tool | warn | error |
|---|---|---|---|
| Total file lines | oxlint | 300 | 600 |
| Function body lines | oxlint | 50 | 100 |
| Cyclomatic complexity | oxlint | 10 | 20 |
| Nesting depth | oxlint | 4 | 6 |
| Parameter count | oxlint | 4 | 7 |
| Cognitive complexity | sonarjs | 15 | — |
| Duplicate tokens | jscpd | 50 | — |

### Tool Responsibilities

- **oxlint** (Rust): multi-threaded parallel, 50-100x faster, isolated from main ESLint config
- **sonarjs** (eslint-plugin-sonarjs): pure AST parsing, no type checking, 10-20x faster. Cognitive complexity is closer to readability difficulty than cyclomatic complexity
- **jscpd** (JS Copy-Paste Detector): token-level matching, variable renaming does not affect detection

Relationship with daily `pnpm lint`: daily lint focuses on correctness and style (ESLint + type checking, blocks build); quality-scan focuses on structural health and duplication (report only, non-blocking).

**Detailed doc**: [static.md](./static.md)

---

## 4. Storage & UI Specific Testing

A complete test matrix covering Vera's persistence layer, organized into three priority tiers:

| Tier | Content | Examples |
|---|---|---|
| P0 (Immediate) | DataExporter unit tests, SQLite migration edge cases, Memory search | Corrupt JSONL line handling, FTS Chinese search |
| P1 (Extended) | User Data TTL, storage composite queries, API route smoke | Namespace isolation, pagination sorting |
| P2 (Hardening) | Performance tests, WAL mode, transaction rollback | 10K+ session list, crash recovery |

Test targets cover: SQLite storage (CRUD/query/TTL/tags/FTS/transactions), Session migration (JSONL round-trip/dedup/validation), Memory persistence (restart recovery/entry eviction/Chinese search), Data export (JSONL/CSV/JSON/CSV escaping), User Data (namespace isolation/overwrite semantics), UI/API smoke (Harness UI + Admin UI routes/empty states/CORS).

Each subsystem has end-to-end black-box validation flows, verifying behavior through public APIs rather than implementation details.

---

## 5. Agent Work Review

Vera's development process heavily uses AI assistance (Claude Code + Cursor), and a traceability system for AI work records has been established accordingly.

### Data Sources

| Source | Storage Location |
|---|---|
| Claude Code | `~/.claude/projects/<slug>/*.jsonl` |
| Cursor | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Git | `git log --since --until` |

### Review Skills

| Skill | Function | Example |
|---|---|---|
| `claude-session-review` | Claude Code work records | `/claude-session-review --days 1` |
| `cursor-session-review` | Cursor work records | `/cursor-session-review --days 1` |
| `agent-changes-report` | Combined report (both + git log) | `/agent-changes-report` |

Reports are output to `docs/agent-changes/`, containing session summaries, prompt lists, modified files, and key operation descriptions.

---

## 6. Governance Process

### Daily Development Flow

```
Write code → pnpm test → coverage >= 90% → scan.sh no error → git commit (standard format)
                ↓                                    ↓
           Any failure                         error-level finding
                ↓                                    ↓
           Fix and re-run ← ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
```

### Quality Gates at a Glance

| Gate | Tool | Blocking Condition |
|---|---|---|
| Type checking | `pnpm typecheck` | Compilation error |
| Unit tests | `pnpm test` | Any failure |
| Coverage | `pnpm run test:coverage` | lines < 90% |
| Static analysis | `bash .claude/skills/quality-scan/scan.sh` | error-level finding |
| Commit standard | Git hook | Non-compliant format |
| Sensitive files | `git status` check | API Key in staged |

### Commit Standard

```
feat(scope): description | fix(scope): description | refactor(scope): desc
test(scope): description | docs(scope): description | chore(scope): description
```

scope: `core` `harness` `tool` `agent` `memory` `rag` `sandbox` `channel`

### CI Integration (Planned)

- [ ] Auto-run coverage + quality scan on PR, post results as PR comment
- [ ] Trend tracking: compare multiple scan results, observe quality change curve

---

## Related Documents

| Document | Path |
|---|---|
| Benchmark Evaluation System | [benchmark.md](./benchmark.md) |
| Test Coverage Report | [coverage.md](./coverage.md) |
| Static Code Analysis | [static.md](./static.md) |
| Project Architecture | [../architecture.md](../architecture.md) |
| Project Roadmap | [../roadmap.md](../roadmap.md) |
| Changelog | [../changelog.md](../changelog.md) |

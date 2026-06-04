# OpenVera — Documentation Directory

> OpenVera is a Harness-native agent runtime — self-planning, self-looping, self-critiquing, self-evolving.

---

## Quick Start

1. Copy the configuration template and add your API keys:

```bash
cp .vera/settings.example.json .vera/settings.json
# Edit .vera/settings.json, fill in provider api_key values
```

2. Start the REPL:

```bash
pnpm repl
```

Configuration notes:
- `providers`: LLM provider configuration (anthropic / openai / gemini / deepseek / groq / azure)
- `default_provider`: default provider to use
- `routing`: intent routing configuration, auto-selects models by L0-L3 complexity
- `.vera/settings.json` contains secrets, is `.gitignore`d, and is never committed

---

## Project Overview

| Document | Description |
|---|---|
| [PROJECT_INTRO.md](./PROJECT_INTRO.md) | Project introduction (English) — philosophy, vision, architecture, value proposition |
| [PROJECT_INTRO_CN.md](./PROJECT_INTRO_CN.md) | Project introduction (Chinese) — philosophy, vision, architecture, value proposition |

---

## High-Level Planning

| Document | Description |
|---|---|
| [roadmap.md](./roadmap.md) | Phase roadmap — P0 core runtime -> P1 self-loop -> P2 self-evolution -> P3 platform expansion |
| [roadmap.md#known-defects-and-tech-debt](./roadmap.md#known-defects-and-tech-debt) | 2026-04-28 architecture audit — 5 Critical, 6 High, 6 Medium issues |

---

## Module Documentation

### Core — `@vera/core`

Foundation runtime layer: LLM adapters, agent loop, intent routing, context management.

| Document | Description |
|---|---|
| [agent-design.md](./core/agent-design.md) | Agent capability landscape, Hermes highlights, Dreaming, Subagent, Plan Mode overview |
| [subagent-design.md](./core/subagent-design.md) | Subagent system design — when to use, communication protocol, context sharing, scheduling modes |
| [intent-routing.md](./core/intent-routing.md) | Intent classification and model routing — L0/L1/L2/L3 tiering |
| [runtime-design.md](./core/runtime-design.md) | Core runtime design — adapter abstraction, loop, streaming |
| [tool-rendering.md](./core/tool-rendering.md) | Tool output rendering — RenderHint, ToolResultView, renderer components |
| [capability-gaps.md](./core/capability-gaps.md) | Current capability gaps and near-term implementation roadmap — permissions, context, UI, reliability |
| [p0-alignment-checklist.md](./core/p0-alignment-checklist.md) | P0 post-alignment code verification checklist — done / partial / outstanding |
| [plan-mode-implementation.md](./core/plan-mode-implementation.md) | **[P0 Complete]** Plan Mode — planner, parser, state machine, REPL integration |
| [infinite-context-implementation.md](./core/infinite-context-implementation.md) | **[P0 Complete]** Infinite context — progressive compression, micro-compact, reactive compact |

-> [core/README.md](./core/README.md)

---

### Harness — `@vera/harness`

Execution kernel: Flow lifecycle, tool permission constraints, Critique loop, approval gates.

| Document | Description |
|---|---|
| [design.md](./harness/design.md) | Harness overall design — terminology, Flow State machine, permission boundaries, Proposal Pipeline |
| [runtime-implementation.md](./harness/runtime-implementation.md) | Harness Runtime implementation details — module responsibilities and current code structure |
| [plan-mode-implementation.md](./core/plan-mode-implementation.md) | Plan Mode implementation — planner, parser, state machine, HarnessRuntime |
| [tool-rendering.md](./core/tool-rendering.md) | Tool output rendering — RenderHint, ToolResultView, renderer components |

-> [harness/README.md](./harness/README.md)

---

### TUI / Web UI Integration

Terminal UI improvements, OpenTUI alternatives, and unified event protocol roadmap for future Web UI/clients.

| Document | Description |
|---|---|
| [tui/README.md](./tui/README.md) | TUI evaluation and recommended path — Hermes/OpenCode/Codex comparison, decision matrix |
| [tui/ink-evolution.md](./tui/ink-evolution.md) | Incremental Ink-based improvements — event protocol, state separation, composer, performance |
| [tui/opentui-rewrite.md](./tui/opentui-rewrite.md) | Full OpenTUI migration plan — capabilities, cost, risk, PoC, and migration phases |

---

### Eval — `@vera/benchmark` + Evaluation System

Quantifies Vera's task completion rate, tool accuracy, and stability.

| Document | Description |
|---|---|
| [benchmark.md](./eval/benchmark.md) | Benchmark design — evaluation dimensions, GAIA/SWE-bench/ToolBench open-source suites, run cadence |

-> [eval/README.md](./eval/README.md)

---

### Platform — Platform Extension Capabilities

Computer Use, MCP integration, intelligent UI testing, and other P2/P3 capabilities.

| Document | Description |
|---|---|
| [computer-use.md](./platform/computer-use.md) | Computer Use — browser automation, desktop control, benchmark integration |
| [intelligent-testing.md](./platform/intelligent-testing.md) | Intelligent automated testing — AI-driven UI testing, multi-strategy element location, self-healing tests |

-> [platform/README.md](./platform/README.md)

### Testing — Test Coverage and Acceptance

| Document | Description |
|---|---|
| [storage/README.md](./testing/storage/README.md) | Storage/UI test coverage plan — SQLite, Session migration, DataExporter, black-box acceptance |

---

### Apps — Application Layer

| App | Description |
|---|---|
| harness-ui | Harness Web UI — visual Flow runs, streaming logs, Artifact browsing |
| audio-label | Audio annotation tool |

-> [apps/README.md](./apps/README.md)

---

### Code Governance

| Document | Description |
|---|---|
| [static-analysis.md](./code-governance/static-analysis.md) | Static code quality scanning — oxlint + jscpd parallel approach, metric thresholds, Skill design |

---

## Reference Materials

Curated external articles, organized by source:

| Directory | Content |
|---|---|
| [refrence/anthropic/](./refrence/anthropic/) | Anthropic official articles (with Chinese translations) — agent design, tool use, Harness, evals, etc. |
| [refrence/harness/](./refrence/harness/) | Harness-specific references — overall approach, extension practices, multi-agent patterns, anti-patterns |
| [refrence/OpenAI/](./refrence/OpenAI/) | Codex engineering practices |

---

## Recommended Reading Order

```
roadmap.md                          Understand global goals and phases (including P0 status and known tech debt)
  v
harness/design.md                   Understand Harness kernel design (most important)
  v
core/agent-design.md                Understand agent capability landscape
  v
core/intent-routing.md              Intent routing (complete, can skim)
  v
core/plan-mode-implementation.md        P0 Complete — Plan Mode foundation
  v
core/infinite-context-implementation.md   P0 Complete — Infinite context
  v
core/capability-gaps.md             Review P0 post-alignment items (permissions/context/UI/subagent)
  v
eval/benchmark.md                   Understand evaluation system (P2 preparation)
```

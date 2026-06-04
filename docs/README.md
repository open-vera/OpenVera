# OpenVera Documentation

> A Harness-native agent runtime — self-planning, self-looping, self-critiquing, self-evolving.

OpenVera is a TypeScript agent runtime built around the **Harness kernel**. Instead of giving an LLM direct access to tools, Vera routes every action through a structured execution framework: intent routing picks the right model, a flow state machine drives execution, and an independent Challenger critiques every step. The result is a runtime that plans its own work, catches its own mistakes, and improves itself over time — not through prompt engineering, but through engineered system capabilities.

Docs are bilingual. English pages live at `/`; Chinese translations live at `/zh/`.

---

## Getting Started

New to OpenVera? Start here.

| Document | Description |
|---|---|
| [Installation](./guide/install.md) | Install the CLI, run the setup wizard, configure providers and models |
| [CLI Reference](./guide/routing.md) | Intent routing — L0/L1/L2 classification, automatic model selection by task complexity |
| [Architecture](./architecture.md) | Core vs Harness responsibility boundaries, dependency direction, module layout |
| [Roadmap](./roadmap.md) | Phased plan: P0 runtime, P1 self-loop, P2 self-evolution, P3 platform expansion |

**Quick install:**

```bash
npm i @open-vera/openvera@latest -g
ai
```

`ai`, `vera`, and `openvera` are all aliases. First run launches an interactive setup wizard.

---

## Architecture and Design

OpenVera is a monorepo structured in four layers. Dependency direction is strict: `harness -> core`, and Core never imports from Harness.

### Core (`packages/core`)

Stateless, single-call agent loop. Adapters, tools, context, session — everything one LLM invocation needs.

| Document | Description |
|---|---|
| [Agent](./core/agent.md) | Agent capability landscape, system prompt composition, model adapters |
| [Runtime](./core/runtime.md) | Core runtime design — adapter abstraction, agent loop, streaming |
| [Plan Mode](./core/plan-mode.md) | Structured ExecutionPlan, 11-state flow machine, nested planning, checkpoint/resume |
| [Context](./core/context.md) | Context window management, token budgeting, message ordering |
| [Compression](./core/compression.md) | Progressive compression, micro-compact, reactive compact, recall |
| [Subagent](./core/subagent.md) | Orchestrator/worker model, dependency DAG, isolation modes, scheduling |
| [Tools](./core/tools.md) | Built-in tool registry, tool lifecycle, parameter validation |
| [Tool Runtime](./core/tool-runtime.md) | Middleware pipeline, before/after/onError hooks, error isolation |
| [Tool Rendering](./core/tool-render.md) | Output rendering, RenderHint, renderer components |
| [Skills](./core/skill.md) | Markdown-defined custom skills, intent-driven activation, hot-reload |
| [Skill Evolution](./core/skill-evo.md) | Self-improving skill definitions, proposal and rollout pipeline |
| [Session](./core/session.md) | Session persistence, AI-generated titles, cost tracking, branching |
| [Loaders](./core/loaders.md) | Project context loading, CLAUDE.md, path-scoped rules |
| [Op Recorder](./core/op-recorder.md) | Operation recording and replay for debugging and evaluation |
| [Worktree](./core/worktree.md) | Git worktree integration for isolated task execution |

### Harness (`packages/harness`)

Stateful orchestration. Flow state machine, Critique loop, Proposal Pipeline, skill evolution — multi-step task execution.

| Document | Description |
|---|---|
| [Overview](./harness/overview.md) | Harness role in the Vera stack — execution kernel, not safety wrapper |
| [Design](./harness/design.md) | Flow state machine, permission boundaries, Challenger independence, Proposal Pipeline |
| [Runtime](./harness/runtime.md) | HarnessRuntime implementation, module responsibilities, code structure |
| [Evolution](./harness/evolution.md) | Self-evolution loop — benchmark-gated proposals, evidence-driven improvement |
| [Technical Reference](./harness/tech.md) | Implementation details, data structures, internal protocols |

### Platform (`packages/platform`)

Extension capabilities. Channel adapters, sandbox execution, MCP, RAG, multi-agent networks.

| Document | Description |
|---|---|
| [Overview](./platform/overview.md) | Platform layer architecture and extension points |
| [Plugin System](./platform/plugin.md) | Plugin API, lifecycle hooks, registry |
| [Computer Use](./platform/computer-use.md) | Browser and desktop automation, benchmark integration |
| [Multi-Agent](./platform/multi-agent.md) | Multi-agent networks, communication protocols, coordination patterns |
| [MCP Integration](./platform/mcp.md) | Model Context Protocol, tool servers, resource providers |
| [RAG](./platform/rag.md) | Retrieval-augmented generation, vector stores, embedding pipelines |
| [Sandbox](./platform/sandbox.md) | Code execution isolation, path boundary enforcement, security plugins |
| [Channel](./platform/channel.md) | ChannelAdapter interface, CLI/HTTP/Discord/Feishu backends |
| [Storage](./platform/storage.md) | Persistence layer — SQLite, JSONL, session store, vector store |

### Gateway (`apps/gateway-ui`)

Management console and API server.

| Document | Description |
|---|---|
| [Control Panel](./gateway/control.md) | Run workspace, capability manager, project registry, system doctor |
| [Harness UI](./gateway/harness-ui.md) | Visual Flow runs, streaming logs, artifact browsing |

---

## Governance and Quality

| Document | Description |
|---|---|
| [Overview](./governance/overview.md) | Code governance philosophy, review process, quality gates |
| [Benchmark](./governance/benchmark.md) | Evaluation framework — GAIA, SWE-bench, ToolBench, scoring methodology |
| [Coverage](./governance/coverage.md) | Test coverage targets, measurement tooling, gap analysis |
| [Static Analysis](./governance/static.md) | oxlint, eslint-plugin-sonarjs, jscpd — rules, thresholds, CI integration |

---

## Reference

| Document | Description |
|---|---|
| [Roadmap](./roadmap.md) | Phased roadmap with deliverable tracking, known defects, and tech debt |
| [Changelog](./changelog.md) | Chronological change index linked to detailed per-session entries |
| [Releases](./releases/v0.3.1.md) | Release notes and migration guides for each published version |
| [GitHub](https://github.com/open-vera/OpenVera) | Source code, issues, discussions |

---

## Reading Order

If you are new to the codebase, follow this path:

1. **[Roadmap](./roadmap.md)** — understand the vision, phases, and current status
2. **[Architecture](./architecture.md)** — learn the Core/Harness boundary and dependency rules
3. **[Harness Design](./harness/design.md)** — study the execution kernel (most important)
4. **[Core Agent](./core/agent.md)** — understand the agent capability landscape
5. **[Core Runtime](./core/runtime.md)** — see how a single call flows through the system
6. **[Plan Mode](./core/plan-mode.md)** — structured planning and flow state machine
7. **[Compression](./core/compression.md)** — infinite context via progressive compaction
8. **[Governance Overview](./governance/overview.md)** — quality gates and contribution expectations

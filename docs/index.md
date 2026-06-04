---
layout: home

hero:
  name: "OpenVera"
  text: "Harness-native Agent Runtime"
  tagline: Self-planning · self-looping · self-critiquing · self-evolving
  actions:
    - theme: brand
      text: Install →
      link: "#install"
    - theme: alt
      text: Documentation
      link: /README
    - theme: alt
      text: GitHub
      link: https://github.com/open-vera/OpenVera
---

## Vision

> **Accelerate human creativity, achieve SOTA AGI.**

We are at an inflection point: models are capable enough, but the execution framework is the bottleneck. Vera's mission is to build the **reliable, verifiable, compounding** agent runtime that turns human ideas into working reality — at a pace and quality no manual process can match.

### Core Beliefs

- **Harness is the kernel, not a safety wrapper.** Every tool call, every state transition, every self-improvement passes through a principled execution framework.
- **Don't design a system that produces more output. Design a system that is harder to let unqualified output through.**
- **Critique must be structurally independent.** The same agent cannot be implementer, evaluator, and judge of its own work.
- **Failure must produce attribution, not just retry.** Without root cause analysis, recovery is just higher-cost repetition.
- **Improvement must be evidence-driven.** Every change earns its way in through benchmarks, not intuition.

## Install {#install}

```bash
npm i @open-vera/openvera@latest -g
ai
```

`ai`, `vera`, and `openvera` are all aliases. First run launches an interactive setup wizard.

```bash
ai init          # re-run setup wizard
ai init --force  # force re-run even if config exists
```

## Quick Config

```jsonc
// .vera/settings.json
{
  "providers": {
    "compony": { "adapter": "anthropic", "api_key": "..." }
  },
  "default_model": "deepseek-v4-flash"
}
```

Enable model routing to auto-switch by task complexity:

```jsonc
"routing": { "enabled": true, "classifier": "...", "l0": "...", "l1": "...", "l2": "..." }
```

| Field | Purpose |
|---|---|
| `providers` | Connection config per provider (adapter, api_key, base_url) |
| `default_model` | Model when routing is disabled |
| `routing` | L0/L1/L2 auto model selection by task complexity |
| `session` | AI title generation, long-session compaction |

[→ Full configuration guide](/README)

## Features

### Agent Runtime

| Capability | Description |
|---|---|
| **Intent Routing** | L0/L1/L2 classification (~100ms), automatic model selection by task complexity |
| **Plan Mode** | Structured ExecutionPlan, 11-state flow machine, nested planning, checkpoint/resume |
| **Critique Loop** | Independent Challenger scores every step, confidence < 0.7 triggers automatic replan |
| **Infinite Context** | Progressive compression + micro-compact + reactive compact + recall; first message always preserved |
| **Subagent System** | Orchestrator/worker architecture, dependency DAG, 3 isolation modes (none / try / remote) |
| **Tool Middleware** | Multi-layer before/after/onError pipeline, error isolation per layer |

### Data & Persistence

| Capability | Description |
|---|---|
| **Session Store** | JSONL persistence, AI-generated titles, cost tracking, branching (/try, /merge) |
| **Memory System** | Thread-safe writes, crash-safe, tier separation (semantic / episodic / working) |
| **Permission Rules** | Persistent allow/deny per tool/path, bash risk confirmation gates |
| **Project Context** | `.vera/rules.md`, `CLAUDE.md`, path-scoped rule activation |

### Tools & Platform

| Capability | Description |
|---|---|
| **7 Built-in Tools** | `read_file` `write_file` `edit_file` `list_dir` `glob` `grep` `bash` |
| **Custom Skills** | Markdown-defined skills, intent-driven activation, hot-reload |
| **Gateway UI** | Management console: Run workspace, Capability manager, Doctor, Project registry |
| **Multi-Channel** | CLI REPL, HTTP API, Discord bot, Feishu bot — via unified ChannelAdapter interface |
| **Sandbox** | Code execution isolation, path boundary enforcement, security-plugin architecture |

## Architecture

```
Human Idea
  → Intent classification & model routing (L0 / L1 / L2)
  → Structured Flow → ExecutionPlan
  → Step-by-step execution via tool runtime
  → Independent Critique (Challenger)
  → Failure attribution & Replan
  → Lesson persistence → Memory
  → Benchmark-gated Proposal → Rollout
  → Next cycle, within boundaries
```

**Separation of concerns:**

```
packages/
├── core/        Stateless agent loop — adapters, tools, session, context
├── harness/     Stateful orchestration — flow state machine, critique, skill
├── gateway/     Capability registry, project registry, doctor
├── logger/      Structured logging with redaction
└── shared/      Shared types and utilities

apps/
├── gateway-ui/web/    Vue 3 management console
└── gateway-ui/server/ API server
```

> **The critical constraint:** A Role Agent never decides whether its own work is complete. That right belongs exclusively to the Challenger. See [Harness Design →](/harness/design)

## Roadmap

| Phase | Goal | Key Deliverables | Status |
|---|---|---|---|
| **P0** | Harness-driven execution runtime | Intent routing, 7 tools, infinite context, Plan Mode, Critique, Session, Subagent | ✅ Complete |
| **P1** | Self-loop & self-correction | Checkpoint/Resume, Memory persistence, Subagent orchestrator/pool, Tool middleware | ✅ Complete |
| **P2** | Self-evolution | Dreaming → Proposal → Human review → Benchmark-gated Rollout → Regression loop | 📋 Planned |
| **P3** | Universal agent platform | Computer Use, MCP, multi-agent networks, adaptive strategies | 📋 Planned |

[→ Full roadmap](/roadmap)

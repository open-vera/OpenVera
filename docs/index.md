---
layout: home

hero:
  name: "OpenVera"
  text: "Harness-native Agent Runtime"
  tagline: Self-planning, self-looping, self-critiquing, self-evolving
  actions:
    - theme: brand
      text: Get Started
      link: "#install"
    - theme: alt
      text: View on GitHub
      link: https://github.com/open-vera/OpenVera
    - theme: alt
      text: Roadmap
      link: /roadmap
---

## Why Vera? {#why}

Most agent systems are smarter assistants: they follow instructions and call tools. Vera is different — its kernel isn't a safety wrapper, it's the **engine that drives everything**. Every tool call, every flow transition, every self-improvement passes through a principled execution framework that keeps agents both powerful and controllable.

::: tip Vision
**Accelerate human creativity, achieve SOTA AGI.** — Don't design a system that produces more output. Design a system that is harder to let unqualified output through.
:::

## Install {#install}

```bash
npm i @open-vera/openvera@latest -g
```

Launch the REPL:

```bash
ai
```

::: tip Tip
`ai`, `vera`, and `openvera` are all aliases for the same command.
:::

On first run, an interactive setup wizard guides you through selecting an LLM provider and entering your API key.

```bash
ai init          # run setup wizard
ai init --force  # re-run even if config exists
```

### From Source

```bash
git clone https://github.com/open-vera/OpenVera.git
cd OpenVera
pnpm install && pnpm build
cp .vera/settings.example.json .vera/settings.json
# Edit .vera/settings.json with your API key
pnpm repl
```

## Configuration {#config}

Configuration lookup order: project config (`./.vera/settings.json`) → global config (`~/.vera/settings.json`).

**Simplest setup — one provider, one model:**

```jsonc
{
  "providers": {
    "compony": {
      "adapter": "anthropic",
      "api_key": "...",
      "base_url": "https://gateway-claude-api.example.com"
    }
  },
  "default_model": "deepseek-v4-flash"
}
```

**With routing — auto-switch model by task complexity:**

```jsonc
{
  "providers": {
    "compony": {
      "adapter": "anthropic",
      "api_key": "...",
      "base_url": "https://gateway-claude-api.example.com"
    }
  },
  "models": ["deepseek-v4-flash", "deepseek-v4-pro"],
  "routing": {
    "enabled": true,
    "classifier": "deepseek-v4-flash",
    "l0": "deepseek-v4-flash",
    "l1": "deepseek-v4-flash",
    "l2": "deepseek-v4-pro"
  }
}
```

| Field | Description |
|---|---|
| `providers` | Connection config: `adapter`, `api_key`, optional `base_url` |
| `default_provider` | Default provider; only needed with multiple providers |
| `default_model` | Model used when routing is disabled |
| `routing` | Optional L0/L1/L2 model routing by task complexity |
| `models` | Optional model aliases for cross-provider reuse |
| `session` | Optional: AI title generation, compaction settings |

Supported adapters: `anthropic`, `openai` (OpenAI-compatible including DeepSeek/Groq/Azure), `gemini`.

## Web UI (Gateway)

Vera ships with a built-in management console — start the server and launch the UI:

```bash
pnpm serve   # starts the API server at :7720
pnpm ui      # starts the dev UI at :7704, proxied to the server
```

The Gateway UI provides:

| Capability | Description |
|---|---|
| **Overview Dashboard** | Active runs, session stats, cost tracking |
| **Run Workspace** | Per-run shell with Overview / Memory / Checkpoints / Subagents / Timeline tabs |
| **Capability Manager** | Skills directory, MCP servers, RAG pipelines — hot-reload |
| **Project Registry** | Multi-project management, context configuration |
| **Doctor** | System health checks, configuration diagnostics |
| **Chat Console** | Direct agent interaction with conversation history |
| **Settings** | Provider/model config, routing, session preferences |

See [docs/README](/README) for full configuration guide.

## Features

::: tip Core Capabilities (P0 ✅)
- **Intent Routing** — L0/L1/L2 automatic model selection, ~100ms classification
- **7 Built-in Tools** — read_file, write_file, edit_file, list_dir, glob, grep, bash
- **Infinite Context** — Progressive compression, micro-compact, reactive compact, recall
- **Plan Mode** — Structured ExecutionPlan, flow state machine, 11 states
- **Critique Loop** — Independent Challenger scores every step, confidence < 0.7 triggers replan
- **Session Persistence** — JSONL store, cost tracking, resume, branching, AI titles
- **Subagent System** — Orchestrator/worker, dependency DAG, parallel execution, 3 isolation modes
- **Permission System** — Persistent allow/deny rules, bash risk gates, path enforcement
- **Project Context** — `.vera/rules.md`, `CLAUDE.md`, path-scoped rule activation
- **CLI Theme** — Semantic color tokens, dark theme
- **Custom Agent Definitions** — `~/.vera/agents/*.md`, `.vera/agents/*.md`
:::

::: info Self-Loop & Self-Correction (P1 ✅)
- **Checkpoint & Resume** — JSONL checkpoint store, auto-compact, dedup
- **Memory Persistence** — Thread-safe writes, crash-safety, tier separation (semantic/episodic/working)
- **Subagent Orchestrator** — Dependency DAG, parallel execution, abort/timeout
- **Subagent Pool** — Concurrency limits, submit/complete/fail/cancel tracking
- **Tool Middleware** — Multi-layer before/after/onError pipeline
- **Agent Runner Registry** — Multi-level fallback chains, capability-based routing
:::

::: warning Self-Evolution (P2 — Planned)
Dreaming → distill episodic memory into insights → Proposal generation → Human review → Benchmark-gated Rollout → Regression feedback loop
:::

::: tip Platform (P3 — Planned)
Computer Use, MCP protocol, multi-agent networks, adaptive strategies, universal agent platform
:::

## Architecture

```
Human Idea
  → Intent classification & model routing (L0/L1/L2)
  → Structured Flow (ExecutionPlan)
  → Step-by-step execution via tool runtime
  → Independent Critique (Challenger)
  → Failure attribution & Replan
  → Lesson persistence → Memory
  → Benchmark-gated Proposal → Rollout
  → Next cycle, within boundaries
```

**Separation of concerns:**

| Role | Responsibility | Constraint |
|---|---|---|
| **Planner** | Reads context, generates ExecutionPlan | Flow definition is advice, not command |
| **Role Agent** | Executes steps to exit criteria, produces deliverables | Never decides if its own work is complete |
| **Challenger** | Independently scores every output, accumulates lessons | Must give scores and requiredFixes; has veto power |
| **Orchestrator** | Schedules agents, manages context resets, enforces gates | Decides continue/rework/delegate/escalate |

## What Makes Vera Different

| Typical Agent | Vera |
|---|---|
| Model calls tools directly | All tool calls dispatched through Harness |
| Model decides whether to continue | Harness owns Flow State transitions |
| Model self-assesses completion | Challenger independently scores every step |
| Safety = prompt constraints | Safety = architectural boundaries |
| Failure = retry | Failure = attribution + proposal + validated fix |

**Subagent isolation modes:**

| Mode | Mechanism | Use Case |
|---|---|---|
| `none` | Shared context (default) | Standard delegation |
| `try` | Isolated git worktree, reviewable via `/merge` | Experimental changes |
| `remote` | Pluggable external executor | Distributed/sandboxed execution |

**Three-layer context system:**

| Layer | Mechanism | Trigger |
|---|---|---|
| Sliding window | Drop earliest turns, keep task anchor | 80% token threshold |
| Progressive compression | LLM summarization of old turns | Token threshold exceeded |
| Micro-compaction | Heuristic cleanup of stale tool results (no LLM) | Time-gap based |
| Reactive compaction | Aggressive compression on `prompt-too-long` error | API error response |

> **The first message (original task definition) is always preserved.** The agent never loses its goal.

## Technology Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (strict, ESM) |
| Package manager | pnpm workspace monorepo |
| LLM adapters | Anthropic, OpenAI, Gemini, DeepSeek, Groq, Azure |
| Terminal UI | React + Ink |
| Web UI | Vue 3 + Vite |
| Test runner | Vitest |
| Static analysis | oxlint + eslint-plugin-sonarjs + jscpd |

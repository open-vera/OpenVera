# Vera — Project Introduction

> **Vision: Achieve SOTA AGI and accelerate the realization of human creativity.**

---

## What is Vera?

Vera is a **Harness-native agent runtime** built for a single purpose: to close the gap between human creative intent and reliable, autonomous execution.

Most AI agent systems are smarter assistants. They respond to prompts, call tools, and produce outputs. Vera is architecturally different — it is a **self-planning, self-looping, self-critiquing, and self-evolving runtime** where the Harness is not a safety wrapper bolted on top, but the execution **kernel** itself.

```
User Idea
  → Intent classification & model routing
  → Structured Flow (ExecutionPlan)
  → Step-by-step execution via tool runtime
  → Independent Critique (Challenger)
  → Failure attribution & Replan
  → Lesson persistence → Memory
  → Benchmark-gated Proposal → Rollout
  → Next cycle, within boundaries
```

This is not a workflow. It is a **closed, self-driving loop** — and every transition is governed.

---

## The Problem We Solve

### Why current agent systems fail in production

The gap between impressive demos and reliable production systems is not a model capability problem. It is an **architectural problem**.

Today's agent systems share five structural failure patterns:

#### ❶ No structured execution framework
Tasks are a single prompt with tool calls chained ad-hoc. Complex tasks drift — the agent gradually forgets its original goal, over-indexes on local details, or stalls with no path forward.

#### ❷ Self-assessment is fundamentally unreliable
Agents are optimistic about their own outputs by design. They are far better at explaining why something is "good enough" than at independently identifying what is wrong. Without a structurally independent evaluator, quality gates are theater.

#### ❸ Context collapses under long tasks
Long tasks exhaust context windows. Agents lose earlier reasoning, contradict prior decisions, and produce increasingly incoherent results — not because the model is weak, but because nothing is managing the context lifecycle.

#### ❹ No learning loop — every failure is discarded
When an agent fails, nothing is recorded, attributed, or fed back into the system. The same mistake recurs across runs, across users, across versions. There is no compounding improvement.

#### ❺ No governed evolution mechanism
Improving an agent today means editing prompts and hoping. There is no benchmark to measure the change. No rollout mechanism to limit blast radius. No regression test to detect regressions. Improvement is guesswork.

### The root cause

> Without a principled runtime kernel, agent capabilities are prompt tricks stacked on each other.

Self-planning without a Harness is uncontrolled. Self-critique without structural independence is noise. Self-evolution without a benchmark loop is wishful thinking.

**A different architecture is required.**

---

## Our Vision

> **Our vision is to achieve SOTA AGI and accelerate human creativity from idea to reality.**

We believe the path to SOTA AGI is not only through larger models — it runs through **principled execution frameworks** that make agent systems reliable, verifiable, and self-improving at scale.

The most capable future systems will not just produce better outputs. They will:

- **Plan their own work** — decompose any goal into verifiable, staged execution units
- **Verify their own results** — through structurally independent critique, not self-assessment
- **Learn from their own failures** — persist lessons, attribute root causes, generate proposals
- **Evolve in a governed way** — every improvement is benchmark-validated before rollout

When those four capabilities compound together, the gap between human creative intent and working reality collapses. Ideas that once took weeks of careful engineering become executable in hours — not because the model is smarter, but because the runtime is built to never let unqualified work through.

**Human creativity, accelerated by a runtime that refuses to cut corners.**

---

## Core Philosophy: Harness as the Kernel

Vera's foundational insight, derived from Anthropic's research on long-running agents and validated through the Harness MVP:

> **Do not design a system that produces more output. Design a system that is harder to let unqualified output through.**

This inverts the typical agent design:

| Typical Agent System | Vera |
|---|---|
| Model calls tools directly | All tool calls dispatched through Harness |
| Model decides whether to continue | Harness owns Flow State transitions |
| Model self-assesses completion | Challenger independently scores every step |
| Safety = prompt constraints | Safety = architectural boundaries with legal transition enforcement |
| Failure = retry | Failure = attribution + proposal + regression-validated fix |

### The Six Harness Principles

**1. Define done before starting**
Every Flow has explicit exit criteria, required deliverables, and failure conditions. An agent that doesn't know what "done" looks like will never reliably stop at the right point.

**2. Stage long tasks — do not rely on long context alone**
Long tasks drift. Break work into independently verifiable units. Each unit produces a structured artifact. Even if the session is interrupted, the model is swapped, or the context is reset, the task remains coherent.

**3. External critique — not self-assessment**
The Challenger role is structurally independent. It does not inherit the implementer's optimism. It evaluates against pre-defined criteria, produces scored structured output with specific required fixes, and has veto power.

**4. Validate against reality**
The weakest validation is reading text descriptions. Vera runs code, executes test suites, and (in P3) interacts with real UIs — not just inspects outputs.

**5. Every failure must be attributed**
Was it misunderstood requirements? Wrong implementation? Weak validation? Each failure must produce a root cause, not just a retry. Without attribution, recovery is just higher-cost repetition of the same mistake.

**6. Persist context as artifacts — not just conversation history**
Reliable context is structured artifacts, not chat logs. Plans, step results, critique reports, dream reports, and proposals — all persisted. The task survives agent swaps, model changes, and context resets.

---

## Unique Value Propositions

### 1. Cognitive role separation — the most important engineering principle

```
Planner      Reads .flow/ context → generates ExecutionPlan → adapts to task complexity
Role Agent   Executes steps to defined exit criteria → produces deliverables
Challenger   Independently scores every output → accumulates lessons → gets sharper each run
Orchestrator Schedules agents → manages context resets → enforces approval gates
```

**The critical constraint:** A Role Agent never decides whether its own work is complete. That right belongs exclusively to the Challenger.

This separation prevents the most common failure mode in agent systems: an agent that is simultaneously implementer, evaluator, and judge of its own work.

### 2. Infinite context without degradation

Vera manages context as a lifecycle, not a limit to work around:

| Layer | Mechanism | Trigger |
|---|---|---|
| Sliding window trim | Drop earliest turns, preserve task anchor | Token threshold at 80% |
| Progressive compression | LLM summarization of old turns, injected as system context | Token threshold exceeded |
| Micro-compaction | Heuristic cleanup of stale tool results — no LLM call | Time-gap based |
| Reactive compaction | Aggressive compression + retry on `prompt-too-long` error | API error response |

**The first message (original task definition) is always preserved.** The agent never loses its goal.

### 3. Subagent system with real isolation

The `agent` tool supports three isolation modes:

| Mode | Mechanism | Use Case |
|---|---|---|
| `none` | Shared context (default) | Standard delegation |
| `try` | Isolated git worktree — changes reviewable via `/merge` | Experimental code changes |
| `remote` | Pluggable external executor backend | Distributed or sandboxed execution |

Subagents inherit parent Harness constraints. They cannot escalate permissions. Results carry transcript IDs for full auditability.

### 4. Intent routing — right model, right cost

A lightweight classifier (haiku/mini, ~100ms) classifies every input before routing:

| Level | Description | Default Model |
|---|---|---|
| L0 | Casual chat, simple Q&A | claude-haiku / gpt-4o-mini |
| L1 | Single-step tasks | claude-haiku / gpt-4o-mini |
| L2 | Multi-step tasks | claude-sonnet / gpt-4o |
| L3 | Complex planning, deep reasoning | claude-opus / o3 |

L3 tasks automatically activate Plan Mode. Target: L0/L1 accuracy > 95%, overall cost reduction > 60%.

### 5. Challenger learns — attacks get sharper over time

After every run, the Challenger appends discovered failure patterns to `.flow/challenger/lessons/{step}.md`. On the next run, it reads those lessons and applies them as attack angles. Over time, the system becomes harder to fool — not because the model improves, but because the framework accumulates institutional knowledge about where this specific codebase or workflow tends to fail.

### 6. Self-evolution through a governed pipeline

```
Dreaming (async) → distill episodic memory + benchmark failures into insights
       ↓
Proposal generation → structured improvement proposals (prompt / tool policy / workflow)
       ↓
Human review → proposals are suggestions, not automatic commits
       ↓
Benchmark-gated Rollout → change can only ship if it improves measured pass rates
       ↓
Regression → failure-to-benchmark loop closes
```

This is **not** "agent rewrites itself." This is a principled evolution pipeline where every proposed improvement must earn its way in through evidence.

---

## Architecture Overview

### Package Structure

```
vera/                          ← pnpm workspace monorepo
├── packages/
│   ├── @vera/core             ← Stateless runtime foundation
│   ├── @vera/harness          ← Stateful orchestration kernel
│   └── @vera/benchmark        ← Evaluation infrastructure
└── apps/
    ├── harness-ui/server      ← Web UI backend (vera-serve)
    └── harness-ui/web         ← Web UI frontend (Vue 3 + Vite)
```

**Dependency direction is strictly one-way:**
```
@vera/benchmark → @vera/harness → @vera/core
```
Core never depends on Harness. This ensures the stateless agent loop can be used independently of the orchestration layer.

---

### `@vera/core` — The Agent Loop

Everything a single LLM call needs. Stateless. No orchestration logic.

| Module | Capability |
|---|---|
| `adapters/` | Unified `LLMAdapter` interface — Anthropic, OpenAI, Gemini (DeepSeek / Groq / Azure via config) |
| `agent/` | `streamAgent` / `runAgent` — multi-turn loop, tool dispatch, retry, compression |
| `agent/subagent.ts` | `agent` tool — orchestrator/worker delegation, isolation modes, background jobs |
| `context/` | Token estimation, window trimming, progressive/micro/reactive compression, segment recall |
| `intent/` | `classifyIntent` / `routeTarget` — L0–L3 classification, domain detection |
| `tools/` | 7 built-in tools: `read_file` `write_file` `edit_file` `list_dir` `glob` `grep` `bash` |
| `tools/registry.ts` | ToolRegistry — register, execute, lifecycle hooks (SecurityPlugin, AnalyticsPlugin) |
| `tools/security.ts` | Path boundary enforcement, tool whitelist, injection defense, read-only mode |
| `tools/permission-rules.ts` | Persistent allow/deny rules, bash risk confirmation |
| `session/` | JSONL session store, cost tracking, session picker, AI-generated titles |
| `repl/` | React + Ink terminal UI — ConversationPanel, SessionPicker, DiffView, theme system |
| `repl/commands/` | `/branch` `/try` `/merge` `/sessions` `/subjobs` `/resume` `/model` and more |
| `memory/` | Cross-turn memory detection (detector / scanner / tracker) |
| `project-context/` | `.vera/rules.md` / `CLAUDE.md` loading, path-scoped rule activation |
| `worktree/` | Git worktree creation and management for `isolation: "try"` |

---

### `@vera/harness` — The Execution Kernel

Everything a multi-step task needs. Stateful. Owns flow orchestration.

| Module | Capability |
|---|---|
| `runtime/flow-state.ts` | Flow state machine — 11 states, legal transition enforcement, illegal jumps throw |
| `runtime/runtime.ts` | `HarnessRuntime` — drives `Plan → Act → Critique → Replan` loop |
| `runtime/planner.ts` | `planFromPrompt` — LLM → `ExecutionPlan`, with retry and JSON repair |
| `runtime/critique.ts` | `critiquePlan` / `critiqueStep` — confidence < 0.7 triggers automatic replan |
| `runtime/approval.ts` | High-risk operation gates — pause flow, await human confirmation |
| `skill/` | Skill loading from Markdown, `SkillResolver` — intent-driven activation |
| `agent/` | `AgentRunner` interface + `ExternalCLIRunner` — pluggable execution backends |
| `evaluator.ts` | `exact` / `contains` / `tool_match` / `llm_judge` evaluation, concurrent execution |
| `cli/` | REPL plan executor, `flow run` CLI, batch execution entry |

---

### Flow State Machine

```
intaking
  → planning
    → dispatching
      → executing
        → waiting_tool
        → waiting_approval   ← human-in-the-loop gate
        → critiquing
          → replanning → dispatching (loop)
          → completed
          → failed
      → paused
```

Every transition is validated. An invalid state jump throws an error — the runtime cannot drift into an inconsistent state.

---

### Technology Stack

| Layer | Technology | Version |
|---|---|---|
| Language | TypeScript (strict, ESM) | `^5.7.0` |
| Package manager | pnpm workspace monorepo | — |
| LLM — Anthropic | `@anthropic-ai/sdk` | `^0.54.0` |
| LLM — OpenAI | `openai` | `^6.34.0` |
| LLM — Google | `@google/generative-ai` | `^0.24.1` |
| Terminal UI | React + Ink | React `^18.3.0`, Ink `^5.2.0` |
| Web UI | Vue 3 + Vite | Vue `^3.5.0`, Vite `^6.0.0` |
| Test runner | Vitest | `^4.1.4` |
| Static analysis | oxlint + eslint-plugin-sonarjs + jscpd | — |

---

## Roadmap

| Phase | Goal | Status |
|---|---|---|
| **P0** | Harness-driven execution runtime | ✅ Complete |
| **P1** | Self-loop & self-correction (checkpoint/resume, memory, critic agent, self-loop runtime) | 🔄 In Progress |
| **P2** | Self-evolution (Dreaming, Proposal Pipeline, benchmark-gated Rollout) | 📋 Planned |
| **P3** | Universal agent platform (Computer Use, MCP, multi-agent networks, adaptive strategy) | 📋 Planned |

### P0 Completed Capabilities (Full List)

- ✅ Intent routing (L0–L3 classification, automatic model selection)
- ✅ Tool runtime (7 built-in tools, SecurityPlugin, AnalyticsPlugin, lifecycle hooks)
- ✅ Tool output rendering (diff / code / bash / file-list / error views, RenderHint system)
- ✅ Infinite context (progressive compression, micro-compaction, reactive compaction, recall)
- ✅ Plan Mode (planner, parser, Flow state machine, HarnessRuntime, REPL integration)
- ✅ Critique loop (per-step critique, confidence-gated replan, retrospective generation)
- ✅ Session persistence (JSONL, cost tracking, resume, conversation branching, AI titles)
- ✅ Subagent system (general-purpose / explore / plan built-ins, tool whitelisting, sidechain sessions)
- ✅ Subagent isolation (try worktree, remote executor, background mode, session resume)
- ✅ Permission system (persistent tool rules, bash risk gates, path boundary enforcement)
- ✅ Custom agent definitions (user-level `~/.vera/agents/*.md`, project-level `.vera/agents/*.md`)
- ✅ Multi-branch result comparison UI (SessionPicker branch compare panel)
- ✅ CLI color theme (semantic tokens, Claude Code-aligned dark theme, `theme.ts`)
- ✅ Pre-commit security scanner (API key detection, credential pattern matching)
- ✅ Project context system (`.vera/rules.md`, path-scoped rules, mtime caching)

---

## Getting Started

```bash
# 1. Copy configuration template
cp .vera/settings.example.json .vera/settings.json

# 2. Add your API keys (file is gitignored — never committed)
#    Edit .vera/settings.json:
#    {
#      "default_provider": "anthropic",
#      "providers": { "anthropic": { "api_key": "sk-ant-..." } },
#      "routing": { "enabled": true }
#    }

# 3. Launch the REPL
pnpm repl

# 4. Run a Flow via CLI
pnpm flow

# 5. Start the Web UI
pnpm serve   # backend
pnpm ui      # frontend
```

### Key Configuration

| Field | Description |
|---|---|
| `providers` | LLM provider configs: `anthropic` / `openai` / `gemini` / `deepseek` / `groq` / `azure` |
| `default_provider` | Which provider to use when not overridden |
| `routing` | Intent routing config — enable/disable, per-level model overrides |
| `mcp_servers` | MCP server definitions for external tool integration |

---

## Documentation Index

| Document | Description |
|---|---|
| [docs/roadmap.md](./roadmap.md) | Full phase roadmap, known defects, fix status, P0 alignment checklist |
| [docs/architecture.md](./architecture.md) | Core vs. Harness responsibility boundaries, dependency graph |
| [docs/harness/design.md](./harness/design.md) | Harness design: six principles, role separation, Challenger, Flow structure |
| [docs/core/agent-design.md](./core/agent-design.md) | Agent capability map: 8-layer model, Hermes inspiration, Dreaming, memory |
| [docs/core/subagent-design.md](./core/subagent-design.md) | Subagent system: orchestrator/worker, isolation modes, scheduling patterns |
| [docs/core/intent-routing.md](./core/intent-routing.md) | Intent routing: L0–L3, model routing, Plan Mode trigger |
| [docs/core/infinite-context-implementation.md](./core/infinite-context-implementation.md) | Infinite context: current implementation, compression layers |
| [docs/core/plan-mode-implementation.md](./core/plan-mode-implementation.md) | Plan Mode: execution chain, state machine, REPL/CLI integration |
| [docs/eval/benchmark.md](./eval/benchmark.md) | Benchmark harness: case format, eval methods, open datasets, concurrent execution |
| [docs/platform/computer-use.md](./platform/computer-use.md) | Computer Use: browser automation, desktop operation (P3) |

---

## The Bigger Picture

We are at an inflection point. Models are capable enough. The bottleneck is now the **execution framework** — the infrastructure that makes agent capabilities reliable, verifiable, and compounding over time.

Vera's architecture is designed for that inflection point:

- **Harness as the kernel** ensures every agent action is governed, every state transition is legal, and every failure produces a traceable artifact
- **Challenger and Critique** ensure that quality gates are real, not self-reported
- **The Proposal Pipeline** ensures that improvement is driven by evidence, not intuition
- **The full evolution loop** (P0 → P1 → P2) ensures the system gets better with use, not just with engineering effort

The end state is an agent runtime where a human provides creative direction and the system reliably, autonomously, and verifiably turns that direction into working reality — at a pace and quality level that no manual process can match.

**That is how we accelerate human creativity. That is how we pursue SOTA AGI.**

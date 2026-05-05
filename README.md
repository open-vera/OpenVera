# Vera — Accelerate Human Creativity, Achieve SOTA AGI

---

## What is Vera?

Vera is a **Harness-native agent runtime** — self-planning, self-looping, self-critiquing, self-evolving.

Most agent systems are smarter assistants: they follow instructions and call tools. Vera is different — its kernel isn't a safety wrapper, it's the **engine that drives everything**. Every tool call, every flow transition, every self-improvement passes through a principled execution framework that keeps agents both powerful and controllable.

We don't just execute tasks. We plan Flows, drive autonomous loops, critique our own outputs, and accumulate hard-won lessons into strategies — making every run better than the last.

```
Human Idea
  → Intent classification & model routing
  → Structured Flow (ExecutionPlan)
  → Step-by-step execution via tool runtime
  → Independent Critique (Challenger)
  → Failure attribution & Replan
  → Lesson persistence → Memory
  → Benchmark-gated Proposal → Rollout
  → Next cycle, within boundaries
```

This isn't a workflow. It's a **closed, self-driving loop** — and every transition is governed.

---

## The Problem We Solve

### Current Agents: Powerful but Brittle

Today's agent systems look diverse, yet fail for the same root causes on complex tasks:

| Problem | Consequence |
|---|---|
| **No structured execution framework** | Complex tasks drift, lose goals, stall mid-way |
| **Self-assessment is unreliable** | Agents are optimistic by design — great at explaining "why it's good enough," poor at finding flaws. No independent verification; quality gates are theater |
| **Context collapses under long tasks** | Early reasoning forgotten, results contradict prior decisions — not because the model is weak, but because nothing manages the context lifecycle |
| **No learning loop** | Failures discarded; same mistakes repeat across runs, users, and versions. No compounding improvement |
| **No governed evolution** | Improving an agent means editing prompts and hoping — no benchmark to measure change, no rollout to control blast radius, no regression tests to detect degradation |

The result: impressive demos, unreliable production. Brilliant on toy tasks, silent failures on real ones.

### The Root Cause

> Without a principled runtime kernel, agent capabilities are just prompt tricks stacked together.

Self-planning without a Harness is uncontrolled. Self-critique without structural independence is noise. Self-evolution without a benchmark loop is wishful thinking.

**We need a different architecture.**

---

## Core Philosophy: Harness as the Kernel

Vera's foundational insight:

> **Don't design a system that produces more output. Design a system that is harder to let unqualified output through.**

This inverts the typical agent design:

| Typical Agent System | Vera |
|---|---|
| Model calls tools directly | All tool calls dispatched through Harness |
| Model decides whether to continue | Harness owns Flow State transitions |
| Model self-assesses completion | Challenger independently scores every step |
| Safety = prompt constraints | Safety = architectural boundaries with legal transition enforcement |
| Failure = retry | Failure = attribution + proposal + regression-validated fix |

### The Six Harness Principles

1. **Define done before starting** — every Flow has explicit exit criteria, deliverables, and failure conditions. An agent that doesn't know what "done" looks like will never reliably stop at the right point
2. **Stage long tasks** — break work into independently verifiable units; eliminate context drift. Even if the session is interrupted, the model is swapped, or the context is reset, the task remains coherent
3. **External critique, not self-assessment** — the Challenger role is structurally independent. It doesn't inherit the implementer's optimism. It evaluates against pre-defined criteria, produces scored structured output, and has veto power
4. **Validate against reality** — run code, execute tests, interact with real interfaces — not just text inspection
5. **Attribute every failure** — misunderstood requirements? wrong implementation? weak validation? Every failure must produce a root cause, not just a retry. Without attribution, recovery is just higher-cost repetition of the same mistake
6. **Persist context as artifacts** — reliable context is structured artifacts, not chat logs. Plans, step results, critique reports — all persisted. The task survives agent swaps, model changes, and context resets

---

## Architecture

Vera is a monorepo with clear separation of concerns:

```
vera/                          ← pnpm workspace monorepo
├── packages/
│   ├── @vera/core             ← Stateless runtime foundation
│   ├── @vera/harness          ← Stateful orchestration kernel
│   └── @vera/benchmark        ← Evaluation infrastructure
└── apps/
    ├── harness-ui/server      ← Web UI backend
    └── harness-ui/web         ← Web UI frontend (Vue 3 + Vite)
```

**Dependency is strictly one-way:** `benchmark → harness → core`. Core never depends on Harness, ensuring the stateless agent loop can be used independently.

### `@vera/core` — The Agent Loop

Everything a single LLM call needs. Stateless. No orchestration logic.

| Module | Capability |
|---|---|
| `adapters/` | Unified `LLMAdapter` interface — Anthropic, OpenAI, Gemini, DeepSeek, Groq, Azure |
| `agent/` | `streamAgent` / `runAgent` — multi-turn loop, tool dispatch, retry, compression |
| `agent/subagent.ts` | `agent` tool — orchestrator/worker delegation, isolation modes, background jobs |
| `context/` | Token estimation, window trimming, progressive/micro/reactive compression, recall |
| `intent/` | `classifyIntent` / `routeTarget` — L0–L3 classification, domain detection |
| `tools/` | 7 built-in tools: `read_file` `write_file` `edit_file` `list_dir` `glob` `grep` `bash` |
| `tools/registry.ts` | ToolRegistry — register, execute, lifecycle hooks |
| `tools/security.ts` | Path boundary enforcement, tool whitelist, injection defense, read-only mode |
| `tools/permission-rules.ts` | Persistent allow/deny rules, bash risk confirmation |
| `session/` | JSONL session store, cost tracking, AI-generated titles |
| `repl/` | React + Ink terminal UI — ConversationPanel, SessionPicker, DiffView, theme system |
| `memory/` | Cross-turn memory detection |
| `project-context/` | `.vera/rules.md` / `CLAUDE.md` loading, path-scoped rule activation |
| `worktree/` | Git worktree creation and management |

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
| `evaluator.ts` | `exact` / `contains` / `tool_match` / `llm_judge` evaluation, concurrent execution |

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

### Technology Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (strict, ESM) |
| Package manager | pnpm workspace monorepo |
| LLM adapters | Anthropic, OpenAI, Gemini, DeepSeek, Groq, Azure |
| Terminal UI | React + Ink |
| Web UI | Vue 3 + Vite |
| Test runner | Vitest |
| Static analysis | oxlint + eslint-plugin-sonarjs + jscpd |

---

## Intent Routing — Right Model, Right Cost

```
User input → [classify: ~100ms, haiku/mini] → routing decision → [target model]
```

| Level | Description | Model |
|---|---|---|
| L0 | Casual chat, simple Q&A | claude-haiku / gpt-4o-mini |
| L1 | Single-step tasks | claude-haiku / gpt-4o-mini |
| L2 | Multi-step tasks | claude-sonnet / gpt-4o |
| L3 | Complex planning, deep reasoning | claude-opus / o3 |

L3 tasks automatically activate Plan Mode. Target: L0/L1 routing accuracy > 95%, overall cost reduction > 60%.

---

## What Makes Vera Different

### 1. Cognitive Role Separation — the most important engineering principle

```
Planner      Reads context → generates ExecutionPlan → adapts to task complexity
Role Agent   Executes steps to defined exit criteria → produces deliverables
Challenger   Independently scores every output → accumulates lessons → gets sharper each run
Orchestrator Schedules agents → manages context resets → enforces approval gates
```

**The critical constraint:** A Role Agent never decides whether its own work is complete. That right belongs exclusively to the Challenger.

This separation prevents the most common failure mode in agent systems: an agent that is simultaneously implementer, evaluator, and judge of its own work.

### 2. Harness is the kernel, not a constraint layer

Other systems bolt on safety checks. Vera inverts this: the Harness drives every action, and agents are strategies running on top of it.

- Agents cannot exceed their scope — by architecture, not by prompt
- Flow state transitions are validated — illegal jumps throw errors
- Critique is structurally independent — the same agent cannot be both implementer and judge

### 3. Infinite Context, No Degradation

Vera's three-layer context system handles tasks of any length:

| Layer | Mechanism | Trigger |
|---|---|---|
| Sliding window trim | Drop earliest turns, preserve task anchor | Token threshold at 80% |
| Progressive compression | LLM summarization of old turns, injected as system context | Token threshold exceeded |
| Micro-compaction | Heuristic cleanup of stale tool results — no LLM call | Time-gap based |
| Reactive compaction | Aggressive compression + retry on `prompt-too-long` error, with circuit breaker | API error response |

**The first message (original task definition) is always preserved.** The agent never loses its goal.

### 4. Subagents with Real Isolation

The `agent` tool supports three isolation modes:

| Mode | Mechanism | Use Case |
|---|---|---|
| `none` | Shared context (default) | Standard delegation |
| `try` | Isolated git worktree — changes reviewable via `/merge` | Experimental code changes |
| `remote` | Pluggable external executor backend | Distributed or sandboxed execution |

Subagents inherit parent Harness constraints. They cannot escalate permissions. Results carry transcript IDs for full auditability.

### 5. Challenger Learns — Attacks Get Sharper Over Time

After every run, the Challenger appends discovered failure patterns to `.flow/challenger/lessons/{step}.md`. On the next run, it reads those lessons and applies them as attack angles. Over time, the system becomes harder to fool — not because the model improves, but because the framework accumulates institutional knowledge about where this specific codebase or workflow tends to fail.

### 6. Self-Evolution Through a Governed Pipeline

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

## Roadmap

| Phase | Goal | Status |
|---|---|---|
| **P0** | Harness-driven execution runtime | ✅ Complete |
| **P1** | Self-loop & self-correction (checkpoint/resume, memory, critic agent, self-loop runtime) | 🔄 In Progress |
| **P2** | Self-evolution (Dreaming, Proposal Pipeline, benchmark-gated Rollout) | 📋 Planned |
| **P3** | Universal agent platform (Computer Use, MCP, multi-agent networks, adaptive strategy) | 📋 Planned |

### P0 Completed Capabilities

- ✅ Intent routing (L0–L3 classification, automatic model selection)
- ✅ Tool runtime (7 built-in tools, SecurityPlugin, lifecycle hooks)
- ✅ Tool output rendering (diff / code / bash / file-list / error views)
- ✅ Infinite context (compression, micro-compact, reactive compact, recall)
- ✅ Plan Mode (planner, parser, Flow state machine, HarnessRuntime, REPL integration)
- ✅ Critique loop (per-step critique, confidence-gated replan, retrospective)
- ✅ Session persistence (JSONL, cost tracking, resume, conversation branching, AI titles)
- ✅ Subagent system (general-purpose / explore / plan, tool whitelisting, sidechain sessions)
- ✅ Subagent isolation (try worktree, remote executor, background mode, session resume)
- ✅ Permission system (persistent tool rules, bash risk gates, path enforcement)
- ✅ Custom agent definitions (`~/.vera/agents/*.md`, `.vera/agents/*.md`)
- ✅ Multi-branch result comparison UI
- ✅ CLI color theme (semantic tokens, Claude Code-aligned dark theme)
- ✅ Pre-commit security scanner (API key detection, credential pattern matching)
- ✅ Project context system (`.vera/rules.md`, path-scoped rule activation)

---

## Getting Started

```bash
# Copy config template
cp .vera/settings.example.json .vera/settings.json

# Add your API keys (file is gitignored — never committed)
# Edit .vera/settings.json:
# {
#   "default_provider": "anthropic",
#   "providers": { "anthropic": { "api_key": "***" } },
#   "routing": { "enabled": true }
# }

# Launch REPL
pnpm repl

# Run a Flow via CLI
pnpm flow

# Start Web UI
pnpm serve   # backend
pnpm ui      # frontend
```

### Key Configuration

| Field | Description |
|---|---|
| `providers` | LLM provider configs: anthropic / openai / gemini / deepseek / groq / azure |
| `default_provider` | Which provider to use when not overridden |
| `routing` | Intent routing config — enable/disable, per-level model overrides |
| `mcp_servers` | MCP server definitions for external tool integration |

---

## Documentation

| Document | Description |
|---|---|
| [docs/roadmap.md](./docs/roadmap.md) | Full phase roadmap, known defects, fix status |
| [docs/architecture.md](./docs/architecture.md) | Core vs. Harness responsibility boundaries and dependency graph |
| [docs/harness/design.md](./docs/harness/design.md) | Harness design: six principles, role separation, Challenger, Flow structure |
| [docs/core/agent-design.md](./docs/core/agent-design.md) | Agent capability map: 8-layer model, infinite context, memory, dreaming |
| [docs/core/subagent-design.md](./docs/core/subagent-design.md) | Subagent system: orchestrator/worker, isolation modes, scheduling patterns |
| [docs/core/intent-routing.md](./docs/core/intent-routing.md) | Intent routing: L0–L3 classification, model selection, plan mode trigger |
| [docs/core/infinite-context-implementation.md](./docs/core/infinite-context-implementation.md) | Infinite context: implementation status, compression layers |
| [docs/core/plan-mode-implementation.md](./docs/core/plan-mode-implementation.md) | Plan Mode: execution chain, state machine, REPL/CLI integration |
| [docs/eval/benchmark.md](./docs/eval/benchmark.md) | Benchmark harness: case format, eval methods, open datasets |

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

## Star History

<a href="https://www.star-history.com/?repos=open-vera%2FOpenVera&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=open-vera/OpenVera&type=date&theme=dark&legend=bottom-right" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=open-vera/OpenVera&type=date&legend=bottom-right" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=open-vera/OpenVera&type=date&legend=bottom-right" />
 </picture>
</a>

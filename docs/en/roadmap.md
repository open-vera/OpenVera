# OpenVera — Roadmap

## Guiding Principles

This roadmap is not a feature checklist — it is OpenVera's phased operational strategy. The goal is not to catch up with existing agents, but to build a **Harness-native agent runtime that self-plans, self-loops, self-critiques, and self-evolves**.

> Vera doesn't just execute tasks. Under Harness constraints, it plans its own flows, drives its own loops, critiques its own results, accumulates experience, and drives system evolution.

### Core Judgment

Harness is not treated as a "security shell" — it is the **system kernel**.

- The agent does not touch tools directly — Harness schedules tool calls.
- The agent does not decide continuation directly — Harness manages Flow State.
- The agent does not modify itself directly — Harness manages Critique, Proposal, Rollout, and validation.

Without this kernel design, self-planning, self-looping, and self-evolution become unreliable prompt tricks rather than engineered system capabilities.

---

## Phase Roadmap

### P0 — Build a "Harness-Driven Agent Runtime" -- COMPLETE

Establish the minimal viable self-loop: `Understand task -> Create Flow -> Execute with tools -> Critique -> Continue or stop within boundaries`

| # | Capability | Status |
|---|-----------|--------|
| 1 | Intent Recognition & Model Routing (L0/L1/L2/L3) | Done |
| 2 | Tool Runtime Foundation (ToolDef, ToolRegistry, 7 built-in tools) | Done |
| 3 | Tool Lifecycle Hook System (SecurityPlugin, AnalyticsPlugin, AgentHooks Tier 1+2) | Done |
| 4 | Tool Output Rendering (RenderHint, DiffView, CodeView, BashOutputView, etc.) | Done |
| 5 | Session Persistence & Cost Tracking (JSONL, resume, status, sessions list) | Done |
| 6 | Infinite Context (progressive compression, micro-compact, reactive compact) | Done |
| 7 | Plan Mode Foundation (ExecutionPlan, Flow State Machine, HarnessRuntime + runFlowLoop) | Done |
| 8 | Critique Foundation (CritiqueResult, CritiqueRunner, critiqueStep -> replan) | Done |
| 9 | Harness Flow Control (Flow State machine, high-risk approval gate, SecurityPlugin) | Done |

**P0 Acceptance Criteria:**
- Given a moderately complex coding task, the agent can reliably complete read -> analyze -> edit -> test
- After execution, it actively critiques the result and decides whether to continue
- Operations exceeding directory/domain/budget bounds are blocked with explanations
- Every run leaves a replayable trace

---

### Known Defects & Tech Debt

> P0 implementation is complete, but a 2026-04-28 architecture audit identified runtime defects and weak points that must be fixed before P1 begins. **All Critical, High, and Medium issues have been resolved.**

**Critical (all fixed):**
- C1: Micro-compact timestamp bug (infinite context effectively not working)
- C2: Bare `JSON.parse` on tool arguments in loop.ts (malformed JSON crashes agent loop)
- C3: Empty-after-tool-result had only 1 retry
- C4: Streaming lacked error recovery
- C5: Harness Step dependency had no cycle detection

**High (all fixed):**
- H1: Test coverage ~8.5%, core paths unverified
- H2: Compression state changes non-atomic
- H3: Gemini streaming no usage reporting
- H4: Critique no internal retry loop
- H5: Approval flow (`waiting_approval`) incomplete
- H6: No step-level timeout or budget enforcement

**Medium (all fixed):**
- M1-M6: Token estimation, window trimming, tool result timing, compression cost tracking, planId collision risk

---

### P1 — Complete "Self-Loop and Self-Correction" Capabilities -- MOSTLY COMPLETE

Upgrade Vera from a controlled executor to an agent that can independently drive complex Flows.

| # | Capability | Status |
|---|-----------|--------|
| 1 | Checkpoint / Resume (save state after key steps, resume after interruption) | Done |
| 2 | Memory System (Working/Episodic/Semantic, memory_write/search tools) | Done |
| 3 | AgentRunner Interface (decouples Harness from Core agent implementation) | Done |
| 4 | Tool Runtime Enhancements (idempotency, retryable error classification, dry-run) | Done |
| 5 | Subagent System (Orchestrator/Worker, parallel fan-out, context sharing, recursive subagents) | Done |
| 6 | Voice Input (push-to-talk, streaming STT via Deepgram, focus mode) | Done |
| 7 | Self-Loop Runtime (SelfLoopRunner, Plan->Act->Critique->Replan loop with termination conditions) | Done |
| 8 | Critic Agent (independent critique of execution results, structured scoring, debate) | Done |
| 9 | Prompt Management (system prompt templates, domain profiles, versioning, A/B comparison) | Done |
| 10 | Failure Recovery & Attribution (root cause recording, failure classification, auto-replay) | Done |

**P0 Post-Alignment Items (completed):**
- Permission & authorization UX: persisted tool rules, bash risk confirmation, command allow/deny patterns
- Project context: rule priority, mtime caching, scoped activation by path
- UI display: grouped collapsed summaries, subagent summary + transcript
- Subagent (Claude Code alignment): agent tool, custom definitions, worktree isolation, remote isolation, background mode
- Session UX: multi-project/worktree scanning, metadata, AI titles, branch lifecycle (`/try`, `/merge`), search with filters
- Reliability: session isolation tests, unified smoke suite
- CLI color theme: semantic tokens based on Claude Code dark theme

**P1 Acceptance Criteria:**
- Long tasks can resume after interruption without restarting from scratch
- Multiple workers can concurrently complete non-conflicting sub-tasks
- A complex task can run multiple Critique/Replan cycles autonomously within budget
- Same class of failures can be archived, retrieved, and reproduced

---

### P2 — Establish "Self-Evolution" Loop

Not just "more testing" — a genuine controlled evolution mechanism. Every architecture, prompt, and tool policy change must be quantifiably validated and managed through Harness Rollout.

| # | Capability | Status |
|---|-----------|--------|
| 1 | Intelligent Automated Testing (AI-driven UI testing, multi-strategy element location, self-healing tests) | Done |
| 2 | Benchmark Harness (case loading, agent execution, result evaluation, report generation) | Done |
| 3 | AI-Generated Test Cases (edge case generation, semantic mutation testing, failure clustering) | Done |
| 4 | Dreaming System (aggregate episodic memory + benchmark failures, distill insights, produce improvements) | Done |
| 5 | Proposal Pipeline (Critique/dreaming -> Proposal -> human review -> limited Rollout -> verify) | Done |
| 6 | Production Feedback Loop (real task failures enter benchmark pool, high-value cases become regression tests) | Done |

**P2 Acceptance Criteria:**
- Every agent loop / prompt / tool policy change triggers regression evaluation
- Visible trends for pass rate, tool accuracy, flaky rate
- Dreaming output is validated by benchmark as effective
- Critique / Proposal / Rollout has a complete auditable chain

---

### P3 — Expand to General Agent Platform

Extend to broader environments once P0-P2 are stable.

| # | Capability | Status |
|---|-----------|--------|
| 1 | Computer Use (Playwright/CDP browser automation, desktop operation, multi-step orchestration) | Done |
| 2 | MCP Support (MCP client, connect third-party tool servers, unified schema + permission governance) | Done |
| 3 | Multi-Agent Collaboration Network (message bus, task scheduling, shared memory, permission inheritance) | Done |
| 4 | Adaptive Strategy System (domain-specific prompt/model/tool policy, auto-tuning by success rate) | Done |

---

## Recommended Execution Order

```
[Complete] Intent Routing
[Complete] Session Persistence + Cost Tracking
[Complete] Tool Runtime Foundation
[Complete] Tool Output Rendering
[Complete] Plan Mode Foundation
[Complete] AgentHooks Tiered Hook System
[Complete] Self-Loop Runtime (P1)
[Complete] Checkpoint/Resume
[Complete] Memory System
[Complete] Subagent System
[Complete] P2: Benchmark Harness -> Dreaming -> Proposal Pipeline
[Complete] P3: Computer Use / MCP / Multi-Agent / Adaptive Strategy
```

Execution principles:
1. Build the harness kernel first, then agent intelligence. Without a kernel, self-loop and self-evolution only lead to chaos.
2. Build the runtime first, then more complex strategy layers. Without a stable execution layer, memory and dreaming are castles in the air.
3. Build Critique and benchmark first, then large-scale optimization. Without critique and evaluation, evolution is unfalsifiable.

---

## North Star Questions

### P0 North Star
> Can Vera, under Harness constraints, complete a real task loop on its own and know when to continue and when to stop?

### P1 North Star
> Can Vera autonomously run multiple Plan -> Act -> Critique -> Replan cycles within a budget and steadily advance complex tasks?

### P2 North Star
> Can Vera turn self-critique into controlled strategy proposals and use benchmark/Rollout to prove it has genuinely evolved?

### P3 North Star
> Can Vera expand from code scenarios into a general Harness Runtime across tools, environments, and agents?

---

## Architecture Notes

### Core / Harness Boundary

**Core** = minimal loop for a single LLM call: adapter -> stream -> tool call schema -> ToolResult.
**Harness** = multi-step workflow: ExecutionPlan state machine, Flow State, Critique loop, Checkpoint.

Dependency: `harness -> core`. Core is unaware of Harness.

| Concern | Owner |
|---------|-------|
| LLM adapter / streaming | Core |
| Tool schema + ToolResult types | Core |
| ToolLifecycleHook interface | Core |
| ToolRegistry + built-in tool implementations | Core |
| HarnessPlugin (path/budget/injection) | Core (registered as hook, configured by Harness) |
| ExecutionPlan / Step / Flow State | Harness |
| Critique / Proposal / Rollout | Harness |
| Checkpoint / Resume (Plan level) | Harness |
| Session JSONL persistence | Core (read/write by Harness) |

### Two Kinds of "Plan"

- **Agent Plan** (LLM text output): the model's natural-language plan in an assistant message, unstructured, for human reading.
- **Harness ExecutionPlan** (runtime data structure): a state machine with `Step[]`, `currentStepIndex`, `status`, controlling actual execution flow.

These are two stages of the same thing: LLM outputs a text Plan -> Harness parses it into ExecutionPlan -> drives tool calls step by step.

### AgentRunner Interface

Harness needs to call an agent (LLM executing a step) when dispatching Plan Steps. To avoid Harness directly importing `runAgent` from Core (tight coupling), the interface is defined in Core:

```ts
// packages/core/src/types/agent.ts
interface AgentRunner {
  run(prompt: string, tools: Tool[], ctx: RunContext): Promise<AgentResult>;
}
```

Harness depends on the `AgentRunner` interface. Core provides the default implementation. Future agent engines (LangGraph, AutoGen) can be substituted without modifying Harness.

---

## Benchmark Plan

Benchmarking is not about "scores" — it answers specific questions: which task types does the agent reliably complete, where does it fail, and why.

### Evaluation Dimensions

| Dimension | What It Measures | Method |
|-----------|-----------------|--------|
| Task Completion Rate | Can it achieve the goal | Pass/Fail, N-repetition average |
| Tool Call Accuracy | Right tool, right params | Compare against golden tool call |
| Step Efficiency | How many steps to complete | Count turns |
| Token Efficiency | Token consumption per task | From usage fields |
| Stability | Consistency across 5 runs | Variance / std deviation |

### Open-Source Benchmarks

**General Agent Capability:**
- **GAIA** (HuggingFace): multi-step reasoning + tool use, L1/L2/L3 tiers, community leaderboard — recommend starting with L1
- **AgentBench**: 8 real environments (OS, DB, Web, games, etc.)
- **SWE-bench Verified**: real GitHub issues for agents to fix — code scenario specialty

**Tool Calling:**
- **ToolBench / ToolEval**: 16,000+ real APIs, tests tool selection and parameter generation
- **API-Bank**: tiered difficulty, single-call vs multi-step

**Reasoning & Planning:**
- **ALFWorld**: text game environment, tests planning chains
- **HotpotQA / MuSiQue**: multi-hop QA, good for retrieval-augmented agents

**Computer Use Specialty:**
- **WebArena**: multi-step web tasks on real websites
- **OSWorld**: cross-app desktop operation, screenshots + action sequences
- **ScreenSpot**: GUI grounding, clicking correct elements

### Recommended Strategy

1. Run **GAIA L1** first: moderate volume, standard answers, community for comparison
2. Run **SWE-bench Verified** (subset) when code scenarios mature
3. Run **WebArena** when Computer Use goes live
4. **Build custom cases** to cover scenarios open-source suites miss

### When to Run Benchmarks

- After changing prompts or loop logic
- When comparing models (Claude vs GPT vs Gemini)
- In CI as regression tests (L1 only, fast and cheap)

# @open-vera/openvera

Stateful orchestration kernel for the Vera framework.

Drives multi-step autonomous tasks through a principled `Plan → Act → Critique → Replan` loop. Every flow transition is validated; the runtime cannot drift into an inconsistent state.

## Install

```bash
npm install @open-vera/openvera
```

Requires `@open-vera/core` as a peer dependency.

## What's Inside

| Module | Capability |
|---|---|
| `runtime/flow-state.ts` | Flow state machine — 11 states, legal transition enforcement, illegal jumps throw |
| `runtime/runtime.ts` | `HarnessRuntime` — drives `Plan → Act → Critique → Replan` loop |
| `runtime/planner.ts` | `planFromPrompt` — LLM → `ExecutionPlan`, with retry and JSON repair |
| `runtime/critique.ts` | `critiquePlan` / `critiqueStep` — confidence < 0.7 triggers automatic replan |
| `runtime/approval.ts` | High-risk operation gates — pause flow, await human confirmation |
| `skill/` | Skill loading from Markdown, `SkillResolver` — intent-driven activation |
| `evaluator.ts` | `exact` / `contains` / `tool_match` / `llm_judge` evaluation, concurrent execution |

## Flow State Machine

```
intaking
  → planning
    → dispatching
      → executing
        → waiting_tool
        → waiting_approval   ← human-in-the-loop gate
        → critiquing
          → replanning → dispatching  (loop)
          → completed
          → failed
      → paused
```

Every transition is validated. An invalid state jump throws immediately — the runtime cannot silently drift.

## Cognitive Role Separation

```
Planner      Reads context → generates ExecutionPlan
Role Agent   Executes steps to defined exit criteria → produces deliverables
Challenger   Independently scores every output → accumulates lessons
Orchestrator Schedules agents → manages context resets → enforces approval gates
```

A Role Agent never decides whether its own work is complete — that right belongs exclusively to the Challenger. This prevents the most common agent failure mode: acting as implementer, evaluator, and judge simultaneously.

## Challenger Learns Over Time

After every run the Challenger appends discovered failure patterns to `.flow/challenger/lessons/{step}.md`. On the next run it reads those lessons and applies them as attack angles — the system becomes harder to fool as it accumulates institutional knowledge about where this specific workflow tends to fail.

## Quick Start

```typescript
import { HarnessRuntime } from "@open-vera/openvera";
import { AnthropicAdapter } from "@open-vera/core/adapters";

const runtime = new HarnessRuntime({
  adapter: new AnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY }),
  cwd: process.cwd(),
});

await runtime.run("Refactor the authentication module and add unit tests");
```

## CLI

```bash
# Run a flow
openvera flow run

# Launch REPL with Harness
openvera repl --dir .
```

## Architecture

```
@open-vera/openvera → @open-vera/core
```

Harness owns flow orchestration. Core handles single LLM call execution. Dependency is strictly one-way — Core is usable standalone.

## License

MIT

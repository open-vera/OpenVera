# Core vs Harness — Responsibility Boundaries

> Clarifying the division of responsibilities, isolation boundaries, and shared components between `@vera/core` and `@vera/harness`.

---

## 0. One-Line Definitions

| Package | Definition |
|---------|------------|
| `@vera/core` | **What a single LLM call needs** — adapters, agent loop, context management, protocol types |
| `@vera/harness` | **What a multi-step task needs** — flow orchestration, planning, critique, artifact persistence, evaluation |

Dependency direction: `harness -> core`. **Core never depends on Harness.**

---

## 1. Core Responsibilities

### 1.1 In Scope

| Module | Contents |
|--------|----------|
| **LLM Adapter** | Wraps Anthropic / OpenAI / Gemini APIs behind the unified `LLMAdapter` interface |
| **Agent Loop** | `runAgent` / `streamAgent` — message loop, tool calls, multi-turn conversation |
| **Subagent** | `agent/subagent.ts` — `agent` tool implementation: sidechain sessions, isolation worktrees, custom agent definition loading |
| **Context Management** | Sliding window trimming, token estimation, tool result budgeting (prevents single results from blowing up context) |
| **Intent Classification** | `classifyIntent`, `routeTarget` — L0-L3 tiering, domain recognition |
| **Config Schema** | `VeraConfig`, `MCPServerConfig`, and other configuration types with loading logic |
| **Protocol Types** | `Message`, `Tool`, `CompletionRequest`, `ContentPart`, `Usage` |
| **Runtime Protocol Types** | `HarnessState`, `ExecutionPlan`, `TaskFlow`, etc. — types defined in core, implementations in harness |
| **Permission Rules** | `tools/permission-rules.ts` — persisted tool rules, bash allow/deny patterns, supplementing SecurityPlugin static checks |
| **Project Context** | `project-context/` — loads `.vera/rules.md`, `CLAUDE.md`, and other project-level prompt rules, activated by path scope |
| **Memory Tracking** | `memory/` — cross-turn memory detection (detector), scanner, tracker, providing short-term memory anchors for the agent |
| **Session Management** | `session/` — JSONL storage, cost tracking, AI auto-titling (`title.ts`), session picker paginated scanning |
| **REPL & Workspace** | `repl/` — interactive terminal UI (Ink), session storage, `workspace.ts` managing current cwd / ToolRegistry / worktree state |
| **REPL Commands** | `/branch` `/branches` `/switch` `/drop` conversation branching; `/try` creates isolated git worktree; `/merge` applies diff; `/adopt` marks branch; `/sub` (`/transcript`) views subagent sidechain |
| **CLI Color Theme** | `repl/ui/theme.ts` — unified semantic color tokens, Claude Code-based palette, all UI components reference via `theme.*` |

### 1.2 Out of Scope

- Any cross-step state machine (which step we're on, whether to replan)
- Critique / Retrospective generation logic
- Artifact persistence
- Skill loading, parsing, and on-demand activation
- MCP server connection and management
- Evaluation framework (TestCase, Evaluator)

---

## 2. Harness Responsibilities

### 2.1 In Scope

| Module | Contents |
|--------|----------|
| **Flow State Machine** | `HarnessRuntime` — manages `intaking -> planning -> dispatching -> executing -> critiquing -> ...` |
| **Plan Management** | Creating `ExecutionPlan`, dispatching Steps, dependency resolution, replan |
| **Critique Loop** | `critiquePlan`, `critiqueStep`, `generateRetrospective` — LLM judges output quality |
| **Proposal Generation** | Deriving strategy improvement proposals from Retrospective |
| **Artifact Persistence** | `writeArtifact`, timeline, checkpoint — writes to disk, ensures replayability |
| **Approval Workflow** | High-risk operation pausing, waiting for human confirmation |
| **Skill System** | Skill loading (markdown -> runtime objects), SkillResolver activates by intent on demand |
| **MCP Management** | Reads `settings.json` `mcp_servers`, spawns processes, maintains connections |
| **Evaluation Framework** | `runCase`, `runSuite`, `evaluate` — TestCase execution and scoring |
| **Markdown Flow** | Loads plan definitions from `.md` files |

### 2.2 Out of Scope

- Direct LLM API calls (always goes through `@vera/core` adapters)
- Context window trimming (handled internally by `streamAgent`)
- Token calculation (uses `@vera/core`'s `estimateMessageTokens`)
- Protocol type definitions (imports from `@vera/core/types`)

---

## 3. Reusable Shared Components

These are provided by core and can be used directly by harness and other consumers (REPL, CLI, tests) **without re-implementation**.

### 3.1 LLMAdapter Interface

```ts
import type { LLMAdapter } from "@vera/core/adapters";
```

All LLM calls within harness go through `LLMAdapter`, never directly instantiating `AnthropicAdapter`. This enables mock adapter injection in tests.

### 3.2 streamAgent / runAgent

```ts
import { streamAgent } from "@vera/core/agent";
```

Harness's `runAgentAssignment`, evaluator's `runCase` all call this, never implementing their own turn loop.

### 3.3 Protocol Types

```ts
import type { Tool, Message, Usage, ContentPart } from "@vera/core/types";
```

### 3.4 Runtime Protocol Types

```ts
import type {
  HarnessState, ExecutionPlan, TaskFlow,
  CritiqueResult, StepResult, AgentAssignment,
  // ...
} from "@vera/core/types";
```

**Defined in core, implemented in harness.** Core owns the type contract, harness provides concrete behavior. This allows third parties to implement their own harness without forking core.

### 3.5 Intent Classification

```ts
import { classifyIntent, routeTarget } from "@vera/core/intent";
```

Harness's SkillResolver uses `IntentResult` to decide which skills to activate; the REPL uses it to decide model routing. Same classification result, used on both sides.

### 3.6 Config Types

```ts
import type { VeraConfig, MCPServerConfig } from "@vera/core/config";
```

Harness reads `settings.json`'s `mcp_servers`, core defines the schema.

---

## 4. Boundary Issues to Address

### 4.1 `core/src/index.ts` Does Too Much (Resolved)

`core/src/index.ts` has been cleaned up — it now contains only library re-exports (no adapter initialization, routing, hardcoded tools, or REPL startup). The executable CLI entry lives in `main.ts` (run via `tsx src/main.ts`), which has top-level side effects but is never imported as a library.

### 4.2 Whether REPL Belongs in Core (Acceptable Short-Term)

REPL currently lives in core, but REPL depends on `SessionStore`, which is stateful application-level capability. Acceptable short-term (workspace.ts already encapsulates session/worktree state). Long-term, consider extracting to `apps/repl`, with core providing only a stateless agent loop.

### 4.3 `harness/types.ts` vs `core/types/runtime.ts` Duplication (Resolved)

Harness no longer defines its own `ToolCallRecord`. It now re-exports `ToolCallRecord` from `@open-vera/core/types` (the canonical runtime protocol definition). Additionally, the tool-stats `ToolCallRecord` in `core/src/tools/types.ts` was renamed to `ToolExecutionRecord` to eliminate the naming collision at the core level.

### 4.4 Memory Module Boundary (Implemented, Clear)

`memory/` is implemented as cross-turn memory detection (scanner / tracker / detector), belonging to the agent loop's perception layer — correctly placed in core. Long-term, if memory requires LLM summary writes or vector retrieval, summary generation logic should stay in core (stateless LLM calls), while persistence strategy migrates to harness.

---

## 5. Dependency Graph

```
apps/
  +-- harness-ui  --->  @vera/harness  --->  @vera/core
  +-- audio-label --->  @vera/core

packages/
  +-- harness     --->  @vera/core
  +-- benchmark   --->  @vera/harness, @vera/core
  +-- core        (no internal dependencies)
```

**Forbidden direction**: `core` -> `harness`, `core` -> `apps/*`

---

## 6. Where to Add New Capabilities

| New Capability | Where | Rationale |
|----------------|-------|-----------|
| New LLM provider | core/adapters | Pure protocol adaptation |
| Skill loading / SkillResolver | harness | Depends on intent classification + MCP connections |
| MCP connection management | harness | Stateful, depends on settings.json |
| New Critique strategy | harness/runtime | Flow logic |
| New eval method | harness/evaluator | Evaluation framework |
| New protocol type (e.g., ACP message body) | core/types | Type contracts belong in core |
| ACP dispatch logic | harness/runtime | Flow orchestration belongs in harness |
| Context window strategy adjustment | core/context | Context management belongs in core |
| New REPL command | core/repl/commands | Command lifecycle at REPL layer |
| Subagent type/behavior | core/agent/subagent | Sidechain + worktree isolation in core |
| Persisted tool permission rules | core/tools/permission-rules | Rule read/write is tool-layer capability, not flow orchestration |
| Project-level prompt rules | core/project-context | Stateless loading, injected into system prompt by loop |
| UI colors / component styles | core/repl/ui/theme.ts | Centralized semantic token management, components import by reference |

# Flow Configuration and Usage

> Flow is Vera Harness's multi-stage task orchestration framework. It defines stages, agent assignments, and dependencies through declarative Markdown, with a state-machine-driven runtime that automatically executes, evaluates, retries, and recovers.

---

## Overview

Flow decomposes complex tasks into ordered stage pipelines, where each stage is executed by a designated agent and stages are scheduled in parallel via a DAG. The runtime features built-in Plan Mode for generating execution plans, Critique cycles for evaluating results, and a Checkpoint mechanism for resuming from interruptions.

| Capability | Description |
|---|---|
| Declarative definition | Markdown frontmatter + structured body, no code required |
| Multi-agent collaboration | Different stages can assign different agents (with independent model / skills / rules / mcp) |
| DAG scheduling | Dependencies declared via `dependsOn`; independent stages run in parallel automatically |
| Automatic evaluation | Each stage enters the Critiquing state after execution for LLM-based pass/fail assessment |
| Retry and replan | Retry on failure; trigger replan on significant deviation |
| Checkpoint persistence | JSONL checkpoints auto-saved at stage boundaries; resumable after interruption |

---

## Directory Structure

All Flow definitions are stored under the project's `.vera/flows/`:

```
.vera/flows/
├── flow/                          # Flow definitions (can have multiple)
│   └── <name>/
│       └── main.md                # Flow entry definition (required)
├── stages/                        # Reusable stage templates (optional)
│   └── <name>/
│       └── main.md
├── agents/                        # Agent role definitions (optional)
│   └── <name>/
│       └── main.md
└── iterations/                    # Execution artifacts (auto-generated)
    └── <flow-name>/<flow-id>/     # Unique ID per run
```

- **flow/** — One subdirectory per Flow. The CLI recognizes a valid Flow project only if at least one subdirectory containing `main.md` exists.
- **stages/** — Reusable stage templates. Flows reference the directory name here via the `stage` field; the runtime loads the instruction body from `stages/<name>/main.md`.
- **agents/** — Reusable agent roles. Each agent can specify an independent model, adapter, skills, rules, mcp, and systemPrompt.
- **iterations/** — Auto-generated artifacts directory containing timeline, plan JSON, step results, critique results, etc.

---

## Flow Definition Format (main.md)

### Full Structure

```markdown
---
name: Code Review Pipeline
max_retries: 3
max_parallel: 2
workspace: ../..
---

# Goal

Review code changes on the current branch relative to main, checking security, performance, and code style.

## Stages

- id: security-scan
  stage: analyze
  agents: [security-bot]
  dependsOn: []

- id: code-review
  stage: review
  agents: [reviewer]
  dependsOn: [security-scan]
```

### Frontmatter Fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | No | Directory name | Flow display name |
| `max_retries` | number | No | `3` | Max retries on stage failure |
| `max_parallel` | number | No | `3` | Max concurrent stage executions |
| `workspace` | string | No | `../..` | Working directory relative to `.vera/flows/` |

### # Goal

The `# Goal` heading section declares the core objective. The runtime extracts the first non-empty line of text as `ExecutionPlan.goal`.

Parsing code (`parser.ts`):
```typescript
function extractGoal(body: string): string {
  const match = body.match(/(?:^|\n)#\s+(?:Goal|目标)\s*\n([\s\S]*?)(?=\n#|$)/);
  const first = match?.[1]?.split("\n").find((line) => line.trim());
  return first?.trim() ?? "Execute flow";
}
```

### ## Stages

A YAML-style list where each item defines a stage:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | Unique stage identifier, used for dependency references and log tracking |
| `stage` | string | No | Referenced stage template name (subdirectory name under `stages/`); defaults to `id` if omitted |
| `agents` | string[] | No | Agent list bound to this stage. Overrides agents defined in the stage template |
| `depends_on` / `dependsOn` | string[] | No | List of prerequisite stage IDs |

Dependencies form a DAG. The runtime detects circular dependencies in `dispatchStep()` and throws an error. Independent stages can run in parallel, with `max_parallel` controlling concurrency.

---

## Stage Templates (stages/<name>/main.md)

```markdown
---
name: Code Analysis
agents: [analyzer]
---

Please perform the following checks on the code:
1. Security vulnerabilities (SQL injection, XSS, CSRF)
2. Sensitive information exposure (hardcoded API Keys)
3. Dependency risks (known vulnerable versions)

## Exit Criteria

All checks must pass. If any high/critical findings are present, this stage is considered failed.
```

| Frontmatter Field | Type | Description |
|---|---|---|
| `name` | string | Stage display name |
| `agents` | string[] | Default agent list (overridden by Flow-level Stage `agents`) |

### Exit Criteria

The `## Exit Criteria` section defines stage pass conditions. The runtime injects this into the step prompt (`stepPromptByStepId`); the LLM evaluates against it during the Critique phase. If undefined, default heuristic evaluation is used.

---

## Agent Definitions (agents/<name>/main.md)

```markdown
---
name: Security Inspector
model: claude-sonnet-4-20250514
adapter: anthropic
skills: [quality-scan, security-review]
rules: [coding-standards]
mcp: [km-mcp-server]
---

You are a senior security engineer specializing in web application security review.

Responsibilities:
1. Check code changes for security vulnerabilities
2. Assess third-party dependency security
3. Output a structured review report
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | No | Agent display name |
| `model` | string | No | Specified model; falls back to CLI global `--model` if unset |
| `adapter` | string | No | LLM adapter; falls back to CLI global `--provider` if unset |
| `skills` | string[] | No | Visible skill list, constraining available tool scope |
| `rules` | string[] | No | Visible rule file list |
| `mcp` | string[] | No | Accessible MCP server list |
| body | - | Yes | Full system prompt (systemPrompt) |

skills/rules/mcp define the agent's visibility boundary. When unconfigured, the global default SkillBundle is inherited (all resources available). The runtime prints each agent's configuration during loading:

```
  Loading 3 agent roles from .vera/flows/agents/...
  ✓ analyzer: Security Inspector (model: claude-sonnet-4-20250514)
  ✓ coder: Code Implementer
  ✓ reviewer: Code Reviewer
```

---

## CLI Commands

### openvera run

```bash
openvera run                  # Auto-select when only 1 Flow exists
openvera run code-review      # Specify Flow name
openvera run --dir /path/to/project --model claude-sonnet-4-20250514
openvera run --max-steps 20 --skip-plan-critique
```

| Parameter | Description |
|---|---|
| `--dir` | Project root directory (defaults to current directory) |
| `--flow` | Flow name (auto-detects the unique Flow by default) |
| `--model` | Override global model |
| `--provider` | Override global LLM provider |
| `--api-key` | API Key (can also be configured via settings.json) |
| `--artifacts-dir` | Artifact output directory |
| `--max-steps` | Max execution step limit |
| `--skip-plan-critique` | Skip pre-execution Plan Critique evaluation |

When multiple Flows exist and no name is specified, an error is shown:
```
Multiple flows found: code-review, deploy. Specify one with openvera run <name>.
```

### Example Output

```
  Vera Harness — Flow Runner
  Flow:      code-review
  Plan:      3 steps — Review code changes on current branch
  Model:     claude-sonnet-4-20250514

  Critiquing plan...
  ✓ Plan critique passed  score=0.85

  [1/3] security-scan
  ✓   score=0.92
  [2/3] code-review
  ✓   score=0.78
  [3/3] test-verify
  ✓   score=0.88

  ✓ Flow completed — 3/3 steps
      ✓ security-scan
      ✓ code-review
      ✓ test-verify
```

---

## State Machine

Flow execution transitions through 11 states, with transitions strictly governed by the `VALID_TRANSITIONS` table in `flow-state.ts`.

### Full State Transition Table

| Current State | Meaning | Can Transition To |
|---|---|---|
| `intaking` | Entry: receiving input, parsing goal | `planning`, `completed` |
| `planning` | Planning: generating ExecutionPlan | `dispatching`, `failed` |
| `dispatching` | Dispatching: selecting next pending step | `executing`, `completed`, `waiting_approval`, `failed` |
| `executing` | Executing: agent running a step | `waiting_tool`, `waiting_approval`, `critiquing`, `failed` |
| `waiting_tool` | Waiting for tool: tool call in progress | `executing`, `failed` |
| `waiting_approval` | Waiting for approval: high-risk operation needs confirmation | `executing`, `dispatching`, `failed`, `paused` |
| `critiquing` | Evaluating: LLM assessing step results | `dispatching`, `replanning`, `waiting_approval`, `completed` |
| `replanning` | Replanning: deviated from goal, regenerating | `dispatching`, `failed` |
| `paused` | Paused: manual intervention in progress | `dispatching`, `executing`, `failed` |
| `completed` | **Terminal**: all successful | - |
| `failed` | **Terminal**: failed or unrecoverable | - |

### Normal Execution Path

```
intaking -> planning -> dispatching -> executing <-> waiting_tool
                                             |
                                         critiquing -> dispatching -> ... -> completed
```

### Critique Branches

```
critiquing -> replanning -> dispatching -> ...
critiquing -> waiting_approval -> (manual approval) -> dispatching
```

### State Query API

```typescript
import {
  canTransition,        // (from, to) => boolean
  assertTransition,     // (from, to) => void, throws on illegal transition
  transitionFlow,       // (flow, to) => TaskFlow, immutable update
  transitionFlowPath,   // (flow, path[]) => TaskFlow, chained transitions
  isTerminal,           // (state) => boolean
  isFlowDone,           // (flow) => boolean
  isFlowPausable,       // (flow) => boolean — executing or dispatching
  isFlowWaiting,        // (flow) => boolean — waiting_approval or paused
} from "@open-vera/harness";
```

---

## Plan Mode Integration

Flow execution is built on top of Plan Mode. The internal process of `openvera run`:

### 1. Parse -> 2. Generate Plan

`loadFlowDefinition()` loads the Flow file, and `flowDefinitionToPlan()` (`cli/plan.ts`) converts `FlowDefinition` to `ExecutionPlan`:
- Each Stage becomes a `PlanStep` (`type: "delegate"`)
- `stage` references are resolved to the stage template `body`, injected as step instructions
- `dependsOn` is directly mapped to step dependencies
- Agent assignment priority: Stage-level `agents` > stage template `agents` > default agent

### 3. Plan Critique

Unless `--skip-plan-critique` is specified, the runtime first evaluates the plan via LLM. If `confidence` is below 0.5, execution is aborted:

```
Critiquing plan...
✗ Plan critique: score=0.42 — Stage decomposition is unreasonable...
Plan score too low, aborting. Fix .../main.md and retry.
```

### 4. Dynamic Replanning

When Critique evaluation fails, replan is triggered: the `critiquing` state calls `replanWithCritique()` to regenerate the plan. The CLI output shows a change summary:

```
↻ replan  modified=[step-a]  added=[step-d]  removed=[]
```

### 5. Quick Entry Without Flow Files

```typescript
const handle = await runtime.planAndStart(
  "Review the security of the last 3 commits in src/",
  "quick-review-001"
);
// planAndStart internally calls planFromPrompt() to auto-generate ExecutionPlan
// then continues with the normal runFlowLoop
```

---

## Checkpoints and Recovery

### Storage Format

Checkpoint persistence directory: `<checkpointsDir>/<flowId>.checkpoints.jsonl`. Each line is a `FlowCheckpoint` JSON:

| Field | Description |
|---|---|
| `checkpointId` | Unique ID, format `cp-<timestamp36>-<random4>` |
| `flowId` | Owning Flow ID |
| `state` | Current HarnessState |
| `plan` | Full ExecutionPlan (including per-step status) |
| `activeStepId` | Currently active step |
| `loopCount` | Dispatching loop count |
| `budget` | Cumulative token / USD consumption |
| `artifacts` | List of produced artifacts |

### Automatic Save Triggers

The following points in `runFlowLoop()` trigger automatic saves (requires configured `checkpointsDir`):

1. Before each dispatching cycle begins
2. After step execution and Critique completion
3. After replan completion
4. When Flow reaches `completed` or `failed` (terminal checkpoint)

Uses append-only writes, crash-safe. Automatically compacts when exceeding thresholds (dedup, clean corrupt lines, trim by `compactToKeep`).

### Checkpoint Resume

```typescript
const handle = await runtime.resumeFromCheckpoint("my-flow-id");
// Rebuilds TaskFlow, restores plan/budget/loopCount
// skipCompleted defaults to true, auto-skips to next pending step
// failed state is reset to dispatching
// maxLoops auto-incremented by 3 to leave retry room
if (handle) {
  await runtime.runFlowLoop(handle, loopOptions);
}

// Specifying resume parameters
const handle = await runtime.resumeFromCheckpoint("my-flow-id", {
  fromStepId: "test-verify",
  skipCompleted: false,
});
```

### Fork (Branch Execution)

```typescript
const forked = await runtime.forkFromCheckpoint("source-flow-id", {
  newFlowId: "fix-safety-issues-001",
  newGoal: "Only fix high-severity issues found by security-scan",
  resetSteps: ["code-review", "test-verify"],  // Reset to pending
});
// Fork characteristics: new flowId, independent Checkpoint file, budget reset, loopCount restarted
if (forked) {
  await runtime.runFlowLoop(forked, loopOptions);
}
```

### Checkpoint Management API

```typescript
const store = runtime.getCheckpointStore();
if (store) {
  store.listFlows();              // List all Flows with checkpoints
  store.list("my-flow-id");       // List all checkpoint indices for a Flow
  store.count("my-flow-id");      // Count
  store.loadLatest("my-flow-id"); // Read latest checkpoint
  store.compact("my-flow-id");    // Dedup + trim
  store.clear("my-flow-id");      // Clear all checkpoints
}
```

---

## FAQ

**Multiple Flows require specifying a name.** When `flow/` contains multiple subdirectories, `openvera run` without a name will error listing all available Flows.

**Stage agents override rule.** Flow file Stage-level `agents` override the stage template's `agents`, allowing the same template to be executed by different agents in different Flows.

**Circular dependency detection.** Detected at runtime in `dispatchStep()`. If A depends on B and B depends on A, throws `"Circular dependency detected in plan steps: A → B → A"`.

**Checkpoints must be explicitly enabled.** Disabled by default. Requires passing `checkpointsDir` in `RuntimeOptions`:
```typescript
const runtime = new HarnessRuntime(adapter, model, {
  artifactsRootDir: "...",
  checkpointsDir: join(homedir(), ".vera", "checkpoints"),
});
```

**Flow directory does not exist.** CLI errors: `Error: No .vera/flows/ directory found. Create .vera/flows/flow/<name>/main.md to define a flow.`

---

## Related Source Code

| File | Responsibility |
|---|---|
| `packages/harness/src/flow-config/types.ts` | FlowDefinition / FlowStageRef / StageDefinition / FlowAgentDefinition types |
| `packages/harness/src/flow-config/parser.ts` | Markdown parsing: frontmatter, Stage references, stages/ agents/ directory loading |
| `packages/harness/src/runtime/flow-state.ts` | 11-state state machine: VALID_TRANSITIONS table, transition assertions, state queries |
| `packages/harness/src/runtime/flow.ts` | TaskFlow creation, Checkpoint construction, state updates, artifact attachment |
| `packages/harness/src/runtime/runtime.ts` | HarnessRuntime: dispatch loop, Critique/Replan, Checkpoint save/resume/Fork |
| `packages/harness/src/runtime/checkpoint-store.ts` | JSONL CheckpointStore: append writes, loadLatest, compact, dedup |
| `packages/harness/src/cli/flow-run.ts` | `openvera run` CLI command: load flow, event callbacks, result output |
| `packages/harness/src/cli/plan.ts` | `flowDefinitionToPlan()`: FlowDefinition -> ExecutionPlan |

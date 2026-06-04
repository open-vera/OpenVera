# Agent Design Patterns — Harness First, Self-Looping, Self-Critique, Self-Evolution

> Vera's goal is not to catch up with existing agents, but to build an agent runtime with Harness as its kernel — one that can self-plan, self-loop, self-critique, and self-evolve.

---

## 0. The Ultimate Capability Landscape

Terminology:

- `Flow`: A controlled execution instance of a complete task
- `Plan`: The structured execution scheme for a Flow
- `Step`: The smallest execution unit within a Plan
- `Critique`: Structured result criticism
- `Proposal`: Strategy improvement proposal
- `Checkpoint`: Key state snapshot

For precise definitions, see [harness.md](../harness/design.md#2-unified-terminology).

The concepts of infinite context, memory, dreaming, planning, and subagents in this document are only the core skeleton. Vera's goal is not merely to check off these features and become "close to a mature agent," but to redefine a stronger agent operating model: **a Harness-driven self-evolving system**.

### 0.1 Capability Layers

A usable general-purpose agent must cover at least the following 8 layers of capability:

| Layer | Capability | What it solves |
|---|---|---|
| **L1 Perception & Understanding** | Intent recognition, task classification, complexity assessment | Deciding whether to answer directly, ReAct, or Plan |
| **L2 Execution & Tools** | Files, shell, network, editor, browser, MCP | Enabling the agent to actually do things, not just talk |
| **L3 Context Management** | Sliding window, compression, retrieval recall | Solving context overflow in long tasks and large repositories |
| **L4 Memory System** | Session memory, long-term memory, user preferences | Solving continuity across turns and tasks |
| **L5 Planning & Collaboration** | Plan, Subagent, Critique | Solving complex task decomposition and concurrency |
| **L6 Harness Kernel** | Approval gates, permission boundaries, injection defense, runtime control | Enabling the agent to self-loop within boundaries instead of running out of control |
| **L7 Observability & Recovery** | Tracing, Checkpoint, Resume, Replay | Making long tasks traceable, interruptible, and recoverable |
| **L8 Self-Evolution** | Critique, benchmark, dreaming, Proposal Pipeline | Enabling continuous self-correction and evolution |

### 0.2 Our Goal Is to Surpass, Not Catch Up

If we only add "context, memory, tools, planning," the result is still just a more complete assistant. Vera aims to be a higher-level system:

> Harness is the kernel; agents are strategy bodies running on top of it.

The real essence is not how smart a particular model is, but whether the harness can simultaneously support these four capabilities:

- **Self-planning Flows**: Build a Plan first, advance by state, re-plan on deviation
- **Self-looping**: After one response completes, automatically enter the next execution round when necessary, instead of waiting for the user's next command
- **Self-critique**: The agent or a critic agent critiques current results, finds gaps, proposes corrections
- **Self-evolution**: Solidify failure patterns into memory / policy / benchmark cases, and convert them into Proposals

Mature systems share not "stronger models" but a closed loop. Vera aims to go further with a **self-driven closed loop**:

```
Understand the task
  -> Assess risk and scope
  -> Choose model / mode / tools / Flow
  -> Execute
  -> Self-check
  -> Observe results
  -> Recover from failure / re-plan
  -> Consolidate into memory
  -> Enter evaluation and strategy optimization
  -> Continue next round within boundaries
```

All subsequent Vera design must revolve around this self-looping, self-critiquing, self-evolving closed loop — not isolated feature stacking.

### 0.3 Currently Recommended Capability Checklist

#### P0: Must-have — without these, it is not the system we need

- Intent recognition and model routing
- Tool registry + basic tools: `read_file`, `write_file`, `bash`, `web_search`
- Infinite context management
- Plan Mode
- Harness: permissions, approval, scope boundaries, runtime control
- Trace / usage / tool call recording
- Basic benchmark harness
- Basic Critique loop

#### P1: Completing self-looping and self-correction capabilities

- Checkpoint / Resume: continue long tasks after interruption
- Tool retry, timeout, idempotency control
- Subagent concurrency and aggregation
- Episodic / Semantic Memory
- Prompt templating and versioning
- Failure attribution and auto-replay
- Critic agent
- Plan deviation detection

#### P2: Forming true self-evolution capability

- Dreaming: offline summarization and strategy optimization
- Computer Use / Browser Use
- MCP ecosystem integration
- Auto-generated test cases
- Adaptive prompt / tool policy optimization
- Proposal + gated Rollout
- Failure-to-benchmark auto-consolidation

### 0.4 What Vera Should Learn from the Hermes Architecture

Hermes' value goes beyond proposing "dreaming." It elevates the agent from a "single model call loop" into a "continuously running system with foreground, background, memory consolidation, and strategy evolution." This is what many current agent designs easily miss.

#### Essence 1: Separating the Foreground and Background Paths

Hermes-style systems don't do everything on the user request path. Instead, they split into two channels:

```
Foreground path (hot path)
User request -> Understand -> Execute -> Reply

Background path (cold path)
Event accumulation -> Summarization -> Memory consolidation -> Strategy update
```

This means:

- The user request path only does computation necessary for the current task, ensuring responsiveness
- Memory organization, failure attribution, and pattern discovery happen asynchronously in the background
- The agent is no longer "alive only when a request comes in," but a continuously running system

#### Essence 2: Event-Driven, Not Just Message-Driven

Ordinary agents often only have `messages[]`. Hermes-style design is more like a runtime: the system revolves around event streams.

```ts
type AgentEvent =
  | { type: "user_message"; sessionId: string; content: string }
  | { type: "tool_succeeded"; tool: string; metadata?: Record<string, unknown> }
  | { type: "tool_failed"; tool: string; error: string; retryable: boolean }
  | { type: "plan_created"; planId: string }
  | { type: "plan_step_completed"; planId: string; stepId: string }
  | { type: "session_completed"; sessionId: string }
  | { type: "dream_cycle_started"; batchId: string };
```

Benefits:

- Tracing, Checkpoint, dreaming, and benchmark all consume the same event stream
- Failure recovery does not depend on "guessing what happened last round"
- Background tasks can subscribe to events without intruding on the main loop

#### Essence 3: Memory Is Layered Consolidation, Not Log Archiving

Hermes-style dreaming is essentially memory consolidation:

```
Raw conversation / tool output
  ->
Session summary (episodic)
  ->
Cross-session knowledge (semantic)
  ->
Strategy-level adjustments (prompt / tool policy / workflow)
```

This is a level above "store everything." What truly matters is distilling experience into reusable structures, not accumulating indigestible logs.

#### Essence 4: Artifacts Are First-Class Citizens, Not Just Final Replies

In Hermes-style systems, what needs long-term retention is not just the assistant's final text, but also:

- plan
- step execution records
- tool results
- episodic summaries
- dream reports
- benchmark reports
- Proposals

These artifacts later enter recovery, replay, evaluation, and strategy optimization pipelines. Without an artifact system, dreaming and self-optimization cannot land.

#### Essence 5: Self-Evolution Must Go Through Human Review and Regression Validation

The correct Hermes direction is not "the agent automatically changes itself," but:

```
Discover patterns
  -> Generate improvement proposals
  -> Human review
  -> Small-scale rollout
  -> Benchmark / regression validation
```

That is, dreaming is a suggestion system, not a self-rewrite system. Vera should preserve this boundary to prevent the agent from directly modifying core strategies and losing control.

### 0.5 What Vera's Runtime Should Look Like

Absorbing Hermes' essence, Vera's overall runtime should be the following structure, not a single `runAgent()`:

```
                   +--------------------------+
User input / API ->| Foreground Runtime       |
                   | intent -> plan -> act    |
                   +------------+-------------+
                                | events
                   +--------------------------+
                   | Event Bus / Trace        |
                   +--------+--------+--------+
                            |        |
              +-----------------+  +----------------------+
              | Memory Worker   |  | Eval / Dreaming      |
              | summarize       |  | reflect / patch      |
              +-----------------+  +----------------------+
```

The foreground runtime only handles completing tasks; background workers handle consolidating experience. The two are decoupled through events and artifacts.

---

## 1. Infinite Context

### Problem

LLM context windows are finite (200K tokens). Long tasks, long conversations, and large files all cause overflow, leading to truncation or errors.

### Design Approach

Don't delegate "infinite" to the model. Instead, manage the context lifecycle at the agent layer:

```
Full history
  ->
[Working Context]   <- Within current window, visible to model
[Episodic Summary]  <- Compressed summary of overflow
[Long-term Store]   <- Vector retrieval, recalled on demand
```

### Strategy Layers

| Strategy | Trigger | What it does |
|---|---|---|
| **Sliding Window** | Tokens exceed 80% of threshold | Discard earliest turns, keep system + most recent N turns |
| **Progressive Compression** | Exceeds threshold | Use lightweight model to compress early conversation into summary, inject into system |
| **Segmented Storage** | Task complete | Write key session info into long-term memory |
| **On-Demand Recall** | New task starts | Retrieve relevant fragments from long-term storage, inject into context |

### Implementation Points

- **Compression summaries** must preserve: decision records, completed steps, important facts discovered
- **Do not compress**: raw data from tool calls and tool results (the model needs to correlate these)
- **Token counting** must happen before each API call, not after the API returns an error
- Anthropic's `compact` beta can serve as a server-side compression supplement, but should not be relied upon exclusively

---

## 2. Memory System

### Three-Layer Architecture

```
Working Memory       Conversation history, within current context window
      | compression
Episodic Memory      Session-level summary, this task's process
      | distillation
Semantic Memory      Cross-session persistent knowledge (user preferences, domain facts, past conclusions)
```

### Working Memory

This is `messages[]`, directly operated by the agent loop. Triggers compression when exceeding the window.

### Episodic Memory

After each task completes, have the model generate a structured summary:

```json
{
  "session_id": "xxx",
  "timestamp": "2026-04-11T10:00:00Z",
  "task": "Fix CSRF bug on login page",
  "outcome": "success",
  "key_findings": ["Token not bound to IP", "Middleware order incorrect"],
  "files_modified": ["src/middleware/csrf.ts"],
  "decisions": ["Chose double-submit cookie approach"]
}
```

### Semantic Memory

Long-term storage, two implementations:

| Implementation | Use Case | Characteristics |
|---|---|---|
| **File KV** (`.vera/memory/`) | Lightweight scenarios | Zero dependencies, human-readable, suitable for early stage |
| **Vector DB** (local sqlite-vec / remote Pinecone) | Large scale | Semantic retrieval, supports fuzzy matching |

Memory writes are driven by agent initiative (via `memory_write` tool), not automatic full storage, to avoid noise.

### Memory Recall

At the start of each new task, perform similarity search with the task description, inject top-k fragments into the system prompt:

```
You are working on: {task}

Relevant historical memories:
- {memory_1}
- {memory_2}
```

---

## 3. Dreaming System

### Conceptual Origin

In Hermes, "dreaming" refers to the agent's offline thinking and knowledge integration during idle time, analogous to memory consolidation during human sleep.

### Implementation in Vera

Dreaming is a **background async task** that runs when the main agent is not processing user requests:

```
Trigger conditions:
  - Explicit call to vera.dream()
  - Scheduled trigger (e.g., daily at midnight)
  - After a batch of tasks completes

What it does:
  1. Integrate Episodic Memory -> distill high-value knowledge into Semantic Memory
  2. Discover cross-session patterns ("user frequently asks about X type of problem")
  3. Self-evaluate: review failed cases, generate improvement suggestions
  4. Update prompt strategies (e.g., if a certain task type's system prompt performs poorly)
```

### Dream Report Output

```json
{
  "type": "dream_report",
  "insights": [
    "User tends to provide incomplete requirements — proactively clarify",
    "Bash tool failure rate 23%, consider adding retry logic"
  ],
  "memory_updates": [...],
  "suggested_prompt_patches": [...]
}
```

Dream reports are reviewed by humans before being applied to system configuration.

### Key Constraints on Hermes-Style Dreaming

To prevent dreaming from becoming "offline rambling," enforce 3 hard constraints:

- **Input must come from real artifacts**: session summaries, tool failures, benchmark failures, user feedback
- **Output must be structured**: memory updates, Proposals, workflow suggestions — not prose essays
- **Changes must be validated**: human review before entering benchmark / regression

This makes dreaming part of the engineering system, not a conceptual demo.

---

## 4. Plan Mode

### Differences from ReAct

| Mode | Characteristics | Use Case |
|---|---|---|
| **ReAct** (current) | Think while doing, continue immediately after each tool call | Exploratory tasks, uncertain steps |
| **Plan-then-Execute** | Generate full plan first, execute step-by-step after confirmation | Long tasks, destructive operations |
| **Plan + Reflect** | Compare against plan after execution, re-plan on deviation | High-precision tasks |

### Plan Mode Flow

```
User input
  ->
[Planning Phase] Generate structured execution plan (no tools called)
  ->
[Human confirmation or auto-approval]
  ->
[Execution Phase] Execute step-by-step per plan, record progress
  ->
[Reflection Phase] Compare plan vs. actual, generate retrospective
```

### Plan Format

```json
{
  "goal": "Fix login CSRF vulnerability",
  "steps": [
    { "id": 1, "action": "read_file", "target": "src/middleware/csrf.ts", "reason": "Understand existing implementation" },
    { "id": 2, "action": "analyze", "depends_on": [1], "reason": "Identify root cause" },
    { "id": 3, "action": "write_file", "depends_on": [2], "reason": "Apply fix" },
    { "id": 4, "action": "bash", "target": "npm test", "depends_on": [3], "reason": "Verify fix" }
  ],
  "risk": "low",
  "estimated_turns": 6
}
```

### When to Trigger Plan Mode

- Task complexity score > threshold (determined by intent recognition, see [intent-routing.md](./intent-routing.md))
- Involves destructive operations (delete, overwrite, deploy)
- User explicitly requests `--plan`

---

## 5. Subagent System

### Design Goals

The main agent (Orchestrator) handles task decomposition and result integration. Specialized agents (Workers) handle concrete execution. They communicate via a standard message protocol, mutually unaware of each other's internal implementation.

### Message Protocol

```ts
interface AgentTask {
  task_id: string;
  parent_agent_id: string;
  instruction: string;
  tools: string[];          // Whitelist of allowed tools
  context?: string;         // Necessary context fragments
  timeout_ms?: number;
}

interface AgentResult {
  task_id: string;
  status: "success" | "failure" | "partial";
  output: string;
  tool_calls: ToolCallRecord[];
  usage: Usage;
}
```

### Typical Patterns

**Parallel Fan-Out**: The main agent decomposes a large task into N independent subtasks, dispatched concurrently to N subagents:

```
Orchestrator
  +-- SubAgent A: Analyze frontend code
  +-- SubAgent B: Analyze backend code
  +-- SubAgent C: Query relevant documentation
         | (after all complete)
  Integrate results -> Final answer
```

**Serial Pipeline**: The output of one subagent becomes the input of the next:

```
Researcher -> Analyzer -> Writer -> Reviewer
```

**Recursive Subagent**: When a subagent finds its subtask is still too large, it can further decompose (with a recursion depth limit).

### Implementation Points

- Subagents are independent `runAgent` calls, sharing the adapter but each with independent message history
- The Orchestrator passes only necessary context fragments, not full history (to control token usage)
- Set a global `maxDepth` to prevent infinite recursion
- Subagent token consumption is included in the parent task's usage summary

### When to Use Subagents

**Should use subagents when:**
- Multi-file/module analysis (parallel fan-out)
- Code review (security/performance/quality can be checked in parallel)
- Research + writing (serial pipeline)
- Exploratory tasks (avoid polluting the main context)
- Large task decomposition (exceeds single context window)

**Should NOT use subagents when:**
- Single file read/edit (single-step, no parallel value)
- Simple command execution (no context isolation needed)
- Tasks highly dependent on main session (context transfer cost too high)
- Small tasks with ample token budget (excessive decomposition adds overhead)

---

## 6. Tool and Environment Interaction Capabilities

Without a solid tool system, an agent is just a talking assistant, not a task-executing worker. The core competitiveness of products like Codex and Claude is fundamentally built on "stable tool execution."

### Required Basic Tool Layer

| Category | Minimum Capability | Notes |
|---|---|---|
| **File Tools** | `read_file`, `write_file`, `edit_file`, `list_dir`, `glob` | `edit_file` is safer than full-file overwrite |
| **Search Tools** | `grep_text`, `code_search` | Structured search is essential in large repositories |
| **Command Tools** | `bash` | Needs timeout, cwd, env, stdout/stderr capture |
| **Network Tools** | `web_search`, `fetch_url` | Needs domain whitelist and content sanitization |
| **Memory Tools** | `memory_write`, `memory_search` | Should not directly expose underlying storage details |
| **Collaboration Tools** | `delegate_task`, `wait_task` | Unified interface for subagents |

### Required Execution Semantics

```ts
interface ToolExecutionOptions {
  timeoutMs?: number;
  retries?: number;
  cwd?: string;
  env?: Record<string, string>;
  idempotencyKey?: string;
  dryRun?: boolean;
}
```

Must support:

- **Timeout control**: Prevent shell/network calls from hanging
- **Retry strategy**: Distinguish retryable vs. non-retryable errors
- **Structured errors**: Don't just return string errors
- **Idempotency keys**: Avoid re-executing high-cost or high-risk actions
- **Standardized output**: Tool results must be stably consumable by models

### Recommended Tool Result Format

```ts
interface ToolResult {
  ok: boolean;
  content: string;
  metadata?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}
```

---

## 7. Harness and Security Boundaries

The stronger the agent, the more it needs a shell. Without a harness, an agent in a real environment will eventually cause privilege escalation, accidental deletion, erroneous execution, and prompt injection.

For detailed design, see [harness.md](../harness/design.md). Here we emphasize its position in the overall capability landscape: **Harness is not an auxiliary module, but the first layer of the agent runtime.**

### What the Harness Must Handle

- Tool whitelist and parameter validation
- Working directory / domain / budget scope constraints
- High-risk operation approval gates
- Prompt injection defense
- Audit logging
- Subagent permission inheritance

### What a Mature Agent Must Achieve

- Can explain "why something cannot be done"
- Can stop when exceeding authorization
- Can treat external content as data, not instructions
- Can explicitly escalate high-risk operations to human decision

---

## 8. Observability, Recovery, and Long-Running Tasks

This is the most visibly missing area in current documentation. Once entering production or daily high-frequency use, the problems are often not "can it do it" but "what if it crashes halfway," "why did it fail just now," "can it continue running."

### 8.1 Required Runtime Observability

Each turn should at minimum record:

```json
{
  "session_id": "sess_xxx",
  "turn": 4,
  "model": "claude-sonnet-4-6",
  "tokens_in": 3200,
  "tokens_out": 740,
  "latency_ms": 1840,
  "tool_calls": ["read_file", "bash"],
  "plan_step": 3,
  "status": "ok"
}
```

### 8.2 Required Recovery Capabilities

| Capability | Purpose |
|---|---|
| **checkpoint** | Save agent state after key steps |
| **resume** | Resume execution after process exit or API-side hang |
| **replay** | Replay a task to reproduce the failure chain |
| **fork** | Branch from a checkpoint to try different strategies |

### 8.3 Recommended State to Save

- Current messages / summaries
- Current Plan and Step state
- Executed tool call records
- Current budget consumption
- Subagent tree structure
- Most recent user approval result

Without these capabilities, long tasks can only "start over from scratch" — a huge experience gap from mature agents.

---

## 9. Evaluation, Regression, and Continuous Evolution

Learn from Codex / Claude / OpenClaw not just capability design, but also their underlying evaluation and evolution mechanisms.

### 9.1 Evaluation Must Cover Three Categories

| Category | Example | What it measures |
|---|---|---|
| **Result Correctness** | Was the task completed | pass rate |
| **Process Correctness** | Were tools chosen/used correctly | tool accuracy |
| **System Stability** | Is it consistent across multiple runs | variance / flaky rate |

### 9.2 Required Case Types

- Pure Q&A cases: validate routing and direct answers
- Single-tool cases: validate parameter generation
- Multi-step code cases: validate read/edit/test closed loop
- High-risk cases: validate harness correctly intercepts
- Long-task cases: validate compression, checkpoint, resume

### 9.3 Dreaming's True Position

Dreaming is not a "cool add-on feature" but part of the evaluation closed loop:

```
Production task / benchmark failure
  -> Aggregate failure cases
  -> Distill patterns
  -> Generate prompt / tool policy improvement suggestions
  -> Human review
  -> Regression evaluation to verify improvement
```

If dreaming is not connected to benchmark and regression, it is just a summary report with limited value.

---

## 10. Conclusion for Vera

At this stage, we should not define our goal as "building a few advanced-looking agent features," but rather:

> Build a general-purpose agent runtime with execution closed loop, permission boundaries, recoverability, and continuous evaluation capability.

In other words, future Vera must simultaneously possess:

- **Can do**: tools, execution, editing, search
- **Can think**: planning, reflection, subtask decomposition
- **Can remember**: context management, long-term memory
- **Stays within bounds**: harness, security, approval
- **Is traceable**: trace, checkpoint, resume
- **Can evolve**: benchmark, dreaming, regression optimization

These 6 categories of capability must all hold together to truly approach Codex / Claude-level agent systems.

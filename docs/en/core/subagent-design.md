# Subagent System Design

> Subagents are Vera's parallel execution and task isolation mechanism, uniformly scheduled by an Orchestrator with Workers executing independently, communicating via a standard message protocol.

---

## 1. Core Concepts

### 1.1 What Is a Subagent

A subagent is an independent execution unit created by the main agent (Orchestrator), used for:

- **Parallel processing** of mutually independent subtasks
- **Context isolation** to prevent exploratory tasks from polluting the main session
- **Specialized execution** by domain-specific Workers

### 1.2 Design Principles

| Principle | Description |
|---|---|
| **Minimal context passing** | Pass only necessary context fragments, not the full history |
| **Tool whitelist** | Subagents can only use a subset of tools authorized by the parent agent |
| **Independent lifecycle** | Each subagent is an independent `runAgent` call |
| **Result aggregation** | Workers return structured results; the Orchestrator handles integration |
| **Permission inheritance** | Subagents inherit the parent agent's harness constraints; they cannot exceed authority |
| **Optional workspace isolation** | Code-writing experiments can use `isolation: "try"` to execute in an independent git worktree |

---

## 2. When to Use Subagents

### 2.1 Decision Matrix

```
Receive task
  |
  Can the task be decomposed into independent subtasks? --No--> Execute directly
  | Yes
  Are the subtasks interdependent? --Yes--> Serial pipeline mode
  | No
  Is context isolation needed? --Yes--> Create Subagent
  | No
  Is the token budget sufficient? --Yes--> Execute directly (avoid over-decomposition)
  | No
  Create Subagent
```

### 2.2 Typical Use Cases

**Should use subagents:**

| Scenario | Pattern | Reason |
|---|---|---|
| **Multi-file/module analysis** | Parallel fan-out | Modules are independent, can run concurrently |
| **Code review** | Parallel fan-out | Security/performance/quality can be checked in parallel |
| **Research + writing** | Serial pipeline | Collect information first, then integrate output |
| **Exploratory tasks** | Single subagent | Avoid polluting the main context |
| **Large task decomposition** | Recursive subagent | Exceeds single context window |

**Should NOT use subagents:**

| Scenario | Reason |
|---|---|
| Single file read/edit | Single-step, no parallel value |
| Simple command execution | No context isolation needed |
| Tasks highly dependent on main session | Context transfer cost too high |
| Small tasks with ample token budget | Excessive decomposition adds overhead |

---

## 3. Communication Protocol

### 3.1 Message Types

```typescript
type AgentMessage =
  | { type: 'task'; payload: AgentTask }
  | { type: 'result'; payload: AgentResult }
  | { type: 'progress'; payload: ProgressUpdate }
  | { type: 'error'; payload: AgentError }
  | { type: 'request_context'; payload: ContextRequest }
  | { type: 'context_response'; payload: ContextData };
```

### 3.2 Task Dispatch Protocol

```typescript
interface AgentTask {
  task_id: string;
  parent_agent_id: string;
  instruction: string;
  tools: string[];                    // Whitelist of allowed tools
  context?: string;                   // Necessary context fragments (not full history)
  sharedContextKeys?: string[];       // Shared context key list
  timeout_ms?: number;
  maxDepth?: number;                  // Max recursion depth (prevents infinite decomposition)
  expectedOutputFormat?: 'text' | 'json' | 'structured';
  isolation?: 'none' | 'try';        // Execution isolation mode
}
```

### 3.3 Result Protocol

```typescript
interface AgentResult {
  task_id: string;
  status: 'success' | 'failure' | 'partial' | 'timeout';
  output: string;
  structuredOutput?: Record<string, unknown>;
  tool_calls: ToolCallRecord[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  duration_ms: number;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  metadata?: {
    model: string;
    turns: number;
    checkpoint_id?: string;
  };
}
```

---

## 4. Context Sharing Mechanism

### 4.1 Context Layering

```
+-------------------------------------------+
|        Shared Context Layer                |  <- Shared by all agents
|  (project structure, user preferences,     |
|   global knowledge)                        |
+-------------------+-----------------------+
                    |
+-------------------------------------------+
|     Parent Context (Orchestrator)          |  <- Parent agent private
|  (full session history, planning,          |
|   decision records)                        |
+-------------------+-----------------------+
                    |
+-------------------------------------------+
|     Worker Context (Subagent)             |  <- Child agent private
|  (task instruction, necessary context      |
|   fragments)                               |
+-------------------------------------------+
```

### 4.2 Context Passing Strategies

#### Strategy 1: Minimal Necessary Context

```typescript
interface ContextSnapshot {
  workspaceRoot: string;
  relevantFiles: string[];
  keyDecisions: string[];
  currentGoal: string;
  constraints: {
    maxTokens: number;
    allowedTools: string[];
    timeLimit?: number;
  };
}
```

#### Strategy 2: Shared Context Layer

A `SharedContextManager` provides key-value based context sharing with subscription notifications. Subagents can read and subscribe to context changes without receiving the full history.

### 4.3 Context Compression Rules

Context passed to subagents must be compressed:

1. Preserve the system prompt
2. Extract file/code snippets relevant to the task
3. Keep key decision points
4. Remove redundant conversation
5. Generate a task-relevant summary
6. Stay within the token budget (default 8K tokens)

---

## 5. Scheduler Implementation

### 5.1 Orchestrator Core

The `AgentOrchestrator` manages:

- **Active agents map**: Tracks all running subagents
- **Message queue**: Priority queue for inter-agent messages
- **Shared context**: `SharedContextManager` instance
- **Results collection**: Aggregated results from all subagents

Key methods:
- `spawnAgent(config)` — Creates and starts a subagent
- `parallelFanOut(tasks)` — Concurrent execution of independent tasks
- `serialPipeline(steps)` — Sequential execution with output flowing between steps
- `aggregateResults(taskIds)` — Combines results with total usage and timing

### 5.2 Agent Handle

Each subagent is wrapped in an `AgentHandle` that provides:
- `start()` — Begins execution via `runAgent`
- `waitForResult()` — Returns a promise that resolves when the subagent completes
- `cancel()` — Sends a cancellation signal

---

## 6. Typical Patterns

### 6.1 Parallel Fan-Out

**Use case**: Multiple independent subtasks that can execute concurrently.

```
                    +-- SubAgent A: Analyze frontend
Orchestrator -------+-- SubAgent B: Analyze backend
                    +-- SubAgent C: Query documentation
                         | (after all complete)
                    Integrate results -> Final answer
```

### 6.2 Serial Pipeline

**Use case**: Steps with dependencies that must execute in order.

```
Researcher -> Analyzer -> Writer -> Reviewer
   |            |          |         |
  Collect     Analyze    Generate   Quality
  information data       report     check
```

### 6.3 Recursive Subagent

**Use case**: A subtask is too large and needs further decomposition.

```
Orchestrator (depth=0)
  +-- SubAgent A (depth=1)
       +-- SubAgent A1 (depth=2)
            +-- SubAgent A1a (depth=3, limit reached)
```

**Constraints**:
- Set `maxDepth` to prevent infinite recursion (recommended 3-5)
- Each recursion decreases the depth counter
- When the depth limit is reached, the subagent must execute directly

### 6.4 Isolated Exploration Mode

**Use case**: Exploratory tasks that should not pollute the main context.

```typescript
const exploration = await orchestrator.spawnAgent({
  id: 'explore-alternative',
  instruction: 'Explore feasibility of using Redux to replace current state management',
  tools: ['read_file', 'grep_text', 'web_search'],
  context: {
    currentGoal: 'Evaluate state management migration',
    relevantFiles: ['src/store/index.ts', 'src/store/types.ts'],
    keyDecisions: ['Current approach has performance bottlenecks'],
  },
});
// Exploration results don't affect the main session; Orchestrator can selectively adopt
```

---

## 7. Error Handling and Recovery

### 7.1 Error Classification

```typescript
enum SubagentErrorType {
  TRANSIENT = 'transient',       // Retryable: network timeout, API rate limit
  FATAL = 'fatal',                // Non-retryable: invalid params, insufficient permissions
  TIMEOUT = 'timeout',            // Execution exceeded timeout_ms
  DEPTH_LIMIT = 'depth_limit',   // Recursion depth limit reached
  BUDGET_EXHAUSTED = 'budget_exhausted', // Token budget exhausted
}
```

### 7.2 Retry Strategy

- Default: up to 2 retries with exponential backoff (1s, 2s, 4s)
- Only retry on `TRANSIENT` and `TIMEOUT` errors
- Non-retryable errors return immediately

### 7.3 Partial Failure Handling

When some subagents fail in a parallel task:

- Proceed if at least 50% of subagents succeed
- Report both successful and failed results to the Orchestrator
- The Orchestrator decides whether to retry failed tasks or proceed with partial results

---

## 8. Token Budget Management

### 8.1 Budget Allocation Strategy

- Orchestrator reserves ~25% of the total budget
- Remaining budget is evenly divided among estimated subagents
- Per-agent budgets are enforced at execution time

### 8.2 Usage Aggregation

Total usage is aggregated across all subagents:
- Total prompt tokens, completion tokens, and total tokens
- Total cost calculation
- Per-agent breakdown for observability

---

## 9. Harness Integration

### 9.1 Permission Inheritance

Subagents inherit the parent agent's harness constraints:

```typescript
interface InheritedPermissions {
  allowedTools: string[];          // Tool whitelist (subset)
  allowedDirectories: string[];   // Working directory restrictions
  allowedDomains?: string[];      // Network domain whitelist
  maxTokens: number;              // Maximum token budget
  timeoutMs?: number;
  requireApprovalFor: string[];   // High-risk operations requiring approval
}
```

### 9.2 Audit Logging

Every subagent execution produces an audit log entry containing:
- Timestamps, parent agent ID, subagent ID
- Task description and status
- Tokens used, duration, tools used
- Risk level and approval status

---

## 10. Implementation Checklist

### P1 Phase (Current)

- [x] `agent` tool basic protocol: `description` / `prompt` / `subagent_type` / `allowedTools` / `maxTurns`
- [x] Sidechain sessions: child agent transcripts recorded independently, parent receives only summary
- [x] Custom agent definitions: user-level and project-level `.vera/agents/*.md`
- [x] Tool strategies: built-in `general-purpose` / `explore` / `plan`, with readonly and allow/disallow tools
- [x] Try worktree isolation: `isolation: "try"` creates independent worktree, tools execute in worktree cwd
- [x] Adoption path: try-isolated subagent records branch metadata, can apply back via `/merge <id-prefix>`
- [ ] Full `AgentTask` / `AgentResult` message protocol definition
- [ ] Basic `AgentOrchestrator` implementation
- [ ] Parallel fan-out (`parallelFanOut`)
- [ ] Serial pipeline (`serialPipeline`)
- [ ] Minimal necessary context passing
- [ ] Basic error handling and retry
- [ ] Token budget tracking

### P2 Phase

- [ ] Shared context manager (`SharedContextManager`)
- [ ] Context compression and summarization
- [ ] Recursive subagent support
- [ ] Real-time progress updates
- [ ] Partial failure recovery strategies
- [ ] Audit log integration

### P3 Phase

- [ ] Adaptive budget allocation
- [ ] Subagent performance monitoring
- [ ] Dynamic scheduling strategy optimization
- [ ] Automatic failure pattern learning
- [ ] Visual subagent tree

---

## 11. Best Practices

**DO:**

| Practice | Reason |
|---|---|
| Pass minimal necessary context | Control token consumption |
| Set reasonable `maxDepth` | Prevent infinite recursion |
| Use tool whitelists | Minimize permissions |
| Parallelize independent tasks | Increase throughput |
| Fast-fail on errors | Avoid wasting time |

**DON'T:**

| Practice | Reason |
|---|---|
| Pass full conversation history | Token waste |
| Create excessively deep recursion | Complexity explosion |
| Grant full tool access to subagents | Security risk |
| Ignore error handling | Hard to debug |
| Over-decompose small tasks | Adds overhead |

---

## 12. Comparison with Related Systems

| System | Subagent Support | Characteristics |
|---|---|---|
| **Claude Code** | Yes (Subagent) | Parallel file analysis, independent context |
| **Codex** | Yes (Sandbox) | Isolated execution environment |
| **LangChain** | Yes (Agent Executor) | Flexible but requires manual orchestration |
| **AutoGen** | Yes (Multi-Agent) | Conversation-based multi-agent |
| **Vera** | Yes (Subagent + SharedContext) | Shared context layer + Harness integration |

Vera's differentiating advantages:
1. **Shared context layer**: Syncs key-value pairs on demand instead of passing full history
2. **Harness integration**: Permission inheritance, audit logging, approval gates
3. **Budget management**: Automatic token budget allocation and tracking
4. **Standardized protocol**: Seamless integration with intent-routing and plan mode

---

## See Also

- [agent-design.md](./agent-design.md) — Agent capability landscape overview
- [intent-routing.md](./intent-routing.md) — Intent recognition and model routing
- [runtime-design.md](./runtime-design.md) — Core runtime design
- [harness/design.md](../harness/design.md) — Harness kernel design

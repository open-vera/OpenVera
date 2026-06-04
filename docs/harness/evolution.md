# Self-Evolution Pipeline

The self-evolution pipeline is Vera's P2 core capability. The goal is not "do more testing" but to give Vera a genuine controlled evolution mechanism. The entire pipeline starts from experience distillation, goes through proposal generation, human review, and benchmark-gated rollout, ultimately forming a closed-loop self-improvement system.

---

## 1. Overall Architecture

```
Experience data (Episodic Memory / Failure logs)
        |
        v
  DreamingRunner          <- Analyze experience, extract Insights, generate Proposals
        |
        v
  ProposalStore           <- Persistent storage, lifecycle management
        |
        v
  Human Review            <- pending -> approved / rejected / deferred
        |
        v
  Benchmark-gated Rollout <- Verify improvement effectiveness via EvalHarness
        |
        +-- Pass -> applied  -> Update StrategyStore
        +-- Fail -> rejected -> Write back failure reason, trigger next Dreaming cycle
```

Complete pipeline: **Critique / Dreaming -> Proposal -> Human Review -> Benchmark Gate -> Strategic Rollout -> Feedback Loop**

---

## 2. Dreaming System

Dreaming is the entry point of the self-evolution pipeline -- it runs when agents are idle, analyzing historical experiences (episodic memory, benchmark failure records) to extract actionable improvement suggestions.

**Code location:** `packages/harness/src/dreaming/runner.ts`

### 2.1 DreamingRunner

`DreamingRunner` is the core class for dreaming. It receives a list of experiences and produces Insights and Proposals.

```typescript
const runner = new DreamingRunner({
  maxExperiences: 100,   // Max 100 experiences per analysis
  minConfidence: 0.5,    // Minimum confidence threshold
  maxProposals: 10,      // Max 10 proposals generated
  proposalTypes: ["prompt", "tool_policy", "workflow", "skill"],
});

const result = await runner.dream(experiences);
// result: { insights, proposals, experiencesAnalyzed, duration }
```

### 2.2 Experience Model

```typescript
interface Experience {
  id: string;
  type: "success" | "failure" | "partial";  // Execution result
  taskDescription: string;
  toolCalls: string[];                        // List of tools used
  duration: number;                           // Execution duration (ms)
  outcome: string;                            // Result description
  metadata?: Record<string, unknown>;
}
```

### 2.3 Insight Extraction

`extractInsights()` performs four types of analysis:

| Analysis Type | Method | Produced Insight Category |
|----------|------|-------------------|
| Successful tool combinations | `findToolPatterns(experiences, "success")` | `pattern` |
| Failed tool combinations | `findToolPatterns(experiences, "failure")` | `anti_pattern` |
| Slow task identification | `findSlowTasks(experiences)` | `optimization` |
| Capability gaps | `findGaps(experiences)` | `gap` |

**Tool combination analysis:** Sort each experience's tool calls and concatenate them into a composite key (e.g. `"bash+read_file+write_file"`), then count occurrences of the same combination in successful/failed experiences. An insight is generated only if at least 2 occurrences are found. Confidence formula: `min(0.9, count / 10 + 0.3)`.

**Slow task identification:** Calculate the average duration of all experiences; tasks exceeding 2x the average are marked as "slow tasks." Confidence is fixed at 0.7.

**Capability gap identification:** Filter all failed experiences and group by tool combination. Combinations with at least 2 repeated failures are considered to represent capability gaps. Confidence formula: `min(0.85, count / 5 + 0.4)`.

### 2.4 Proposal Generation

`generateProposals()` maps each filtered Insight (confidence >= `minConfidence`) to an `ImprovementProposal`:

| Insight Category | Proposal Type | Priority | Suggested Change Direction |
|-------------|--------------|--------|-------------|
| `pattern` (successful pattern) | `workflow` | medium | Create a skill or workflow template combining these tools |
| `anti_pattern` (anti-pattern) | `tool_policy` | high | Add warning or alternative strategy when this tool combination is encountered |
| `optimization` (optimization) | `prompt` | low | Add time awareness to prompt or implement early termination |
| `gap` (gap) | `skill` | critical | Develop a new skill or tool to handle this type of task |

### 2.5 Proposal Data Structure

```typescript
interface ImprovementProposal {
  id: string;
  type: "prompt" | "tool_policy" | "workflow" | "skill";
  priority: "low" | "medium" | "high" | "critical";
  status: "pending" | "approved" | "rejected" | "deferred" | "applied";
  title: string;
  description: string;
  rationale: string;            // Why make this change
  insights: string[];           // Associated insight IDs
  suggestedChange: string;      // Specific change suggestion
  expectedImpact: string;       // Expected effect
  createdAt: string;
}
```

---

## 3. Proposal Store

Proposal storage provides persistent support for stateful lifecycle management.

**Code location:** `packages/harness/src/proposal/store.ts`

### 3.1 Core Features

| Method | Function |
|------|------|
| `add(proposal)` | Add proposal (deduplicate by ID) |
| `addAll(proposals)` | Batch add |
| `updateStatus(id, status)` | Update proposal status |
| `list(filter?)` | Filter list by status/type/priority/time |
| `getReadyForRollout()` | Get all approved proposals awaiting rollout |
| `getApplied()` | Get all applied proposals (for validation/rollback) |
| `countByStatus()` | Count by status |
| `remove(id)` | Remove specific proposal |

### 3.2 Lifecycle

```
pending -> approved -> applied -> verified (future)
   |         |
   v         v
rejected  deferred
```

- **pending**: Initial state produced by DreamingRunner or manually created
- **approved**: Passed human review, awaiting rollout
- **rejected**: Rejected by human (includes rejection reason)
- **deferred**: Temporarily shelved, re-evaluate later
- **applied**: Deployed to production

### 3.3 Persistence

Data is stored as a JSON array at a specified path, auto-saved on every change. Supports idempotent addition (same ID does not insert duplicate).

---

## 4. Strategy Store

The Strategy Store is the accumulation layer for institutional knowledge. Every verified improvement is solidified as a Strategy, organized by task domain, with ongoing execution effect tracking.

**Code location:** `packages/harness/src/strategy/strategy-store.ts` and `types.ts`

### 4.1 Strategy Data Structure

```typescript
interface Strategy {
  id: string;
  name: string;
  domain: StrategyDomain;       // Applicable task domain
  status: "active" | "deprecated" | "candidate" | "retired";
  version: number;              // Version number, increments on each update
  prompt: PromptTemplate;       // Prompt template (with variable substitution)
  model: ModelConfig;           // Model configuration
  toolPolicy: ToolPolicy;       // Tool policy (allow/deny/constraints)
  createdAt: string;
  updatedAt: string;
  tags?: string[];
}
```

### 4.2 Task Domains (StrategyDomain)

```
coding | debugging | research | writing | data-analysis | planning | review | testing | devops | general
```

### 4.3 Execution Result Tracking

Each time a strategy is used, a `StrategyOutcome` is recorded:

```typescript
interface StrategyOutcome {
  strategyId: string;
  success: boolean;
  durationMs: number;
  tokenUsage?: { input: number; output: number };
  error?: string;
  timestamp: string;
}
```

### 4.4 Auto-Tuning (autoTune)

`autoTune(promoteThreshold, deprecateThreshold, minRuns)` automatically adjusts strategy status based on historical success rate:

- **Candidate -> Active**: Success rate >= `promoteThreshold` (default 0.7) and run count >= `minRuns` (default 5)
- **Active -> Deprecated**: Success rate < `deprecateThreshold` (default 0.3) and run count >= `minRuns`
- **Deprecated/Retired**: No automatic changes (manual operation only)

### 4.5 Statistics and Comparison

| Method | Function |
|------|------|
| `getStats(strategyId)` | Get aggregated strategy stats (success rate, avg duration, token usage) |
| `compare(idA, idB)` | Compare two strategies, return winner and confidence |
| `getBestForDomain(domain, minRuns)` | Get the best strategy for a domain (sorted by success rate) |
| `getDomainSummary(domain)` | Domain-level summary: strategy count, total runs, overall success rate |

### 4.6 Trend Detection

`getTrend(strategyId, recentWindow, olderWindow)` compares success rate changes between two time windows:

| Trend Direction | Judgment Condition |
|----------|----------|
| `improving` | Recent success rate - historical success rate > 5% |
| `declining` | Recent success rate - historical success rate < -5% |
| `stable` | Difference within +/- 5% |
| `insufficient_data` | Both windows have run counts below `minRunsForTrend` (default 3) |

### 4.7 Time Window Statistics

Supports predefined windows (`1h` / `6h` / `24h` / `7d` / `30d`) and custom millisecond windows, filtering outcomes by time and recalculating statistics.

---

## 5. Change Store

The change tracking system stores agent tool call records in JSONL format by day, supporting queries, filtering, and archiving.

**Code location:** `packages/harness/src/tracking/change-store.ts`

### 5.1 Data Structure

```typescript
interface ChangeRecord {
  timestamp: string;
  agentId: string;
  toolName: string;
  args: string;
  success: boolean;
  filesChanged: string[];
  summary: string;
  resultPreview?: string;
  error?: string;
}
```

### 5.2 Storage Format

One JSONL file per day: `~/.vera/changes/YYYY-MM-DD.jsonl`, each line is a complete ChangeRecord JSON.

### 5.3 Query Capabilities

`query(options)` supports filtering by time range, agent ID, tool name, and file path, with a configurable result limit (default 100).

### 5.4 Archiving

`archive()` moves log files older than `retentionDays` (default 30 days) to the `archive/` subdirectory and removes the original files from the main directory.

---

## 6. Eval Harness Integration

The evaluation framework (Eval Harness) is the "gatekeeper" of the evolution pipeline -- any Proposal must pass benchmark verification before going live.

**Code location:** `packages/harness/src/eval/harness.ts`

### 6.1 Core Components

```typescript
class EvalHarness {
  constructor(agent: AgentExecutor, options: EvalRunnerOptions);
  loadCases(cases: EvalCase[]): void;
  runAll(): Promise<EvalReport>;
  runCase(evalCase: EvalCase): Promise<EvalResult>;
}
```

### 6.2 Evaluation Types

| evalType | Judgment Logic | Applicable Scenarios |
|----------|----------|----------|
| `exact` | Response exactly matches expected (case-insensitive) | Q&A with exact answers |
| `contains` | Expected text appears in response | Key information extraction |
| `regex` | Response matches regular expression | Format validation |
| `tool_match` | Actually called tools match expected tool set | Tool selection correctness |
| `llm_judge` | Reserved interface (currently returns 0.5) | Subjective quality assessment |

### 6.3 Evaluation Cases

```typescript
interface EvalCase {
  id: string;
  description: string;
  level: 1 | 2 | 3;           // Difficulty level
  prompt: string;              // Prompt sent to agent
  expected?: string;           // Expected answer
  evalType: EvalType;
  expectedTools?: string[];    // Expected tools for tool_match type
  tags?: string[];             // Classification tags
  timeoutMs?: number;          // Timeout (default 60000ms)
  maxCostUsd?: number;         // Cost cap (default $1.0)
}
```

### 6.4 Evaluation Report

```typescript
interface EvalReport {
  benchmark: string;
  model: string;
  passRate: number;            // Pass rate
  avgScore: number;            // Average score
  avgDurationMs: number;       // Average duration
  totalCostUsd: number;        // Total cost
  byLevel: Record<number, { total, passed, passRate }>;
  results: EvalResult[];       // Per-case results
}
```

### 6.5 Role in Self-Evolution

1. Proposal generated -> Human review approved
2. -> Run full benchmark in EvalHarness
3. -> Compare against baseline (current strategy) score
4. -> Positive improvement -> Mark applied, update StrategyStore
5. -> No improvement or regression -> Mark rejected, write back failure reason

---

## 7. Configuration

### 7.1 DreamingRunner

```typescript
interface DreamingConfig {
  maxExperiences?: number;    // Default 100
  minConfidence?: number;     // Default 0.5
  maxProposals?: number;      // Default 10
  proposalTypes?: ProposalType[];  // Default all
}
```

### 7.2 ChangeStore

```typescript
interface ChangeStoreOptions {
  storeDir?: string;          // Default ~/.vera/changes
  retentionDays?: number;     // Default 30
}
```

### 7.3 EvalHarness

```typescript
interface EvalRunnerOptions {
  name: string;               // Benchmark name
  casesPath?: string;         // Test case JSON file path
  concurrency?: number;       // Concurrency (default 1)
  timeoutMs?: number;         // Global timeout (default 60000)
  model?: string;             // Model/agent name
}
```

---

## 8. Current Status

The self-evolution pipeline belongs to **P2 stage** ("Establish self-evolution closed loop" in the roadmap):

| Component | Status | Description |
|------|------|------|
| `DreamingRunner` | Implemented | Rule-driven experience analysis, four Insight types, Proposal mapping |
| `ProposalStore` | Implemented | Persistent storage, lifecycle management, filtered queries |
| `StrategyStore` | Implemented | Strategy CRUD, success rate tracking, auto-tuning, trend detection, domain summaries |
| `ChangeStore` | Implemented | JSONL daily storage, time/agent/tool/file filtering, archiving |
| `EvalHarness` | Implemented | 5 evaluation types, report generation, AgentExecutor interface decoupling |
| LLM-driven Dreaming | Not yet | Current Dreaming is rule-driven; future should use LLM for deeper experience analysis |
| Full closed-loop automation | Not yet | Proposal -> Review -> Benchmark -> Rollout pipeline currently requires manual triggering, not yet fully automated |
| Production feedback loop | Not yet | Real task failures auto-entering benchmark pool, human confirmation for solidification |

---

## 9. Key Design Decisions

1. **Dreaming placed in Harness layer**: Because Dreaming depends on episodic memory and benchmark results, which are Harness-layer concepts. The Core layer is not aware of experience "success/failure."
2. **Strategy separated from Proposal**: Proposal is "what to improve," Strategy is "validated and solidified best practice." They are different lifecycle stages.
3. **EvalHarness decoupled via AgentExecutor interface**: Does not directly depend on Core's agent loop; can connect to any agent implementation.
4. **Change tracking uses JSONL**: Append-only writes, crash-safe, daily sharding for easy archiving and parallel querying.
5. **Auto-tuning has minimum sample protection**: `minRuns` parameter (default 5) prevents false judgments in small-sample scenarios.

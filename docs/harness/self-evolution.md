# Self-Evolution Pipeline

The self-evolution pipeline is Vera's P2 core capability. Its goal is not "run more tests" but to give Vera a real, controlled evolution mechanism. The pipeline starts from experience distillation, flows through proposal generation, human review, and benchmark-gated rollout, forming a closed-loop self-improvement system.

---

## 1. Architecture Overview

```
Experience Data (Episodic Memory / Failure Logs)
        │
        ▼
  DreamingRunner          ← Analyze experiences, extract Insights, generate Proposals
        │
        ▼
  ProposalStore           ← Persistent storage, lifecycle management
        │
        ▼
  Human Review            ← pending → approved / rejected / deferred
        │
        ▼
  Benchmark-gated Rollout ← Validate improvements via EvalHarness
        │
        ├─ Pass → applied  → Update StrategyStore
        └─ Fail → rejected → Write back failure reason, trigger next Dreaming
```

Full pipeline: **Critique / Dreaming → Proposal → Human Review → Benchmark Gate → Strategic Rollout → Feedback Loop**

---

## 2. Dreaming System

Dreaming is the entry point of the self-evolution pipeline. It runs during agent idle time to analyze historical experiences (episodic memory, benchmark failures) and extract actionable improvement suggestions.

**Source:** `packages/harness/src/dreaming/runner.ts`

### 2.1 DreamingRunner

`DreamingRunner` is the core class that accepts a list of experiences and produces insights and proposals.

```typescript
const runner = new DreamingRunner({
  maxExperiences: 100,   // Max experiences to analyze per run
  minConfidence: 0.5,    // Minimum confidence threshold for insights
  maxProposals: 10,      // Maximum proposals to generate
  proposalTypes: ["prompt", "tool_policy", "workflow", "skill"],
});

const result = await runner.dream(experiences);
// result: { insights, proposals, experiencesAnalyzed, duration }
```

### 2.2 Experience Model

```typescript
interface Experience {
  id: string;
  type: "success" | "failure" | "partial";  // Execution outcome
  taskDescription: string;
  toolCalls: string[];                        // Tools used during execution
  duration: number;                           // Execution time in ms
  outcome: string;                            // Result description
  metadata?: Record<string, unknown>;
}
```

### 2.3 Insight Extraction

`extractInsights()` performs four types of analysis:

| Analysis Type | Method | Insight Category |
|---------------|--------|------------------|
| Successful tool patterns | `findToolPatterns(experiences, "success")` | `pattern` |
| Failing tool patterns | `findToolPatterns(experiences, "failure")` | `anti_pattern` |
| Slow task identification | `findSlowTasks(experiences)` | `optimization` |
| Capability gaps | `findGaps(experiences)` | `gap` |

**Tool pattern analysis:** Sorts each experience's tool calls and joins them as combination keys (e.g., `"bash+read_file+write_file"`), counting occurrences in success/failure experiences. A pattern requires at least 2 occurrences to trigger an insight. Confidence formula: `min(0.9, count / 10 + 0.3)`.

**Slow task identification:** Calculates the average duration across all experiences and flags tasks exceeding 2x the average as "slow." Confidence is fixed at 0.7.

**Capability gap identification:** Filters all failure experiences, grouping by tool combination. Combinations with at least 2 repeated failures are considered capability gaps. Confidence formula: `min(0.85, count / 5 + 0.4)`.

### 2.4 Proposal Generation

`generateProposals()` maps each filtered Insight (confidence >= `minConfidence`) to an `ImprovementProposal`:

| Insight Category | Proposal Type | Priority | Suggested Change Direction |
|-----------------|--------------|----------|---------------------------|
| `pattern` (success) | `workflow` | medium | Create a skill or workflow template chaining these tools |
| `anti_pattern` (failure) | `tool_policy` | high | Add warning or alternative strategy when this combination is attempted |
| `optimization` (slow) | `prompt` | low | Add time-awareness to prompts or implement early termination |
| `gap` (missing capability) | `skill` | critical | Develop a new skill or tool to handle this task type |

### 2.5 Proposal Data Structure

```typescript
interface ImprovementProposal {
  id: string;
  type: "prompt" | "tool_policy" | "workflow" | "skill";
  priority: "low" | "medium" | "high" | "critical";
  status: "pending" | "approved" | "rejected" | "deferred" | "applied";
  title: string;
  description: string;
  rationale: string;            // Why this change is needed
  insights: string[];           // Linked insight IDs
  suggestedChange: string;      // Concrete change suggestion
  expectedImpact: string;       // Expected outcome
  createdAt: string;
}
```

---

## 3. Proposal Store

The proposal store provides persistent stateful lifecycle management.

**Source:** `packages/harness/src/proposal/store.ts`

### 3.1 Core API

| Method | Purpose |
|--------|---------|
| `add(proposal)` | Add a proposal (deduplicated by ID) |
| `addAll(proposals)` | Batch add proposals |
| `updateStatus(id, status)` | Update proposal status |
| `list(filter?)` | List proposals filtered by status/type/priority/time |
| `getReadyForRollout()` | Get all approved proposals awaiting rollout |
| `getApplied()` | Get all applied proposals (for verification/rollback) |
| `countByStatus()` | Count proposals grouped by status |
| `remove(id)` | Remove a specific proposal |

### 3.2 Lifecycle

```
pending → approved → applied → verified (future)
   ↓         ↓
rejected  deferred
```

- **pending**: Initial state from DreamingRunner or manual creation
- **approved**: Passed human review, awaiting rollout
- **rejected**: Rejected with reason
- **deferred**: Temporarily shelved for later evaluation
- **applied**: Deployed to production

### 3.3 Persistence

Data is stored as a JSON array at the specified path, auto-saved on every mutation. Idempotent addition is supported (same ID is not inserted twice).

---

## 4. Strategy Store

The Strategy Store is the institutional knowledge layer. Each validated improvement is solidified as a Strategy, organized by task domain, with continuous outcome tracking.

**Source:** `packages/harness/src/strategy/strategy-store.ts` and `types.ts`

### 4.1 Strategy Data Structure

```typescript
interface Strategy {
  id: string;
  name: string;
  domain: StrategyDomain;       // Target task domain
  status: "active" | "deprecated" | "candidate" | "retired";
  version: number;              // Incremented on each update
  prompt: PromptTemplate;       // Prompt template with variable substitution
  model: ModelConfig;           // Model configuration
  toolPolicy: ToolPolicy;       // Tool usage policy (allow/deny/constraints)
  createdAt: string;
  updatedAt: string;
  tags?: string[];
}
```

### 4.2 Task Domains (StrategyDomain)

```
coding | debugging | research | writing | data-analysis | planning | review | testing | devops | general
```

### 4.3 Outcome Tracking

Every strategy execution records a `StrategyOutcome`:

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

### 4.4 Auto-Tuning

`autoTune(promoteThreshold, deprecateThreshold, minRuns)` adjusts strategy status based on historical success rates:

- **candidate → active**: successRate >= `promoteThreshold` (default 0.7) AND runs >= `minRuns` (default 5)
- **active → deprecated**: successRate < `deprecateThreshold` (default 0.3) AND runs >= `minRuns`
- **deprecated/retired**: Not auto-changed (manual only)

### 4.5 Statistics and Comparison

| Method | Purpose |
|--------|---------|
| `getStats(strategyId)` | Aggregated statistics (success rate, avg duration, token usage) |
| `compare(idA, idB)` | Compare two strategies, returns winner and confidence |
| `getBestForDomain(domain, minRuns)` | Get the best strategy for a domain by success rate |
| `getDomainSummary(domain)` | Domain-level summary: strategy count, total runs, overall success rate |

### 4.6 Trend Detection

`getTrend(strategyId, recentWindow, olderWindow)` compares success rates between two time windows:

| Trend Direction | Condition |
|-----------------|-----------|
| `improving` | recentRate - olderRate > 5% |
| `declining` | recentRate - olderRate < -5% |
| `stable` | Difference within ±5% |
| `insufficient_data` | Both windows have fewer runs than `minRunsForTrend` (default 3) |

### 4.7 Windowed Statistics

Supports predefined windows (`1h`, `6h`, `24h`, `7d`, `30d`) and custom millisecond durations, filtering outcomes by time range before recomputing statistics.

---

## 5. Change Store

The change tracking system stores agent tool call records in daily JSONL files, supporting query, filter, and archival.

**Source:** `packages/harness/src/tracking/change-store.ts`

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

One JSONL file per day: `~/.vera/changes/YYYY-MM-DD.jsonl`, each line a complete ChangeRecord JSON.

### 5.3 Query Capabilities

`query(options)` supports filtering by time range, agent ID, tool name, and file path, with a configurable result limit (default 100).

### 5.4 Archival

`archive()` moves log files older than `retentionDays` (default 30) to an `archive/` subdirectory and removes the originals.

---

## 6. Eval Harness Integration

The evaluation framework acts as the "gatekeeper" for evolution — no proposal can be deployed without passing benchmark validation.

**Source:** `packages/harness/src/eval/harness.ts`

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

| evalType | Scoring Logic | Use Case |
|----------|--------------|----------|
| `exact` | Response matches expected exactly (case-insensitive) | QA with precise answers |
| `contains` | Expected text appears in response | Key information extraction |
| `regex` | Response matches regex pattern | Format validation |
| `tool_match` | Actual tool calls match expected tool set | Tool selection correctness |
| `llm_judge` | Reserved interface (currently returns 0.5) | Subjective quality assessment |

### 6.3 Test Cases

```typescript
interface EvalCase {
  id: string;
  description: string;
  level: 1 | 2 | 3;           // Difficulty level
  prompt: string;              // Prompt sent to agent
  expected?: string;           // Expected answer
  evalType: EvalType;
  expectedTools?: string[];    // Expected tools for tool_match type
  tags?: string[];             // Category tags
  timeoutMs?: number;          // Timeout (default 60000ms)
  maxCostUsd?: number;         // Cost ceiling (default $1.0)
}
```

### 6.4 Evaluation Report

```typescript
interface EvalReport {
  benchmark: string;
  model: string;
  passRate: number;            // Overall pass rate
  avgScore: number;            // Average score
  avgDurationMs: number;       // Average duration
  totalCostUsd: number;        // Total cost
  byLevel: Record<number, { total, passed, passRate }>;
  results: EvalResult[];       // Per-case results
}
```

### 6.5 Role in Self-Evolution

1. Proposal generated → human review approved
2. → Run full benchmark via EvalHarness
3. → Compare against baseline (current strategy) scores
4. → Positive improvement → mark as applied, update StrategyStore
5. → No improvement or regression → mark as rejected, write back failure reason

---

## 7. Configuration

### 7.1 DreamingRunner

```typescript
interface DreamingConfig {
  maxExperiences?: number;      // Default 100
  minConfidence?: number;       // Default 0.5
  maxProposals?: number;        // Default 10
  proposalTypes?: ProposalType[];  // Default: all types
}
```

### 7.2 ChangeStore

```typescript
interface ChangeStoreOptions {
  storeDir?: string;            // Default: ~/.vera/changes
  retentionDays?: number;       // Default: 30
}
```

### 7.3 EvalHarness

```typescript
interface EvalRunnerOptions {
  name: string;                 // Benchmark name
  casesPath?: string;           // Path to test cases JSON file
  concurrency?: number;         // Concurrency (default 1)
  timeoutMs?: number;           // Global timeout per case (default 60000)
  model?: string;               // Model/agent name for reporting
}
```

---

## 8. Current Status

The self-evolution pipeline is in the **P2 phase** (roadmap: "Establish the self-evolution closed loop"):

| Component | Status | Notes |
|-----------|--------|-------|
| `DreamingRunner` | Implemented | Rule-driven experience analysis, 4 insight types, proposal mapping |
| `ProposalStore` | Implemented | Persistent storage, lifecycle management, filtered queries |
| `StrategyStore` | Implemented | Strategy CRUD, success rate tracking, auto-tuning, trend detection, domain summaries |
| `ChangeStore` | Implemented | Daily JSONL storage, time/agent/tool/file filtering, archival |
| `EvalHarness` | Implemented | 5 evaluation types, report generation, AgentExecutor interface decoupling |
| LLM-driven Dreaming | Planned | Current dreaming is rule-driven; future versions should use LLM for deeper experience analysis |
| Full closed-loop automation | Planned | Proposal → review → benchmark → rollout currently requires manual triggering |
| Production feedback loop | Planned | Real-world task failures auto-ingested into benchmark pool after human confirmation |

---

## 9. Key Design Decisions

1. **Dreaming lives in the Harness layer**: Dreaming depends on episodic memory and benchmark results, which are Harness-level concepts. The Core layer does not perceive experience "success" or "failure."
2. **Strategy and Proposal are separate**: Proposal is "what to change"; Strategy is "validated best practice deposited as institutional knowledge." They represent different lifecycle stages.
3. **EvalHarness decouples via AgentExecutor interface**: No direct dependency on Core's agent loop; can connect to any agent implementation.
4. **Change tracking uses JSONL**: Append-only, crash-safe, daily-sharded for easy archival and parallel queries.
5. **Auto-tuning has minimum-sample protection**: The `minRuns` parameter (default 5) prevents false positives from small sample sizes.

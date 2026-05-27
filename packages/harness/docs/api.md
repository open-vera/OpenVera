# OpenVera API Reference

## Table of Contents

- [CheckpointStore](#checkpointstore) — Flow recovery checkpoint storage
- [MemoryStore](#memorystore) — Three-tier autonomous agent memory
- [SubagentPool](#subagentpool) — Concurrent subagent execution pool
- [SubagentOrchestrator](#subagentorchestrator) — Multi-agent coordination patterns

---

## CheckpointStore

`packages/harness/src/runtime/checkpoint-store.ts`

Append-only JSONL-based checkpoint storage for Flow recovery.

### Constructor

```typescript
new CheckpointStore(options: CheckpointStoreOptions)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `checkpointsDir` | `string` | *(required)* | Root directory for checkpoint files |
| `compactToKeep` | `number` | `0` | Max checkpoints to keep per flow during compaction |
| `compactAfter` | `number` | `compactToKeep * 3` | Auto-compact threshold (line count) |

### Methods

#### `save(checkpoint: FlowCheckpoint): void`
Persist a checkpoint (append-only write). Auto-compacts when entry count exceeds `compactAfter`.

#### `loadLatest(flowId: string): FlowCheckpoint | null`
Load the most recent checkpoint for a flow. Scans from end, skips corrupt lines.

#### `load(flowId: string, checkpointId: string): FlowCheckpoint | null`
Load a specific checkpoint by ID. Scans from end (most recent first).

#### `list(flowId: string): CheckpointIndexEntry[]`
List all checkpoint index entries for a flow (lightweight, no full data).

#### `listFlows(): string[]`
List all flow IDs that have checkpoints.

#### `compact(flowId: string): number`
Compact a flow's checkpoint file: remove corrupt lines, deduplicate by checkpointId, prune to last N entries. Uses atomic write (temp + rename). Returns lines removed.

#### `compactAll(): number`
Compact all flows. Returns total lines removed.

#### `lineCount(flowId: string): number`
Get raw line count (including corrupt lines and duplicates).

#### `needsCompaction(flowId: string): boolean`
Check if a flow's file needs compaction.

#### `clear(flowId: string): void`
Delete all checkpoints for a flow.

#### `count(flowId: string): number`
Get the number of valid checkpoints for a flow.

### Utility

```typescript
function makeCheckpointId(): string
// Format: `cp-<timestamp_base36>-<random4>`
```

### Types

```typescript
interface CheckpointIndexEntry {
  checkpointId: string;
  flowId: string;
  state: string;
  createdAt: string;
  activeStepId?: string;
}
```

---

## MemoryStore

`packages/core/src/memory/store.ts`

Three-tier memory system for autonomous agents.

### Memory Tiers

| Tier | Storage | Lifetime | Use Case |
|------|---------|----------|----------|
| `working` | In-memory Map | Session-scoped | Current context, volatile |
| `episodic` | JSONL file | Persistent | Task-level summaries |
| `semantic` | JSONL file | Persistent | Knowledge facts (key-value) |

### Constructor

```typescript
new MemoryStore(options?: MemoryStoreOptions)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `storeDir` | `string` | `null` | Directory for persisted memory |
| `maxWorkingEntries` | `number` | `200` | Max working memory entries before auto-eviction |
| `maxIndexEntries` | `number` | `5000` | Max entries in inverted index |

### Working Memory

```typescript
addWorking(content: string, tags?: string[], source?: string, importance?: number): MemoryEntry
getWorking(): MemoryEntry[]
clearWorking(): void
```

### Episodic Memory

```typescript
addEpisodic(
  taskSummary: string,
  outcome: string,
  lessons: string[],
  tags?: string[],
  source?: string,
  importance?: number
): EpisodicEntry

getEpisodic(): EpisodicEntry[]
```

### Semantic Memory

```typescript
addSemantic(key: string, value: string, tags?: string[], source?: string, importance?: number): SemanticEntry
getSemantic(): SemanticEntry[]
removeSemantic(key: string): boolean
```

Semantic memory deduplicates by key — if key exists, updates value and merges tags.

### Search

```typescript
search(query: string, options?: { tiers?: MemoryTier[]; limit?: number }): MemorySearchResult[]
```

Uses an inverted index for O(k) lookup. Returns results sorted by relevance (score = match proportion * 0.7 + importance * 0.3).

```typescript
interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
  matchedTerms: string[];
}
```

### Stats

```typescript
stats(): { working: number; episodic: number; semantic: number; total: number }
```

### Persistence

- `addEpisodic` and `addSemantic` auto-persist to JSONL files
- `persistAll()` rewrites entire file (atomic via temp + rename)
- `persistEntry()` appends single entry
- `flush(): Promise<void>` — await to ensure all pending writes complete

### Types

```typescript
interface MemoryEntry {
  id: string;
  tier: MemoryTier;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  source?: string;
  importance: number;
}

interface EpisodicEntry extends MemoryEntry {
  tier: "episodic";
  taskSummary: string;
  outcome: string;
  lessons: string[];
}

interface SemanticEntry extends MemoryEntry {
  tier: "semantic";
  key: string;
  value: string;
}
```

---

## SubagentPool

`packages/core/src/agent/subagent-pool.ts`

Manages concurrent subagent execution with limits.

### Constructor

```typescript
new SubagentPool(options?: SubagentPoolOptions)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxConcurrent` | `number` | `3` | Maximum concurrent subagents |
| `maxQueue` | `number` | `10` | Maximum queued jobs before rejection |

### Methods

#### `submit(jobId: string, agentType: string, prompt: string): PoolJob`
Submit a job. Returns the job. Throws `DuplicateJobError` if ID exists, `QueueFullError` if queue is full.

#### `complete(jobId: string, result: string): void`
Mark a job as completed with result.

#### `fail(jobId: string, error: string): void`
Mark a job as failed with error.

#### `cancel(jobId: string): boolean`
Cancel a running or queued job. Returns `true` if cancelled.

#### `isCancelled(jobId: string): boolean`
Check if a job has been cancelled.

#### `getSignal(jobId: string): AbortSignal | undefined`
Get the AbortSignal for a job (pass to subagent execution).

#### `get(jobId: string): PoolJob | undefined`
Get a specific job.

#### `list(status?: SubagentJobStatus): PoolJob[]`
Get all jobs, optionally filtered by status.

#### `status(): { running: number; queued: number; total: number; maxConcurrent: number }`
Get pool status summary.

#### `clearFinished(): number`
Clear completed/failed jobs. Returns number cleared.

### Types

```typescript
interface PoolJob {
  jobId: string;
  agentType: string;
  prompt: string;
  status: SubagentJobStatus;
  createdAt: number;
  updatedAt: number;
  result?: string;
  error?: string;
  cancelToken?: AbortController;
}
```

---

## SubagentOrchestrator

`packages/core/src/agent/subagent-orchestrator.ts`

Coordinate multiple subagents with dependency patterns (fan-out, pipeline, map-reduce).

### Constructor

```typescript
new SubagentOrchestrator(tasks: OrchestratorTask[])
```

Validates dependencies on construction (throws `UnknownDependencyError` or `CircularDependencyError`).

### Methods

#### `run(opts: OrchestratorRunOptions): Promise<Map<string, OrchestratorResult>>`
Run all tasks respecting dependency order. Independent tasks run in parallel.

```typescript
interface OrchestratorRunOptions {
  executeTask: (task: OrchestratorTask, context: string) => Promise<string>;
  onTaskComplete?: (taskId: string, output: string) => void;
  onTaskFail?: (taskId: string, error: string) => void;
  signal?: AbortSignal;
}
```

#### `getResults(): Map<string, OrchestratorResult>`
Get all results.

#### `getStatus(): OrchestratorStatus`
Get orchestrator status: `pending | running | completed | failed | cancelled`.

#### `getSummary(): string`
Get formatted summary of all task results.

### Convenience Functions

#### `fanOut(tasks, executeTask): SubagentOrchestrator`
Run N independent tasks in parallel, collect all results.

#### `pipeline(tasks): SubagentOrchestrator`
Create a sequential pipeline where each task feeds into the next.

#### `mapReduce(mapTasks, reduceTask): SubagentOrchestrator`
Map-reduce: run map tasks in parallel, then reduce with a final task.

### Types

```typescript
interface OrchestratorTask {
  id: string;
  agentType: string;
  prompt: string;
  dependsOn?: string[];
  injectResults?: boolean;
}

interface OrchestratorResult {
  taskId: string;
  status: OrchestratorStatus;
  output?: string;
  error?: string;
  durationMs: number;
}
```

### Example

```typescript
import { SubagentOrchestrator } from "@open-vera/core/agent";

const orchestrator = new SubagentOrchestrator([
  { id: "research", agentType: "explorer", prompt: "Find relevant files" },
  { id: "analyze", agentType: "analyzer", prompt: "Analyze code", dependsOn: ["research"] },
  { id: "summarize", agentType: "writer", prompt: "Write summary", dependsOn: ["analyze"] },
]);

const results = await orchestrator.run({
  executeTask: async (task, context) => {
    // Invoke subagent with task.prompt + context from dependencies
    return await runAgent(task.agentType, task.prompt + "\n\n" + context);
  },
  signal: abortController.signal,
});
```

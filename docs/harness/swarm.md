# Swarm -- Parallel Sandbox Scheduling System

Swarm is the parallel task scheduling module in the Vera Harness layer, providing multi-sandbox concurrent execution capability. It manages a priority task queue, concurrent sandbox creation, task splitting, and result merging, allowing developers to submit a batch of independent computation tasks in parallel to multiple securely isolated sandboxes.

Core code is located at `packages/harness/src/swarm/`.

---

## Overall Architecture

```
User submits task
    |
    v
+------------------------------+
|       SwarmScheduler         |
|                              |
|  submit(task) -> priority queue |
|       |                      |
|       +-- Create Sandbox      |
|       +-- Upload files/content|
|       +-- Execute command     |
|       +-- Collect result      |
|       +-- Destroy/reuse Sandbox|
|                              |
|  Event system (EventEmitter)  |
|  Budget control               |
|  Auto retry                   |
+------------------------------+
    |
    v
+--------------+    +--------------+
| TaskSplitter |    | ResultMerger |
|              |    |              |
| Split large  |    | Merge parallel|
| tasks into   |    | results into  |
| sub-tasks    |    | unified output|
+--------------+    +--------------+
```

---

## Core Types

### SwarmTask

```typescript
interface SwarmTask {
  readonly id: string;                                 // Unique identifier (auto-generated)
  readonly name: string;                               // Task name
  readonly priority: TaskPriority;                     // Priority
  readonly command: string;                            // Command to execute in sandbox
  readonly files?: Array<{ localPath: string; remotePath: string }>;   // Files to upload
  readonly contents?: Array<{ content: string | Uint8Array; remotePath: string }>; // Content to upload
  readonly workdir?: string;                           // Working directory
  readonly env?: Record<string, string>;               // Environment variables
  readonly timeoutSeconds?: number;                    // Timeout (seconds)
  readonly sandboxOptions?: Partial<SandboxCreateOptions>;  // Sandbox option overrides
  readonly maxRetries?: number;                        // Max retries
}
```

### TaskPriority

| Value | Internal Weight | Description |
|---|---|---|
| `"critical"` | 4 | Highest priority, scheduled first |
| `"high"` | 3 | High priority |
| `"normal"` | 2 | Default priority |
| `"low"` | 1 | Low priority, scheduled last |

### SwarmTaskResult

```typescript
interface SwarmTaskResult {
  readonly taskId: string;           // Corresponding task ID
  readonly taskName: string;         // Task name
  readonly status: SwarmTaskStatus;  // Final status
  readonly exitCode: number | null;  // Exit code
  readonly stdout: string;           // Standard output
  readonly stderr: string;           // Standard error
  readonly durationMs: number;       // Execution duration
  readonly sandboxId: string;        // Sandbox ID
  readonly error?: string;           // Error message
  readonly retries: number;          // Retry count
}
```

### SwarmTaskStatus

```
pending -> assigned -> running -> completed / failed / timeout / cancelled
```

| Status | Description |
|---|---|
| `pending` | Waiting in queue |
| `assigned` | Sandbox allocated |
| `running` | Currently executing |
| `completed` | Execution succeeded (exitCode=0) |
| `failed` | Execution failed (exitCode!=0 or no sandbox) |
| `timeout` | Timed out |
| `cancelled` | Cancelled |

---

## Priority Queue

The scheduler uses a `PriorityQueue` internally. Higher-priority tasks are dequeued first; same-priority tasks follow FIFO order.

```typescript
const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};
```

The queue is implemented as a sorted array, with binary-search-based insertion for priority ordering and dequeue from the front.

**Strict fairness is not guaranteed**: continuously submitting `critical` tasks can monopolize sandboxes, and `low` tasks may starve. Production scenarios should mix priority levels.

---

## Event System

The scheduler fires events at key lifecycle points. External listeners can register to observe them:

```typescript
type SwarmSchedulerEvent =
  | { type: "task:queued"; taskId: string; taskName: string }
  | { type: "task:assigned"; taskId: string; sandboxId: string }
  | { type: "task:started"; taskId: string; sandboxId: string }
  | { type: "task:completed"; taskId: string; result: SwarmTaskResult }
  | { type: "task:failed"; taskId: string; error: string }
  | { type: "task:cancelled"; taskId: string }
  | { type: "sandbox:created"; sandboxId: string }
  | { type: "sandbox:destroyed"; sandboxId: string }
  | { type: "scheduler:idle" }
  | { type: "scheduler:drained" };  // All tasks completed
```

**Event order example:**

```
task:queued -> sandbox:created -> task:assigned -> task:started -> task:completed -> sandbox:destroyed -> scheduler:drained
```

---

## Scheduler API

### Creation and Configuration

```typescript
import { createSwarmScheduler } from "@open-vera/harness";
import type { SwarmSchedulerConfig, SandboxProvider } from "@open-vera/harness";

const scheduler = createSwarmScheduler({
  maxConcurrency: 4,                    // Max concurrent sandboxes
  provider: mySandboxProvider,          // Sandbox provider instance
  defaultSandboxOptions: {              // Default sandbox options
    image: "ubuntu:22.04",
    cpu: 1,
    memoryMb: 512,
  },
  defaultTimeoutSeconds: 300,           // Default timeout 5 minutes
  pollIntervalMs: 100,                  // Polling interval 100ms
  autoDestroy: true,                    // Auto-destroy sandbox after completion
  budgetLimit: 100,                     // Budget limit (elapsed seconds, 0=unlimited)
});
```

**Configuration fields:**

| Field | Type | Default | Description |
|---|---|---|---|
| `maxConcurrency` | number | (required) | Max concurrent sandboxes |
| `provider` | SandboxProvider | (required) | Sandbox provider |
| `defaultSandboxOptions` | object | `{}` | Default sandbox creation options |
| `defaultTimeoutSeconds` | number | `300` | Default task timeout (seconds) |
| `pollIntervalMs` | number | `100` | Polling interval (milliseconds) |
| `autoDestroy` | boolean | `true` | Auto-destroy sandbox after task completion |
| `budgetLimit` | number | `0` | Budget cap (unit: seconds, 0=unlimited) |

### Submitting Tasks

```typescript
// Single task
const taskId = scheduler.submit({
  name: "Run tests for module-a",
  priority: "normal",
  command: "cd /workspace && npm test -- --filter=module-a",
  files: [
    { localPath: "./module-a", remotePath: "/workspace/module-a" },
  ],
  env: { NODE_ENV: "test" },
  timeoutSeconds: 600,
  maxRetries: 2,
});

// Batch submit
const taskIds = scheduler.submitBatch([
  { name: "lint", command: "npm run lint", priority: "high" },
  { name: "test-a", command: "npm test module-a", priority: "normal" },
  { name: "test-b", command: "npm test module-b", priority: "normal" },
]);
```

`submit` returns a task ID. If no `id` is provided, it is auto-generated as `task-1`, `task-2`, ...

### Getting Results

```typescript
// Get single result
const result = scheduler.getResult(taskId);
if (result) {
  console.log(result.stdout);
  console.log(`Duration: ${result.durationMs}ms`);
}

// Get all results
const allResults = scheduler.getResults();

// Wait for all to complete
const results = await scheduler.waitForAll();
for (const r of results) {
  console.log(`${r.taskName}: ${r.status} (${r.durationMs}ms)`);
}

// Wait for single task
const result = await scheduler.waitForTask(taskId);
```

### Status Query

```typescript
const status = scheduler.getStatus();
// {
//   pendingTasks: 5,
//   runningTasks: 4,
//   completedTasks: 10,
//   failedTasks: 1,
//   activeSandboxes: 4,
//   maxConcurrency: 4,
//   shuttingDown: false,
// }
```

### Cancellation and Shutdown

```typescript
// Cancel single task
scheduler.cancel(taskId);
// If task is in queue -> remove directly
// If task is executing -> destroy its sandbox (force stop)

// Shut down scheduler (cancel all queued tasks, destroy all sandboxes)
await scheduler.shutdown();
```

### Event Listening

```typescript
scheduler.on((event) => {
  switch (event.type) {
    case "task:completed":
      console.log(`[OK] ${event.result.taskName}`);
      break;
    case "task:failed":
      console.error(`[FAIL] ${event.taskId}: ${event.error}`);
      break;
    case "scheduler:drained":
      console.log("All tasks finished!");
      break;
  }
});
```

---

## Task Splitting (TaskSplitter)

`TaskSplitter` automatically splits large tasks into parallelizable sub-tasks.

### Built-in Strategies

#### FileBatchSplitStrategy

Splits by file count. Triggers when `task.files.length > batchSize` (default 10).

```typescript
import { FileBatchSplitStrategy } from "@open-vera/harness";

const strategy = new FileBatchSplitStrategy(10);
// 100 files -> 10 sub-tasks (10 files per batch)
```

#### ContentBatchSplitStrategy

Splits by content fragment count. Triggers when `task.contents.length > batchSize` (default 10).

```typescript
import { ContentBatchSplitStrategy } from "@open-vera/harness";

const strategy = new ContentBatchSplitStrategy(10);
```

#### ParallelCommandSplitStrategy

Splits independent commands separated by `;` into parallel sub-tasks. Note: commands joined by `&&` are not split (existence of dependencies).

```typescript
import { ParallelCommandSplitStrategy } from "@open-vera/harness";

// "lint; test; build" -> 3 independent sub-tasks
// "lint && test" -> not split
```

Semicolons inside quoted strings are correctly handled during semicolon-based splitting to avoid erroneous splits.

#### CustomSplitStrategy

User-defined split logic:

```typescript
import { CustomSplitStrategy } from "@open-vera/harness";

const strategy = new CustomSplitStrategy(
  "my-strategy",
  (task) => task.name.includes("batch"),       // predicate: can it be split?
  (task) => [/* ...SwarmTask[] */],             // splitter: split into sub-tasks
);
```

### Usage

```typescript
import { TaskSplitter } from "@open-vera/harness";

const splitter = new TaskSplitter({
  strategies: [
    new FileBatchSplitStrategy(5),
    new ParallelCommandSplitStrategy(),
  ],
  maxSubTasks: 20,      // Max 20 sub-tasks
  splitThreshold: 2,    // Do not split when task complexity < 2
});

const result = splitter.trySplit(myTask);
if (result) {
  console.log(`Split into ${result.subTasks.length} sub-tasks via ${result.strategy}`);
  // Submit sub-tasks in batch
  scheduler.submitBatch(result.subTasks);
}
```

**Task complexity estimation:** `1 + files.length + contents.length + (2 if multi-command)`. Tasks with complexity below `splitThreshold` do not trigger splitting.

---

## Result Merging (ResultMerger)

`ResultMerger` merges parallel execution sub-task results into a unified output.

### Built-in Strategies

#### ConcatMergeStrategy (Default)

Concatenates stdout/stderr of all sub-tasks. Suitable for text-output tasks.

```typescript
import { ConcatMergeStrategy } from "@open-vera/harness";

// stdout:
// [test-a] tests passed: 42/42
// [test-b] tests passed: 18/18
```

**MergedResult status:**
- All successful -> `"completed"`
- Partial failure -> `"partial"`
- All failed -> `"failed"`

`totalDurationMs` is the sum of all sub-task durations, `wallClockDurationMs` is the maximum sub-task duration (reflecting the true wall-clock time of parallel execution).

#### ReportMergeStrategy

Generates a structured Markdown table report:

```typescript
import { ReportMergeStrategy } from "@open-vera/harness";

// stdout:
// ## Swarm Execution Report
//
// | Metric | Value |
// |--------|-------|
// | Total tasks | 3 |
// | Succeeded | 3 |
// | Failed | 0 |
// | Wall-clock time | 4500ms |
//
// ### Per-Task Results
// | Task | Status | Duration | Exit Code |
// |------|--------|----------|-----------|
// | test-a | pass | 3200ms | 0 |
// | test-b | pass | 1800ms | 0 |
// | lint | pass | 4500ms | 0 |
```

#### CustomMergeStrategy

```typescript
import { CustomMergeStrategy } from "@open-vera/harness";

const strategy = new CustomMergeStrategy(
  "my-merge",
  (results) => ({
    status: "completed",
    stdout: results.map(r => r.stdout).join("\n---\n"),
    stderr: "",
    taskResults: results,
    totalDurationMs: results.reduce((s, r) => s + r.durationMs, 0),
    wallClockDurationMs: Math.max(...results.map(r => r.durationMs)),
    successCount: results.length,
    failureCount: 0,
    strategy: "my-merge",
    summary: "Custom merge completed",
  })
);
```

### Usage

```typescript
import { ResultMerger, ConcatMergeStrategy, ReportMergeStrategy } from "@open-vera/harness";

const merger = new ResultMerger({
  strategies: [new ConcatMergeStrategy(), new ReportMergeStrategy()],
  defaultStrategy: "concat",
});

const results = await scheduler.waitForAll();
const merged = merger.merge(results);
console.log(merged.summary);  // "42/42 tasks completed"
console.log(merged.stdout);   // Merged output

// Merge with specified strategy
const report = merger.mergeWith(results, "report");
```

---

## Typical Workflows

### Parallel Testing

```typescript
import { createSwarmScheduler, TaskSplitter, ResultMerger } from "@open-vera/harness";

// 1. Initialize
const scheduler = createSwarmScheduler({
  maxConcurrency: 4,
  provider: sandboxProvider,
  autoDestroy: true,
});

const splitter = new TaskSplitter();
const merger = new ResultMerger({ defaultStrategy: "concat" });

// 2. Split task
const task = {
  name: "test-suite",
  command: "npm test -- --filter=$MODULE",
  priority: "normal" as const,
  files: testFileList.map((f) => ({ localPath: f, remotePath: `/src/${f}` })),
  maxRetries: 1,
};
const split = splitter.trySplit(task);

// 3. Submit and execute
if (split) {
  scheduler.submitBatch(split.subTasks);
} else {
  scheduler.submit(task);
}

// 4. Wait for completion
const results = await scheduler.waitForAll();

// 5. Merge results
const merged = merger.merge(results);
console.log(merged.summary);
```

### Event-Driven Monitoring

```typescript
scheduler.on((event) => {
  if (event.type === "task:completed") {
    if (event.result.status === "failed") {
      notifyFailure(event.result);
    }
  }
  if (event.type === "scheduler:drained") {
    finalizeReport(scheduler.getResults());
  }
});
```

### Budget Control

```typescript
const scheduler = createSwarmScheduler({
  maxConcurrency: 8,
  provider: sandboxProvider,
  budgetLimit: 3600, // Total execution time not to exceed 1 hour (seconds)
});

// When cumulative execution time exceeds budgetLimit, the scheduler automatically stops assigning new tasks
```

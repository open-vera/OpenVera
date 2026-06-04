# 蜂群 Swarm -- 并行沙箱调度系统

Swarm 是 Vera Harness 层的并行任务调度模块，提供多沙箱并发执行能力。它管理优先级任务队列、并发沙箱创建、任务拆分和结果合并，让开发者把一批独立的计算任务并行投递到多个安全隔离的沙箱中执行。

核心代码位于 `packages/harness/src/swarm/`。

---

## 整体架构

```
用户提交任务
    │
    ▼
┌──────────────────────────────┐
│       SwarmScheduler         │
│                              │
│  submit(task) → 优先级队列    │
│       │                      │
│       ├─ 创建 Sandbox         │
│       ├─ 上传文件/内容         │
│       ├─ 执行命令              │
│       ├─ 收集结果              │
│       └─ 销毁/复用 Sandbox     │
│                              │
│  事件系统 (EventEmitter)       │
│  预算控制                      │
│  自动重试                      │
└──────────────────────────────┘
    │
    ▼
┌──────────────┐    ┌──────────────┐
│ TaskSplitter │    │ ResultMerger │
│              │    │              │
│ 拆分大任务    │    │ 合并并行结果  │
│ 为子任务      │    │ 为统一输出    │
└──────────────┘    └──────────────┘
```

---

## 核心类型

### SwarmTask

```typescript
interface SwarmTask {
  readonly id: string;                                 // 唯一标识（可自动生成）
  readonly name: string;                               // 任务名称
  readonly priority: TaskPriority;                     // 优先级
  readonly command: string;                            // 沙箱内执行的命令
  readonly files?: Array<{ localPath: string; remotePath: string }>;   // 上传文件
  readonly contents?: Array<{ content: string | Uint8Array; remotePath: string }>; // 上传内容
  readonly workdir?: string;                           // 工作目录
  readonly env?: Record<string, string>;               // 环境变量
  readonly timeoutSeconds?: number;                    // 超时（秒）
  readonly sandboxOptions?: Partial<SandboxCreateOptions>;  // 沙箱选项覆盖
  readonly maxRetries?: number;                        // 最大重试次数
}
```

### TaskPriority

| 值 | 内部权重 | 说明 |
|---|---|---|
| `"critical"` | 4 | 最高优先级，优先调度 |
| `"high"` | 3 | 高优先级 |
| `"normal"` | 2 | 默认优先级 |
| `"low"` | 1 | 低优先级，最后调度 |

### SwarmTaskResult

```typescript
interface SwarmTaskResult {
  readonly taskId: string;           // 对应任务 ID
  readonly taskName: string;         // 任务名称
  readonly status: SwarmTaskStatus;  // 最终状态
  readonly exitCode: number | null;  // 退出码
  readonly stdout: string;           // 标准输出
  readonly stderr: string;           // 标准错误
  readonly durationMs: number;       // 执行时长
  readonly sandboxId: string;        // 沙箱 ID
  readonly error?: string;           // 错误信息
  readonly retries: number;          // 重试次数
}
```

### SwarmTaskStatus

```
pending → assigned → running → completed / failed / timeout / cancelled
```

| 状态 | 说明 |
|---|---|
| `pending` | 在队列中等待 |
| `assigned` | 已分配沙箱 |
| `running` | 正在执行 |
| `completed` | 执行成功（exitCode=0） |
| `failed` | 执行失败（exitCode≠0 或无沙箱） |
| `timeout` | 超时 |
| `cancelled` | 被取消 |

---

## 优先级队列

调度器内部使用 `PriorityQueue` 实现。高优先级任务先出队，同优先级按 FIFO 排序。

```typescript
const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};
```

队列用有序数组实现，插入时按优先级二分定位，出队时取队首。

**不保证严格公平性**：连续提交 `critical` 任务会长期占用沙箱，`low` 任务可能饥饿。生产场景应混合使用优先级。

---

## 事件系统

调度器在生命周期关键节点触发事件，外部可注册 listener 监听：

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
  | { type: "scheduler:drained" };  // 所有任务完成
```

**事件顺序示例：**

```
task:queued → sandbox:created → task:assigned → task:started → task:completed → sandbox:destroyed → scheduler:drained
```

---

## Scheduler API

### 创建与配置

```typescript
import { createSwarmScheduler } from "@open-vera/harness";
import type { SwarmSchedulerConfig, SandboxProvider } from "@open-vera/harness";

const scheduler = createSwarmScheduler({
  maxConcurrency: 4,                    // 最大并行沙箱数
  provider: mySandboxProvider,          // 沙箱提供者实例
  defaultSandboxOptions: {              // 默认沙箱选项
    image: "ubuntu:22.04",
    cpu: 1,
    memoryMb: 512,
  },
  defaultTimeoutSeconds: 300,           // 默认超时 5 分钟
  pollIntervalMs: 100,                  // 轮询间隔 100ms
  autoDestroy: true,                    // 执行完毕自动销毁沙箱
  budgetLimit: 100,                     // 预算限制（耗时秒数，0=无限制）
});
```

**配置字段：**

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `maxConcurrency` | number | （必填） | 最大并发沙箱数 |
| `provider` | SandboxProvider | （必填） | 沙箱提供者 |
| `defaultSandboxOptions` | object | `{}` | 默认沙箱创建选项 |
| `defaultTimeoutSeconds` | number | `300` | 默认任务超时（秒） |
| `pollIntervalMs` | number | `100` | 轮询间隔（毫秒） |
| `autoDestroy` | boolean | `true` | 任务完成后自动销毁沙箱 |
| `budgetLimit` | number | `0` | 预算上限（单位：秒，0=无限） |

### 提交任务

```typescript
// 单个任务
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

// 批量提交
const taskIds = scheduler.submitBatch([
  { name: "lint", command: "npm run lint", priority: "high" },
  { name: "test-a", command: "npm test module-a", priority: "normal" },
  { name: "test-b", command: "npm test module-b", priority: "normal" },
]);
```

`submit` 返回 task ID。如果未提供 `id`，自动生成 `task-1`, `task-2`, ...。

### 获取结果

```typescript
// 获取单个结果
const result = scheduler.getResult(taskId);
if (result) {
  console.log(result.stdout);
  console.log(`Duration: ${result.durationMs}ms`);
}

// 获取所有结果
const allResults = scheduler.getResults();

// 等待全部完成
const results = await scheduler.waitForAll();
for (const r of results) {
  console.log(`${r.taskName}: ${r.status} (${r.durationMs}ms)`);
}

// 等待单个任务
const result = await scheduler.waitForTask(taskId);
```

### 状态查询

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

### 取消与关闭

```typescript
// 取消单个任务
scheduler.cancel(taskId);
// 如果任务在队列中 → 直接移除
// 如果任务正在执行 → 销毁其沙箱（强制中止）

// 关闭调度器（取消所有排队任务，销毁所有沙箱）
await scheduler.shutdown();
```

### 事件监听

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

## 任务拆分 (TaskSplitter)

`TaskSplitter` 自动将大任务拆分为可并行的子任务。

### 内置策略

#### FileBatchSplitStrategy

按文件数量分批。当 `task.files.length > batchSize`（默认 10）时触发。

```typescript
import { FileBatchSplitStrategy } from "@open-vera/harness";

const strategy = new FileBatchSplitStrategy(10);
// 100 个文件 → 10 个子任务（每批 10 个文件）
```

#### ContentBatchSplitStrategy

按内容片段数量分批。当 `task.contents.length > batchSize`（默认 10）时触发。

```typescript
import { ContentBatchSplitStrategy } from "@open-vera/harness";

const strategy = new ContentBatchSplitStrategy(10);
```

#### ParallelCommandSplitStrategy

将用 `;` 分隔的独立命令拆分为并行子任务。注意：`&&` 连接的命令不拆分（存在依赖关系）。

```typescript
import { ParallelCommandSplitStrategy } from "@open-vera/harness";

// "lint; test; build" → 3 个独立子任务
// "lint && test" → 不拆分
```

分号拆分时正确处理引号内的分号，避免误拆分。

#### CustomSplitStrategy

用户自定义拆分逻辑：

```typescript
import { CustomSplitStrategy } from "@open-vera/harness";

const strategy = new CustomSplitStrategy(
  "my-strategy",
  (task) => task.name.includes("batch"),       // predicate：是否可拆分
  (task) => [/* ...SwarmTask[] */],             // splitter：拆分为子任务
);
```

### 使用

```typescript
import { TaskSplitter } from "@open-vera/harness";

const splitter = new TaskSplitter({
  strategies: [
    new FileBatchSplitStrategy(5),
    new ParallelCommandSplitStrategy(),
  ],
  maxSubTasks: 20,      // 最多拆成 20 个子任务
  splitThreshold: 2,    // 任务复杂度 < 2 时不拆分
});

const result = splitter.trySplit(myTask);
if (result) {
  console.log(`Split into ${result.subTasks.length} sub-tasks via ${result.strategy}`);
  // 将子任务批量提交
  scheduler.submitBatch(result.subTasks);
}
```

**任务复杂度估算：** `1 + files.length + contents.length + (2 if multi-command)`，小于 `splitThreshold` 的任务不触发拆分。

---

## 结果合并 (ResultMerger)

`ResultMerger` 将并行执行的子任务结果合并为统一的输出。

### 内置策略

#### ConcatMergeStrategy（默认）

拼接所有子任务的 stdout/stderr，适合文本输出类任务。

```typescript
import { ConcatMergeStrategy } from "@open-vera/harness";

// stdout:
// [test-a] tests passed: 42/42
// [test-b] tests passed: 18/18
```

**MergedResult 状态：**
- 全部成功 → `"completed"`
- 部分失败 → `"partial"`
- 全部失败 → `"failed"`

`totalDurationMs` 是所有子任务耗时之和，`wallClockDurationMs` 是最大子任务耗时（反映并行执行的真实墙钟时间）。

#### ReportMergeStrategy

生成结构化的 Markdown 表格报告：

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

### 使用

```typescript
import { ResultMerger, ConcatMergeStrategy, ReportMergeStrategy } from "@open-vera/harness";

const merger = new ResultMerger({
  strategies: [new ConcatMergeStrategy(), new ReportMergeStrategy()],
  defaultStrategy: "concat",
});

const results = await scheduler.waitForAll();
const merged = merger.merge(results);
console.log(merged.summary);  // "42/42 tasks completed"
console.log(merged.stdout);   // 合并后的输出

// 指定策略合并
const report = merger.mergeWith(results, "report");
```

---

## 典型工作流

### 并行测试

```typescript
import { createSwarmScheduler, TaskSplitter, ResultMerger } from "@open-vera/harness";

// 1. 初始化
const scheduler = createSwarmScheduler({
  maxConcurrency: 4,
  provider: sandboxProvider,
  autoDestroy: true,
});

const splitter = new TaskSplitter();
const merger = new ResultMerger({ defaultStrategy: "concat" });

// 2. 拆分任务
const task = {
  name: "test-suite",
  command: "npm test -- --filter=$MODULE",
  priority: "normal" as const,
  files: testFileList.map((f) => ({ localPath: f, remotePath: `/src/${f}` })),
  maxRetries: 1,
};
const split = splitter.trySplit(task);

// 3. 提交执行
if (split) {
  scheduler.submitBatch(split.subTasks);
} else {
  scheduler.submit(task);
}

// 4. 等待完成
const results = await scheduler.waitForAll();

// 5. 合并结果
const merged = merger.merge(results);
console.log(merged.summary);
```

### 事件驱动监控

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

### 预算控制

```typescript
const scheduler = createSwarmScheduler({
  maxConcurrency: 8,
  provider: sandboxProvider,
  budgetLimit: 3600, // 总执行时间不超过 1 小时（秒）
});

// 当累计执行时间超过 budgetLimit 时，调度器自动停止分配新任务
```

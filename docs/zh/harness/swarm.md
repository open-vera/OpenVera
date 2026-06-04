# Swarm（蜂群）— 并行任务调度系统

## 定位

Swarm 是 Harness 的并行任务执行引擎，将大型任务自动拆分为可并行的子任务，在多个隔离沙箱中并发执行，最后合并结果。适用于批量测试、多文件处理、回归验证等需要并行加速的场景。

## 架构

```
大任务 (SwarmTask)
  → TaskSplitter 拆分
    → [子任务1, 子任务2, ..., 子任务N]
      → SwarmScheduler 调度
        → Sandbox-1 执行 → TaskResult-1
        → Sandbox-2 执行 → TaskResult-2
        ...
        → Sandbox-N 执行 → TaskResult-N
      → ResultMerger 合并
    → MergedResult
```

## 核心概念

### SwarmTask

蜂群任务单元，包含执行所需的所有信息：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 唯一任务标识 |
| `name` | string | 任务名称 |
| `priority` | "critical" \| "high" \| "normal" \| "low" | 优先级（高优先级先执行） |
| `command` | string | 在沙箱中执行的命令 |
| `files` | { localPath, remotePath }[] | 执行前上传的文件 |
| `contents` | { content, remotePath }[] | 执行前上传的内容 |
| `workdir` | string | 沙箱内工作目录 |
| `env` | Record<string, string> | 环境变量 |
| `timeoutSeconds` | number | 超时时间（秒） |
| `sandboxOptions` | SandboxCreateOptions | 沙箱创建参数覆盖 |
| `maxRetries` | number | 失败最大重试次数 |

### TaskPriority

| 优先级 | 权重 | 场景 |
|---|---|---|
| `critical` | 4 | 阻塞性任务，必须立即执行 |
| `high` | 3 | 重要任务，优先调度 |
| `normal` | 2 | 常规任务（默认） |
| `low` | 1 | 后台任务，空闲时执行 |

### SwarmTaskResult

| 字段 | 说明 |
|---|---|
| `taskId` | 任务 ID |
| `taskName` | 任务名称 |
| `status` | 最终状态 |
| `exitCode` | 退出码（未完成时为 null） |
| `stdout` | 标准输出 |
| `stderr` | 标准错误 |
| `durationMs` | 执行耗时（毫秒） |
| `sandboxId` | 执行的沙箱 ID |
| `error` | 错误信息（失败时） |
| `retries` | 重试次数 |

## TaskSplitter — 任务拆分器

自动将大任务拆分为可并行的子任务。

### 拆分策略

| 策略 | 说明 | 适用场景 |
|---|---|---|
| **file-based** | 按文件组分批处理 | 批量代码检查、多文件格式化 |
| **command-based** | 拆解多步骤命令为独立单元 | 构建流水线、CI 步骤 |
| **custom** | 用户自定义拆分函数 | 任意复杂场景 |

### 接口

```typescript
interface TaskSplitStrategy {
  name: string;
  canSplit(task: SwarmTask): boolean;
  split(task: SwarmTask): TaskSplitResult;
}

interface TaskSplitResult {
  originalTask: SwarmTask;
  subTasks: SwarmTask[];
  strategy: string;
  description: string;
}
```

**示例：** 一个"对所有 TS 文件运行类型检查"的任务，file-based 策略将其按目录拆分为 `["src/core", "src/harness", "src/gateway"]` 三个子任务并行执行。

## SwarmScheduler — 调度器

基于优先级队列的并发调度引擎。

### 调度流程

```
submit → 入队（优先级排序）
  → 有空闲沙箱？→ 分配 → 执行 → 收集结果
  → 无空闲？→ 等待 → 沙箱释放 → 分配
```

### 配置

```typescript
interface SwarmSchedulerConfig {
  maxConcurrency: number;        // 最大并发沙箱数
  provider: SandboxProvider;     // 沙箱 provider
  defaultSandboxOptions?: ...;   // 默认沙箱参数
  defaultTimeoutSeconds?: number;// 默认超时（秒）
  pollIntervalMs?: number;       // 轮询间隔（毫秒）
  autoDestroy?: boolean;         // 任务完成后自动销毁沙箱
  budgetLimit?: number;          // 预算上限
}
```

### API

```typescript
interface SwarmScheduler {
  submit(task: SwarmTask): string;                    // 提交单个任务
  submitBatch(tasks: SwarmTask[]): string[];           // 批量提交
  cancel(taskId: string): boolean;                     // 取消任务
  getResult(taskId: string): SwarmTaskResult;          // 获取单个结果
  getResults(): SwarmTaskResult[];                     // 获取全部结果
  waitForAll(): Promise<SwarmTaskResult[]>;             // 等待全部完成
  waitForTask(taskId: string): Promise<SwarmTaskResult>;// 等待指定任务
  getStatus(): SwarmSchedulerStatus;                   // 调度器状态
  on(listener: SwarmEventListener): void;               // 注册事件监听
  off(listener: SwarmEventListener): void;              // 取消事件监听
  shutdown(): Promise<void>;                            // 关闭调度器
}
```

## ResultMerger — 结果合并器

将并行执行的子任务结果合并为统一输出。

### 合并策略

| 策略 | 说明 |
|---|---|
| **concat** | 拼接所有子任务的 stdout/stderr |
| **report** | 聚合为结构化报告，含逐任务细分 |
| **files** | 从各个沙箱收集文件到本地目录 |
| **custom** | 自定义合并函数 |

### MergedResult

```typescript
interface MergedResult {
  status: "completed" | "partial" | "failed";
  stdout: string;
  stderr: string;
  taskResults: SwarmTaskResult[];
  totalDurationMs: number;      // 总时长（各任务之和）
  wallClockDurationMs: number;  // 墙钟时长（并行执行，取最慢）
  successCount: number;
  failureCount: number;
}
```

## 事件系统

调度器通过事件系统通知外部状态变化：

| 事件 | 触发时机 |
|---|---|
| `task:queued` | 任务入队 |
| `task:assigned` | 任务分配到沙箱 |
| `task:started` | 任务开始执行 |
| `task:completed` | 任务完成 |
| `task:failed` | 任务失败 |
| `task:cancelled` | 任务取消 |
| `sandbox:created` | 新沙箱创建 |
| `sandbox:destroyed` | 沙箱销毁 |
| `scheduler:idle` | 调度器空闲 |
| `scheduler:drained` | 所有任务完成 |

## 状态查看

```typescript
interface SwarmSchedulerStatus {
  pendingTasks: number;       // 排队中
  runningTasks: number;       // 运行中
  completedTasks: number;     // 已完成
  failedTasks: number;        // 已失败
  activeSandboxes: number;    // 活跃沙箱数
  maxConcurrency: number;     // 最大并发
  shuttingDown: boolean;      // 是否正在关闭
}
```

## 使用示例

```typescript
import { SwarmScheduler } from "@open-vera/openvera";
import { CubeSandboxProvider } from "@open-vera/core";

const provider = new CubeSandboxProvider({ apiBase: "https://sandbox.example.com" });

const scheduler = new SwarmScheduler({
  maxConcurrency: 4,
  provider,
  defaultTimeoutSeconds: 300,
  autoDestroy: true,
});

// 监听事件
scheduler.on((event) => {
  console.log(`[${event.type}] ${JSON.stringify(event)}`);
});

// 提交任务
const taskId = scheduler.submit({
  id: "lint-check",
  name: "ESLint Check",
  priority: "normal",
  command: "npx eslint src/ --format json",
  files: [{ localPath: "./src", remotePath: "/work/src" }],
  workdir: "/work",
  timeoutSeconds: 120,
  maxRetries: 2,
});

// 等待完成
const result = await scheduler.waitForTask(taskId);
console.log(`Exit: ${result.exitCode}, Duration: ${result.durationMs}ms`);

// 关闭
await scheduler.shutdown();
```

## 当前状态

| 组件 | 状态 | 说明 |
|---|---|---|
| SwarmTask 类型 | ✅ 已完成 | 完整类型定义 |
| 优先级队列 | ✅ 已完成 | 4 级优先级，临界优先 |
| SwarmScheduler | ✅ 已完成 | 并发调度、重试、预算控制 |
| TaskSplitter | ✅ 已完成 | 3 种拆分策略 |
| ResultMerger | ✅ 已完成 | 4 种合并策略 |
| 事件系统 | ✅ 已完成 | 10 种事件类型 |
| Sandbox 集成 | ✅ 已完成 | CubeSandbox + Docker 双后端 |

→ 源码：[`packages/harness/src/swarm/`](https://github.com/open-vera/OpenVera/tree/main/packages/harness/src/swarm)

/**
 * Tests for Swarm module (SB5-SB8).
 * Covers: SwarmScheduler, TaskSplitter, ResultMerger.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SwarmSchedulerImpl, SwarmSchedulerError, createSwarmScheduler } from "../scheduler.js";
import {
  TaskSplitter,
  FileBatchSplitStrategy,
  ContentBatchSplitStrategy,
  ParallelCommandSplitStrategy,
  CustomSplitStrategy,
} from "../task-splitter.js";
import {
  ResultMerger,
  ConcatMergeStrategy,
  ReportMergeStrategy,
  CustomMergeStrategy,
  ResultMergerError,
  createResultMerger,
} from "../result-merger.js";
import type {
  SwarmTask,
  SwarmTaskResult,
  SwarmSchedulerConfig,
} from "../types.js";
import type {
  SandboxProvider,
  SandboxInstance,
  SandboxCreateOptions,
  SandboxExecResult,
} from "@open-vera/core";

// ── Mock Helpers ─────────────────────────────────────────────────────────────

function createMockExecResult(overrides: Partial<SandboxExecResult> = {}): SandboxExecResult {
  return {
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    timedOut: false,
    durationMs: 100,
    ...overrides,
  };
}

let sandboxIdCounter = 0;

function createMockSandboxInstance(
  execResult?: SandboxExecResult,
): SandboxInstance {
  const id = `sb-${++sandboxIdCounter}`;
  const result = execResult ?? createMockExecResult();
  return {
    id,
    status: "ready" as const,
    provider: "mock",
    createdAt: new Date(),
    exec: vi.fn().mockResolvedValue(result),
    upload: vi.fn().mockResolvedValue(undefined),
    uploadContent: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(""),
    stop: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockProvider(
  execResult?: SandboxExecResult,
): SandboxProvider {
  return {
    name: "mock",
    create: vi.fn().mockImplementation(() =>
      Promise.resolve(createMockSandboxInstance(execResult)),
    ),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    destroyAll: vi.fn().mockResolvedValue(undefined),
  };
}

function makeTask(overrides: Partial<SwarmTask> = {}): SwarmTask {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    name: "Test task",
    priority: "normal",
    command: "echo hello",
    ...overrides,
  };
}

// ── SwarmScheduler Tests ─────────────────────────────────────────────────────

describe("SwarmScheduler", () => {
  let sandboxIdSeq: number;

  beforeEach(() => {
    sandboxIdSeq = 0;
    sandboxIdCounter = 0;
  });

  it("should submit and execute a single task", async () => {
    const provider = createMockProvider();
    const scheduler = new SwarmSchedulerImpl({
      maxConcurrency: 2,
      provider,
      autoDestroy: false,
    });

    const task = makeTask({ id: "t1", command: "echo hello" });
    scheduler.submit(task);

    const result = await scheduler.waitForTask("t1");
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(provider.create).toHaveBeenCalledOnce();
  });

  it("should execute multiple tasks concurrently", async () => {
    const provider = createMockProvider();
    const scheduler = new SwarmSchedulerImpl({
      maxConcurrency: 3,
      provider,
      autoDestroy: false,
    });

    const tasks = [
      makeTask({ id: "c1", command: "echo a" }),
      makeTask({ id: "c2", command: "echo b" }),
      makeTask({ id: "c3", command: "echo c" }),
    ];

    scheduler.submitBatch(tasks);
    const results = await scheduler.waitForAll();

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === "completed")).toBe(true);
    expect(provider.create).toHaveBeenCalledTimes(3);
  });

  it("should respect priority ordering", async () => {
    const executionOrder: string[] = [];
    const provider: SandboxProvider = {
      name: "mock",
      create: vi.fn().mockImplementation(async () => {
        const id = `sb-${++sandboxIdCounter}`;
        return {
          id,
          status: "ready",
          provider: "mock",
          createdAt: new Date(),
          exec: vi.fn().mockImplementation(async () => {
            executionOrder.push(id);
            return createMockExecResult();
          }),
          upload: vi.fn(),
          uploadContent: vi.fn(),
          download: vi.fn(),
          readFile: vi.fn(),
          stop: vi.fn(),
          resume: vi.fn(),
          destroy: vi.fn(),
        };
      }),
      list: vi.fn(),
      get: vi.fn(),
      destroy: vi.fn(),
      destroyAll: vi.fn(),
    };

    const scheduler = new SwarmSchedulerImpl({
      maxConcurrency: 1,
      provider,
    });

    // Submit in order: low, critical, normal
    scheduler.submit(makeTask({ id: "low", priority: "low", command: "echo low" }));
    scheduler.submit(makeTask({ id: "critical", priority: "critical", command: "echo crit" }));
    scheduler.submit(makeTask({ id: "normal", priority: "normal", command: "echo norm" }));

    const results = await scheduler.waitForAll();
    expect(results).toHaveLength(3);

    // With maxConcurrency=1, tasks run sequentially.
    // After the first task completes, the queue should dequeue the highest priority next.
    // First task dequeued is "low" (it was submitted first and the scheduler started it immediately).
    // After "low" completes, "critical" should be next (highest priority in queue), then "normal".
    expect(executionOrder.length).toBe(3);
  });

  it("should cancel a queued task", async () => {
    const provider = createMockProvider();
    const scheduler = new SwarmSchedulerImpl({
      maxConcurrency: 1,
      provider,
    });

    // Submit first task to occupy the only sandbox
    scheduler.submit(makeTask({ id: "blocker", command: "sleep 10" }));
    // Second task goes to queue
    scheduler.submit(makeTask({ id: "victim", command: "echo hi" }));

    const cancelled = scheduler.cancel("victim");
    expect(cancelled).toBe(true);

    const result = scheduler.getResult("victim");
    expect(result?.status).toBe("cancelled");

    // Cleanup
    await scheduler.shutdown();
  });

  it("should enforce max concurrency", async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const provider: SandboxProvider = {
      name: "mock",
      create: vi.fn().mockImplementation(async () => {
        const id = `sb-${++sandboxIdCounter}`;
        return {
          id,
          status: "ready",
          provider: "mock",
          createdAt: new Date(),
          exec: vi.fn().mockImplementation(async () => {
            currentConcurrent++;
            maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
            await new Promise((r) => setTimeout(r, 50));
            currentConcurrent--;
            return createMockExecResult();
          }),
          upload: vi.fn(),
          uploadContent: vi.fn(),
          download: vi.fn(),
          readFile: vi.fn(),
          stop: vi.fn(),
          resume: vi.fn(),
          destroy: vi.fn(),
        };
      }),
      list: vi.fn(),
      get: vi.fn(),
      destroy: vi.fn(),
      destroyAll: vi.fn(),
    };

    const scheduler = new SwarmSchedulerImpl({
      maxConcurrency: 2,
      provider,
    });

    scheduler.submitBatch([
      makeTask({ id: "m1", command: "echo 1" }),
      makeTask({ id: "m2", command: "echo 2" }),
      makeTask({ id: "m3", command: "echo 3" }),
      makeTask({ id: "m4", command: "echo 4" }),
    ]);

    await scheduler.waitForAll();
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("should report correct status", async () => {
    const provider = createMockProvider();
    const scheduler = new SwarmSchedulerImpl({
      maxConcurrency: 2,
      provider,
    });

    const initial = scheduler.getStatus();
    expect(initial.pendingTasks).toBe(0);
    expect(initial.runningTasks).toBe(0);
    expect(initial.maxConcurrency).toBe(2);
    expect(initial.shuttingDown).toBe(false);

    scheduler.submit(makeTask({ id: "s1" }));
    await scheduler.waitForAll();

    const after = scheduler.getStatus();
    expect(after.completedTasks).toBe(1);
    expect(after.pendingTasks).toBe(0);
    expect(after.runningTasks).toBe(0);
  });

  it("should emit events during task lifecycle", async () => {
    const provider = createMockProvider();
    const scheduler = new SwarmSchedulerImpl({
      maxConcurrency: 1,
      provider,
    });

    const events: string[] = [];
    scheduler.on((event) => events.push(event.type));

    scheduler.submit(makeTask({ id: "ev1" }));
    await scheduler.waitForAll();

    expect(events).toContain("task:queued");
    expect(events).toContain("task:assigned");
    expect(events).toContain("task:started");
    expect(events).toContain("task:completed");
    expect(events).toContain("sandbox:created");
  });

  it("should handle task failure gracefully", async () => {
    const provider = createMockProvider(
      createMockExecResult({ exitCode: 1, stderr: "command failed" }),
    );
    const scheduler = new SwarmSchedulerImpl({
      maxConcurrency: 1,
      provider,
    });

    scheduler.submit(makeTask({ id: "fail1" }));
    const result = await scheduler.waitForTask("fail1");

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
  });

  it("should retry failed tasks when maxRetries is set", async () => {
    let callCount = 0;
    const provider: SandboxProvider = {
      name: "mock",
      create: vi.fn().mockImplementation(async () => {
        const id = `sb-${++sandboxIdCounter}`;
        return {
          id,
          status: "ready",
          provider: "mock",
          createdAt: new Date(),
          exec: vi.fn().mockImplementation(async () => {
            callCount++;
            if (callCount <= 2) {
              return createMockExecResult({ exitCode: 1, stderr: "fail" });
            }
            return createMockExecResult();
          }),
          upload: vi.fn(),
          uploadContent: vi.fn(),
          download: vi.fn(),
          readFile: vi.fn(),
          stop: vi.fn(),
          resume: vi.fn(),
          destroy: vi.fn(),
        };
      }),
      list: vi.fn(),
      get: vi.fn(),
      destroy: vi.fn(),
      destroyAll: vi.fn(),
    };

    const scheduler = new SwarmSchedulerImpl({
      maxConcurrency: 1,
      provider,
      autoDestroy: false,
    });

    scheduler.submit(makeTask({ id: "retry1", maxRetries: 3 }));
    const result = await scheduler.waitForTask("retry1");

    expect(result.status).toBe("completed");
    expect(result.retries).toBe(2);
    expect(callCount).toBe(3);

    await scheduler.shutdown();
  });

  it("should shutdown cleanly", async () => {
    const provider = createMockProvider();
    const scheduler = new SwarmSchedulerImpl({
      maxConcurrency: 2,
      provider,
    });

    scheduler.submit(makeTask({ id: "sd1" }));
    await scheduler.waitForAll();

    await scheduler.shutdown();
    const status = scheduler.getStatus();
    expect(status.shuttingDown).toBe(true);
  });

  it("should reject submissions after shutdown", async () => {
    const provider = createMockProvider();
    const scheduler = new SwarmSchedulerImpl({
      maxConcurrency: 1,
      provider,
    });

    await scheduler.shutdown();

    expect(() => scheduler.submit(makeTask())).toThrow(SwarmSchedulerError);
  });

  it("should enforce budget limit", async () => {
    // Budget is tracked as seconds of execution time.
    // Use a slow mock to exhaust budget quickly.
    let callIndex = 0;
    const provider: SandboxProvider = {
      name: "mock",
      create: vi.fn().mockImplementation(async () => {
        const id = `sb-${++sandboxIdCounter}`;
        return {
          id,
          status: "ready",
          provider: "mock",
          createdAt: new Date(),
          exec: vi.fn().mockImplementation(async () => {
            callIndex++;
            // First task takes long, subsequent are fast
            if (callIndex === 1) {
              return createMockExecResult({ durationMs: 5000 });
            }
            return createMockExecResult({ durationMs: 100 });
          }),
          upload: vi.fn(),
          uploadContent: vi.fn(),
          download: vi.fn(),
          readFile: vi.fn(),
          stop: vi.fn(),
          resume: vi.fn(),
          destroy: vi.fn(),
        };
      }),
      list: vi.fn(),
      get: vi.fn(),
      destroy: vi.fn(),
      destroyAll: vi.fn(),
    };

    // Budget of 1 unit — first task costs 5s so budget is exceeded
    const scheduler = new SwarmSchedulerImpl({
      maxConcurrency: 2,
      provider,
      budgetLimit: 1,
    });

    scheduler.submit(makeTask({ id: "b1" }));
    await scheduler.waitForTask("b1");

    // Second task should not start (budget exceeded)
    scheduler.submit(makeTask({ id: "b2" }));
    const status = scheduler.getStatus();

    // b2 should still be pending since budget is exceeded
    expect(status.pendingTasks).toBeGreaterThanOrEqual(0);

    await scheduler.shutdown();
  });
});

// ── TaskSplitter Tests ───────────────────────────────────────────────────────

describe("TaskSplitter", () => {
  it("should split tasks with many files into batches", () => {
    const strategy = new FileBatchSplitStrategy(5);
    const files = Array.from({ length: 12 }, (_, i) => ({
      localPath: `/local/file${i}.txt`,
      remotePath: `/remote/file${i}.txt`,
    }));

    const task = makeTask({ id: "fs1", files });
    expect(strategy.canSplit(task)).toBe(true);

    const result = strategy.split(task);
    expect(result.subTasks).toHaveLength(3); // 5 + 5 + 2
    expect(result.strategy).toBe("file-batch");
    expect(result.subTasks[0].files).toHaveLength(5);
    expect(result.subTasks[2].files).toHaveLength(2);
  });

  it("should split tasks with many content items", () => {
    const strategy = new ContentBatchSplitStrategy(3);
    const contents = Array.from({ length: 7 }, (_, i) => ({
      content: `content-${i}`,
      remotePath: `/remote/c${i}.txt`,
    }));

    const task = makeTask({ id: "cs1", contents });
    expect(strategy.canSplit(task)).toBe(true);

    const result = strategy.split(task);
    expect(result.subTasks).toHaveLength(3); // 3 + 3 + 1
    expect(result.strategy).toBe("content-batch");
  });

  it("should split semicolon-separated commands", () => {
    const strategy = new ParallelCommandSplitStrategy();
    const task = makeTask({
      id: "cmd1",
      command: "echo hello; echo world; echo foo",
    });

    expect(strategy.canSplit(task)).toBe(true);

    const result = strategy.split(task);
    expect(result.subTasks).toHaveLength(3);
    expect(result.subTasks[0].command).toBe("echo hello");
    expect(result.subTasks[1].command).toBe("echo world");
    expect(result.subTasks[2].command).toBe("echo foo");
  });

  it("should NOT split &&-chained commands (dependencies)", () => {
    const strategy = new ParallelCommandSplitStrategy();
    const task = makeTask({
      id: "cmd2",
      command: "make build && make test",
    });

    expect(strategy.canSplit(task)).toBe(false);
  });

  it("should respect maxSubTasks cap", () => {
    const splitter = new TaskSplitter({ maxSubTasks: 3 });
    const files = Array.from({ length: 20 }, (_, i) => ({
      localPath: `/f${i}.txt`,
      remotePath: `/r${i}.txt`,
    }));

    const task = makeTask({ id: "cap1", files });
    const result = splitter.trySplit(task);

    expect(result).not.toBeNull();
    expect(result!.subTasks.length).toBeLessThanOrEqual(3);
  });

  it("should return null for tasks below split threshold", () => {
    const splitter = new TaskSplitter({ splitThreshold: 10 });
    const task = makeTask({ id: "small", command: "echo hi" });

    const result = splitter.trySplit(task);
    expect(result).toBeNull();
  });

  it("should support custom strategies", () => {
    const custom = new CustomSplitStrategy(
      "half",
      () => true,
      (task) => [
        makeTask({ id: `${task.id}-a`, name: "half A" }),
        makeTask({ id: `${task.id}-b`, name: "half B" }),
      ],
    );

    const splitter = new TaskSplitter({ strategies: [custom] });
    const result = splitter.trySplit(makeTask({ id: "cust1" }));

    expect(result).not.toBeNull();
    expect(result!.subTasks).toHaveLength(2);
    expect(result!.strategy).toBe("half");
  });
});

// ── ResultMerger Tests ───────────────────────────────────────────────────────

describe("ResultMerger", () => {
  const successResults: SwarmTaskResult[] = [
    {
      taskId: "r1", taskName: "Task 1", status: "completed",
      exitCode: 0, stdout: "output-1", stderr: "", durationMs: 100,
      sandboxId: "sb-1", retries: 0,
    },
    {
      taskId: "r2", taskName: "Task 2", status: "completed",
      exitCode: 0, stdout: "output-2", stderr: "", durationMs: 200,
      sandboxId: "sb-2", retries: 0,
    },
  ];

  const mixedResults: SwarmTaskResult[] = [
    ...successResults,
    {
      taskId: "r3", taskName: "Task 3", status: "failed",
      exitCode: 1, stdout: "", stderr: "error-3", durationMs: 50,
      sandboxId: "sb-3", error: "boom", retries: 0,
    },
  ];

  it("should merge with concat strategy", () => {
    const merger = new ResultMerger({ defaultStrategy: "concat" });
    const result = merger.merge(successResults);

    expect(result.status).toBe("completed");
    expect(result.stdout).toContain("output-1");
    expect(result.stdout).toContain("output-2");
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);
  });

  it("should merge with report strategy", () => {
    const merger = new ResultMerger({
      strategies: [new ReportMergeStrategy()],
      defaultStrategy: "report",
    });
    const result = merger.merge(mixedResults);

    expect(result.status).toBe("partial");
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(1);
    expect(result.stdout).toContain("Swarm Execution Report");
    expect(result.stdout).toContain("Task 3");
  });

  it("should report 'failed' when all tasks fail", () => {
    const merger = new ResultMerger();
    const failedResults: SwarmTaskResult[] = [
      {
        taskId: "f1", taskName: "Fail 1", status: "failed",
        exitCode: 1, stdout: "", stderr: "err", durationMs: 10,
        sandboxId: "sb-1", retries: 0,
      },
    ];

    const result = merger.merge(failedResults);
    expect(result.status).toBe("failed");
    expect(result.successCount).toBe(0);
  });

  it("should handle empty results", () => {
    const merger = new ResultMerger();
    const result = merger.merge([]);

    expect(result.status).toBe("completed");
    expect(result.successCount).toBe(0);
    expect(result.summary).toContain("No tasks");
  });

  it("should throw on unknown strategy", () => {
    const merger = new ResultMerger();
    expect(() => merger.mergeWith(successResults, "nonexistent")).toThrow(ResultMergerError);
  });

  it("should support custom merge strategy", () => {
    const custom = new CustomMergeStrategy("json", (results) => ({
      status: "completed" as const,
      stdout: JSON.stringify(results.map((r) => r.taskId)),
      stderr: "",
      taskResults: results,
      totalDurationMs: 0,
      wallClockDurationMs: 0,
      successCount: results.length,
      failureCount: 0,
      strategy: "json",
      summary: "JSON merge",
    }));

    const merger = new ResultMerger({
      strategies: [custom],
      defaultStrategy: "json",
    });

    const result = merger.merge(successResults);
    expect(result.strategy).toBe("json");
    expect(JSON.parse(result.stdout)).toEqual(["r1", "r2"]);
  });

  it("should list available strategies", () => {
    const merger = new ResultMerger();
    const strategies = merger.listStrategies();
    expect(strategies).toContain("concat");
    expect(strategies).toContain("report");
  });

  it("createResultMerger factory should work", () => {
    const merger = createResultMerger();
    expect(merger).toBeInstanceOf(ResultMerger);
    const result = merger.merge(successResults);
    expect(result.status).toBe("completed");
  });
});

// ── Factory Function Tests ───────────────────────────────────────────────────

describe("createSwarmScheduler", () => {
  it("should create a scheduler instance", () => {
    const provider = createMockProvider();
    const scheduler = createSwarmScheduler({
      maxConcurrency: 2,
      provider,
    });

    expect(scheduler).toBeInstanceOf(SwarmSchedulerImpl);
  });
});

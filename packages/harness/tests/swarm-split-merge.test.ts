/**
 * Task Splitter & Result Merger Tests
 */

import { describe, it, expect } from "vitest";
import type { SwarmTask, SwarmTaskResult } from "../src/swarm/types.js";
import {
  TaskSplitter,
  FileBatchSplitStrategy,
  ContentBatchSplitStrategy,
  ParallelCommandSplitStrategy,
  CustomSplitStrategy,
} from "../src/swarm/task-splitter.js";
import {
  ResultMerger,
  ConcatMergeStrategy,
  ReportMergeStrategy,
  CustomMergeStrategy,
  ResultMergerError,
} from "../src/swarm/result-merger.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTask(overrides: Partial<SwarmTask> = {}): SwarmTask {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: "test-task",
    priority: "normal",
    command: "echo hello",
    ...overrides,
  };
}

function createResult(overrides: Partial<SwarmTaskResult> = {}): SwarmTaskResult {
  return {
    taskId: "task-1",
    taskName: "test-task",
    status: "completed",
    exitCode: 0,
    stdout: "output",
    stderr: "",
    durationMs: 100,
    sandboxId: "sandbox-1",
    retries: 0,
    ...overrides,
  };
}

// ── FileBatchSplitStrategy ───────────────────────────────────────────────────

describe("FileBatchSplitStrategy", () => {
  it("should not split tasks with few files", () => {
    const strategy = new FileBatchSplitStrategy(5);
    const task = createTask({
      files: [
        { localPath: "/a.txt", remotePath: "/a.txt" },
        { localPath: "/b.txt", remotePath: "/b.txt" },
      ],
    });
    expect(strategy.canSplit(task)).toBe(false);
  });

  it("should split tasks with many files", () => {
    const strategy = new FileBatchSplitStrategy(5);
    const files = Array.from({ length: 12 }, (_, i) => ({
      localPath: `/file-${i}.txt`,
      remotePath: `/file-${i}.txt`,
    }));
    const task = createTask({ files });

    expect(strategy.canSplit(task)).toBe(true);

    const result = strategy.split(task);
    expect(result.subTasks).toHaveLength(3); // 12 files / batch size 5 = 3 batches
    expect(result.strategy).toBe("file-batch");
    expect(result.subTasks[0].files).toHaveLength(5);
    expect(result.subTasks[1].files).toHaveLength(5);
    expect(result.subTasks[2].files).toHaveLength(2);
  });

  it("should preserve task properties in sub-tasks", () => {
    const strategy = new FileBatchSplitStrategy(3);
    const files = Array.from({ length: 7 }, (_, i) => ({
      localPath: `/f-${i}.txt`,
      remotePath: `/f-${i}.txt`,
    }));
    const task = createTask({
      id: "parent",
      name: "parent-task",
      priority: "high",
      command: "process",
      files,
      workdir: "/work",
      env: { FOO: "bar" },
    });

    const result = strategy.split(task);
    for (const sub of result.subTasks) {
      expect(sub.priority).toBe("high");
      expect(sub.command).toBe("process");
      expect(sub.workdir).toBe("/work");
      expect(sub.env).toEqual({ FOO: "bar" });
      expect(sub.id).toMatch(/^parent-batch-/);
    }
  });
});

// ── ContentBatchSplitStrategy ────────────────────────────────────────────────

describe("ContentBatchSplitStrategy", () => {
  it("should not split tasks with few content items", () => {
    const strategy = new ContentBatchSplitStrategy(5);
    const task = createTask({
      contents: [
        { content: "a", remotePath: "/a.txt" },
        { content: "b", remotePath: "/b.txt" },
      ],
    });
    expect(strategy.canSplit(task)).toBe(false);
  });

  it("should split tasks with many content items", () => {
    const strategy = new ContentBatchSplitStrategy(4);
    const contents = Array.from({ length: 10 }, (_, i) => ({
      content: `content-${i}`,
      remotePath: `/file-${i}.txt`,
    }));
    const task = createTask({ contents });

    expect(strategy.canSplit(task)).toBe(true);

    const result = strategy.split(task);
    expect(result.subTasks).toHaveLength(3); // 10 / 4 = 3 batches
    expect(result.subTasks[0].contents).toHaveLength(4);
    expect(result.subTasks[1].contents).toHaveLength(4);
    expect(result.subTasks[2].contents).toHaveLength(2);
  });
});

// ── ParallelCommandSplitStrategy ─────────────────────────────────────────────

describe("ParallelCommandSplitStrategy", () => {
  it("should not split single commands", () => {
    const strategy = new ParallelCommandSplitStrategy();
    const task = createTask({ command: "echo hello" });
    expect(strategy.canSplit(task)).toBe(false);
  });

  it("should not split && commands (they are dependent)", () => {
    const strategy = new ParallelCommandSplitStrategy();
    const task = createTask({ command: "make && make install" });
    expect(strategy.canSplit(task)).toBe(false);
  });

  it("should split semicolon-separated independent commands", () => {
    const strategy = new ParallelCommandSplitStrategy();
    const task = createTask({ command: "echo a; echo b; echo c" });

    expect(strategy.canSplit(task)).toBe(true);

    const result = strategy.split(task);
    expect(result.subTasks).toHaveLength(3);
    expect(result.subTasks[0].command).toBe("echo a");
    expect(result.subTasks[1].command).toBe("echo b");
    expect(result.subTasks[2].command).toBe("echo c");
  });

  it("should handle quoted semicolons correctly", () => {
    const strategy = new ParallelCommandSplitStrategy();
    const task = createTask({ command: `echo "hello; world"; echo bye` });

    expect(strategy.canSplit(task)).toBe(true);

    const result = strategy.split(task);
    expect(result.subTasks).toHaveLength(2);
    expect(result.subTasks[0].command).toBe('echo "hello; world"');
    expect(result.subTasks[1].command).toBe("echo bye");
  });
});

// ── CustomSplitStrategy ──────────────────────────────────────────────────────

describe("CustomSplitStrategy", () => {
  it("should use custom predicate and splitter", () => {
    const strategy = new CustomSplitStrategy(
      "range-split",
      (task) => task.command.startsWith("process-range"),
      (task) => [
        { ...task, id: `${task.id}-1`, command: `${task.command} --range 0-50` },
        { ...task, id: `${task.id}-2`, command: `${task.command} --range 50-100` },
      ],
    );

    const task = createTask({ command: "process-range data.csv" });
    expect(strategy.canSplit(task)).toBe(true);

    const result = strategy.split(task);
    expect(result.subTasks).toHaveLength(2);
    expect(result.strategy).toBe("range-split");
  });

  it("should reject non-matching tasks", () => {
    const strategy = new CustomSplitStrategy(
      "range-split",
      (task) => task.command.startsWith("process-range"),
      (task) => [task],
    );

    const task = createTask({ command: "echo hello" });
    expect(strategy.canSplit(task)).toBe(false);
  });
});

// ── TaskSplitter ─────────────────────────────────────────────────────────────

describe("TaskSplitter", () => {
  it("should try strategies in order and return first match", () => {
    const splitter = new TaskSplitter({
      strategies: [
        new FileBatchSplitStrategy(3),
        new ParallelCommandSplitStrategy(),
      ],
      splitThreshold: 1,
    });

    const task = createTask({
      command: "echo a; echo b",
      files: Array.from({ length: 5 }, (_, i) => ({
        localPath: `/f-${i}.txt`,
        remotePath: `/f-${i}.txt`,
      })),
    });

    // FileBatchSplitStrategy should match first (5 files > 3)
    const result = splitter.trySplit(task);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("file-batch");
  });

  it("should return null for tasks below threshold", () => {
    const splitter = new TaskSplitter({ splitThreshold: 100 });
    const task = createTask({ command: "echo hello" });
    expect(splitter.trySplit(task)).toBeNull();
  });

  it("should cap sub-tasks at maxSubTasks", () => {
    const splitter = new TaskSplitter({
      strategies: [new FileBatchSplitStrategy(1)],
      maxSubTasks: 3,
      splitThreshold: 1,
    });

    const files = Array.from({ length: 10 }, (_, i) => ({
      localPath: `/f-${i}.txt`,
      remotePath: `/f-${i}.txt`,
    }));
    const task = createTask({ files });

    const result = splitter.trySplit(task);
    expect(result).not.toBeNull();
    expect(result!.subTasks.length).toBeLessThanOrEqual(3);
  });

  it("should support adding strategies at runtime", () => {
    const splitter = new TaskSplitter({ strategies: [], splitThreshold: 1 });
    expect(splitter.trySplit(createTask())).toBeNull();

    splitter.addStrategy(new ParallelCommandSplitStrategy());
    const task = createTask({ command: "echo a; echo b" });
    expect(splitter.trySplit(task)).not.toBeNull();
  });

  it("should split with specific strategy", () => {
    const splitter = new TaskSplitter({
      strategies: [
        new FileBatchSplitStrategy(3),
        new ParallelCommandSplitStrategy(),
      ],
      splitThreshold: 1,
    });

    const task = createTask({ command: "echo a; echo b" });
    const result = splitter.splitWith(task, "parallel-command");
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("parallel-command");
    expect(result!.subTasks).toHaveLength(2);
  });
});

// ── ConcatMergeStrategy ──────────────────────────────────────────────────────

describe("ConcatMergeStrategy", () => {
  it("should merge all results with concatenation", () => {
    const strategy = new ConcatMergeStrategy();
    const results = [
      createResult({ taskId: "t1", taskName: "task-1", stdout: "out1" }),
      createResult({ taskId: "t2", taskName: "task-2", stdout: "out2" }),
    ];

    const merged = strategy.merge(results);
    expect(merged.status).toBe("completed");
    expect(merged.stdout).toContain("[task-1] out1");
    expect(merged.stdout).toContain("[task-2] out2");
    expect(merged.successCount).toBe(2);
    expect(merged.failureCount).toBe(0);
  });

  it("should report partial status when some tasks fail", () => {
    const strategy = new ConcatMergeStrategy();
    const results = [
      createResult({ taskId: "t1", status: "completed" }),
      createResult({ taskId: "t2", status: "failed", stderr: "error" }),
    ];

    const merged = strategy.merge(results);
    expect(merged.status).toBe("partial");
    expect(merged.successCount).toBe(1);
    expect(merged.failureCount).toBe(1);
  });

  it("should report failed status when all tasks fail", () => {
    const strategy = new ConcatMergeStrategy();
    const results = [
      createResult({ taskId: "t1", status: "failed" }),
      createResult({ taskId: "t2", status: "failed" }),
    ];

    const merged = strategy.merge(results);
    expect(merged.status).toBe("failed");
    expect(merged.successCount).toBe(0);
  });
});

// ── ReportMergeStrategy ──────────────────────────────────────────────────────

describe("ReportMergeStrategy", () => {
  it("should produce a structured report", () => {
    const strategy = new ReportMergeStrategy();
    const results = [
      createResult({
        taskId: "t1",
        taskName: "build-frontend",
        status: "completed",
        durationMs: 5000,
      }),
      createResult({
        taskId: "t2",
        taskName: "build-backend",
        status: "completed",
        durationMs: 3000,
      }),
    ];

    const merged = strategy.merge(results);
    expect(merged.status).toBe("completed");
    expect(merged.stdout).toContain("Swarm Execution Report");
    expect(merged.stdout).toContain("build-frontend");
    expect(merged.stdout).toContain("build-backend");
    expect(merged.wallClockDurationMs).toBe(5000);
    expect(merged.totalDurationMs).toBe(8000);
  });

  it("should include failure details in report", () => {
    const strategy = new ReportMergeStrategy();
    const results = [
      createResult({ taskId: "t1", taskName: "task-ok", status: "completed" }),
      createResult({
        taskId: "t2",
        taskName: "task-fail",
        status: "failed",
        error: "timeout",
        stderr: "timed out",
      }),
    ];

    const merged = strategy.merge(results);
    expect(merged.stdout).toContain("Failed Tasks");
    expect(merged.stdout).toContain("task-fail");
  });
});

// ── ResultMerger ─────────────────────────────────────────────────────────────

describe("ResultMerger", () => {
  it("should merge with default strategy", () => {
    const merger = new ResultMerger();
    const results = [createResult()];

    const merged = merger.merge(results);
    expect(merged.strategy).toBe("concat");
  });

  it("should merge with specified strategy", () => {
    const merger = new ResultMerger();
    const results = [createResult()];

    const merged = merger.mergeWith(results, "report");
    expect(merged.strategy).toBe("report");
    expect(merged.stdout).toContain("Swarm Execution Report");
  });

  it("should handle empty results", () => {
    const merger = new ResultMerger();
    const merged = merger.merge([]);
    expect(merged.status).toBe("completed");
    expect(merged.summary).toBe("No tasks to merge");
  });

  it("should throw for unknown strategy", () => {
    const merger = new ResultMerger();
    expect(() => merger.mergeWith([createResult()], "unknown")).toThrow(ResultMergerError);
  });

  it("should support adding strategies at runtime", () => {
    const merger = new ResultMerger({ strategies: [] });

    merger.addStrategy(
      new CustomMergeStrategy("sum", (results) => ({
        status: "completed",
        stdout: `Total: ${results.length}`,
        stderr: "",
        taskResults: results,
        totalDurationMs: 0,
        wallClockDurationMs: 0,
        successCount: results.length,
        failureCount: 0,
        strategy: "sum",
        summary: `${results.length} tasks`,
      })),
    );

    expect(merger.listStrategies()).toContain("sum");

    const merged = merger.mergeWith([createResult()], "sum");
    expect(merged.stdout).toBe("Total: 1");
  });

  it("should list available strategies", () => {
    const merger = new ResultMerger();
    const strategies = merger.listStrategies();
    expect(strategies).toContain("concat");
    expect(strategies).toContain("report");
  });
});

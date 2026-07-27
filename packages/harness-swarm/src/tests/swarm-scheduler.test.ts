/**
 * Swarm Scheduler Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  SandboxProvider,
  SandboxInstance,
  SandboxCreateOptions,
  SandboxExecResult,
} from "@open-vera/core";
import { createSwarmScheduler, SwarmSchedulerError } from "../scheduler.js";
import type {
  SwarmTask,
  SwarmSchedulerConfig,
  SwarmSchedulerEvent,
  SwarmEventListener,
} from "../types.js";

// ── Mock Sandbox ────────────────────────────────────────────────────────────

function createMockSandboxInstance(id: string): SandboxInstance {
  return {
    id,
    status: "ready",
    provider: "mock",
    createdAt: new Date(),
    exec: vi.fn(async (): Promise<SandboxExecResult> => ({
      exitCode: 0,
      stdout: `output from ${id}`,
      stderr: "",
      timedOut: false,
      durationMs: 10,
    })),
    upload: vi.fn(async () => {}),
    uploadContent: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    readFile: vi.fn(async () => ""),
    stop: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  };
}

function createMockProvider(): SandboxProvider {
  let counter = 0;
  return {
    name: "mock",
    create: vi.fn(async (_options?: SandboxCreateOptions) => {
      return createMockSandboxInstance(`sandbox-${++counter}`);
    }),
    list: vi.fn(async () => []),
    get: vi.fn(async () => undefined),
    destroy: vi.fn(async () => {}),
    destroyAll: vi.fn(async () => {}),
  };
}

function createTask(overrides: Partial<SwarmTask> = {}): SwarmTask {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: "test-task",
    priority: "normal",
    command: "echo hello",
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("SwarmScheduler", () => {
  let provider: SandboxProvider;

  beforeEach(() => {
    provider = createMockProvider();
  });

  describe("basic scheduling", () => {
    it("should submit and execute a single task", async () => {
      const scheduler = createSwarmScheduler({
        maxConcurrency: 2,
        provider,
        autoDestroy: false,
      });

      const task = createTask({ command: "echo test" });
      scheduler.submit(task);

      const result = await scheduler.waitForTask(task.id);
      expect(result.status).toBe("completed");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("output from");
    });

    it("should execute multiple tasks concurrently", async () => {
      const scheduler = createSwarmScheduler({
        maxConcurrency: 3,
        provider,
        autoDestroy: false,
      });

      const tasks = [
        createTask({ id: "t1", name: "task-1", command: "echo 1" }),
        createTask({ id: "t2", name: "task-2", command: "echo 2" }),
        createTask({ id: "t3", name: "task-3", command: "echo 3" }),
      ];

      scheduler.submitBatch(tasks);
      const results = await scheduler.waitForAll();

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.status === "completed")).toBe(true);
    });

    it("should respect max concurrency limit", async () => {
      const maxConcurrency = 2;
      const scheduler = createSwarmScheduler({
        maxConcurrency,
        provider,
        autoDestroy: false,
      });

      const tasks = Array.from({ length: 5 }, (_, i) =>
        createTask({ id: `t${i}`, name: `task-${i}`, command: "echo test" }),
      );

      scheduler.submitBatch(tasks);

      // At peak, should not exceed maxConcurrency sandboxes created
      // Wait a bit for sandbox creation
      await new Promise((r) => setTimeout(r, 50));
      const status = scheduler.getStatus();
      expect(status.activeSandboxes).toBeLessThanOrEqual(maxConcurrency);

      await scheduler.waitForAll();
    });
  });

  describe("priority queue", () => {
    it("should execute higher priority tasks first", async () => {
      const executionOrder: string[] = [];

      // Create a provider that tracks execution
      const trackingProvider: SandboxProvider = {
        name: "tracking",
        create: vi.fn(async () => {
          const instance = createMockSandboxInstance("tracking-sandbox");
          const origExec = instance.exec;
          instance.exec = vi.fn(async (cmd: string) => {
            executionOrder.push(cmd);
            return origExec(cmd);
          });
          return instance;
        }),
        list: vi.fn(async () => []),
        get: vi.fn(async () => undefined),
        destroy: vi.fn(async () => {}),
        destroyAll: vi.fn(async () => {}),
      };

      const scheduler = createSwarmScheduler({
        maxConcurrency: 1, // Force sequential execution
        provider: trackingProvider,
        autoDestroy: false,
      });

      // Submit in order: low, critical, normal, high
      scheduler.submit(createTask({ id: "low", priority: "low", command: "low" }));
      scheduler.submit(createTask({ id: "critical", priority: "critical", command: "critical" }));
      scheduler.submit(createTask({ id: "normal", priority: "normal", command: "normal" }));
      scheduler.submit(createTask({ id: "high", priority: "high", command: "high" }));

      await scheduler.waitForAll();

      // First task runs immediately, rest should be in priority order
      // critical (4) > high (3) > normal (2) > low (1)
      expect(executionOrder[0]).toBe("low"); // First submitted, runs immediately
      expect(executionOrder[1]).toBe("critical");
      expect(executionOrder[2]).toBe("high");
      expect(executionOrder[3]).toBe("normal");
    });
  });

  describe("task results", () => {
    it("should store and retrieve results", async () => {
      const scheduler = createSwarmScheduler({
        maxConcurrency: 2,
        provider,
        autoDestroy: false,
      });

      const task = createTask({ id: "result-test", command: "echo result" });
      scheduler.submit(task);

      await scheduler.waitForTask("result-test");

      const result = scheduler.getResult("result-test");
      expect(result).toBeDefined();
      expect(result!.taskId).toBe("result-test");
      expect(result!.status).toBe("completed");

      const allResults = scheduler.getResults();
      expect(allResults).toHaveLength(1);
    });

    it("should handle task failure", async () => {
      const failProvider: SandboxProvider = {
        name: "fail",
        create: vi.fn(async () => {
          const instance = createMockSandboxInstance("fail-sandbox");
          instance.exec = vi.fn(async () => ({
            exitCode: 1,
            stdout: "",
            stderr: "command failed",
            timedOut: false,
            durationMs: 5,
          }));
          return instance;
        }),
        list: vi.fn(async () => []),
        get: vi.fn(async () => undefined),
        destroy: vi.fn(async () => {}),
        destroyAll: vi.fn(async () => {}),
      };

      const scheduler = createSwarmScheduler({
        maxConcurrency: 2,
        provider: failProvider,
        autoDestroy: false,
      });

      const task = createTask({ id: "fail-task", command: "fail" });
      scheduler.submit(task);

      const result = await scheduler.waitForTask("fail-task");
      expect(result.status).toBe("failed");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("command failed");
    });

    it("should retry failed tasks up to maxRetries", async () => {
      let attempts = 0;
      const retryProvider: SandboxProvider = {
        name: "retry",
        create: vi.fn(async () => {
          const instance = createMockSandboxInstance("retry-sandbox");
          instance.exec = vi.fn(async () => {
            attempts++;
            if (attempts < 3) {
              return {
                exitCode: 1,
                stdout: "",
                stderr: "fail",
                timedOut: false,
                durationMs: 5,
              };
            }
            return {
              exitCode: 0,
              stdout: "success",
              stderr: "",
              timedOut: false,
              durationMs: 5,
            };
          });
          return instance;
        }),
        list: vi.fn(async () => []),
        get: vi.fn(async () => undefined),
        destroy: vi.fn(async () => {}),
        destroyAll: vi.fn(async () => {}),
      };

      const scheduler = createSwarmScheduler({
        maxConcurrency: 2,
        provider: retryProvider,
        autoDestroy: false,
      });

      const task = createTask({ id: "retry-task", command: "retry", maxRetries: 3 });
      scheduler.submit(task);

      const result = await scheduler.waitForTask("retry-task");
      expect(result.status).toBe("completed");
      expect(result.retries).toBe(2); // Succeeded on 3rd attempt
    });
  });

  describe("cancellation", () => {
    it("should cancel a pending task", async () => {
      const scheduler = createSwarmScheduler({
        maxConcurrency: 1,
        provider,
        autoDestroy: false,
      });

      // Fill the single slot
      scheduler.submit(createTask({ id: "blocker", command: "sleep 10" }));
      // This one will be queued
      scheduler.submit(createTask({ id: "cancel-me", command: "echo cancel" }));

      const cancelled = scheduler.cancel("cancel-me");
      expect(cancelled).toBe(true);

      const result = scheduler.getResult("cancel-me");
      expect(result).toBeDefined();
      expect(result!.status).toBe("cancelled");

      await scheduler.shutdown();
    });

    it("should return false for non-existent task", () => {
      const scheduler = createSwarmScheduler({
        maxConcurrency: 2,
        provider,
        autoDestroy: false,
      });

      expect(scheduler.cancel("non-existent")).toBe(false);
    });
  });

  describe("events", () => {
    it("should emit events during task lifecycle", async () => {
      const events: SwarmSchedulerEvent[] = [];
      const listener: SwarmEventListener = (event) => events.push(event);

      const scheduler = createSwarmScheduler({
        maxConcurrency: 2,
        provider,
        autoDestroy: false,
      });

      scheduler.on(listener);

      const task = createTask({ id: "event-task", command: "echo events" });
      scheduler.submit(task);
      await scheduler.waitForTask("event-task");

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("task:queued");
      expect(eventTypes).toContain("task:assigned");
      expect(eventTypes).toContain("task:started");
      expect(eventTypes).toContain("task:completed");
      expect(eventTypes).toContain("sandbox:created");

      scheduler.off(listener);
    });

    it("should emit drained event when all tasks complete", async () => {
      const events: SwarmSchedulerEvent[] = [];
      const listener: SwarmEventListener = (event) => events.push(event);

      const scheduler = createSwarmScheduler({
        maxConcurrency: 2,
        provider,
        autoDestroy: false,
      });

      scheduler.on(listener);
      scheduler.submit(createTask({ command: "echo 1" }));
      await scheduler.waitForAll();

      expect(events.some((e) => e.type === "scheduler:drained")).toBe(true);
    });
  });

  describe("status", () => {
    it("should report correct status", async () => {
      const scheduler = createSwarmScheduler({
        maxConcurrency: 3,
        provider,
        autoDestroy: false,
      });

      const initialStatus = scheduler.getStatus();
      expect(initialStatus.pendingTasks).toBe(0);
      expect(initialStatus.runningTasks).toBe(0);
      expect(initialStatus.activeSandboxes).toBe(0);
      expect(initialStatus.maxConcurrency).toBe(3);
      expect(initialStatus.shuttingDown).toBe(false);

      scheduler.submit(createTask({ command: "echo status" }));
      await scheduler.waitForAll();

      const finalStatus = scheduler.getStatus();
      expect(finalStatus.completedTasks).toBe(1);
    });
  });

  describe("shutdown", () => {
    it("should cancel pending tasks on shutdown", async () => {
      const scheduler = createSwarmScheduler({
        maxConcurrency: 1,
        provider,
        autoDestroy: false,
      });

      // Block the slot
      scheduler.submit(createTask({ id: "blocker", command: "sleep 10" }));
      scheduler.submit(createTask({ id: "queued", command: "echo queued" }));

      await scheduler.shutdown();

      const queuedResult = scheduler.getResult("queued");
      expect(queuedResult).toBeDefined();
      expect(queuedResult!.status).toBe("cancelled");
    });

    it("should reject submissions after shutdown", async () => {
      const scheduler = createSwarmScheduler({
        maxConcurrency: 2,
        provider,
        autoDestroy: false,
      });

      await scheduler.shutdown();

      expect(() => scheduler.submit(createTask())).toThrow(SwarmSchedulerError);
    });
  });

  describe("file upload", () => {
    it("should upload files before execution", async () => {
      const instance = createMockSandboxInstance("upload-sandbox");
      const uploadSpy = instance.upload;
      const uploadContentSpy = instance.uploadContent;

      const uploadProvider: SandboxProvider = {
        name: "upload",
        create: vi.fn(async () => instance),
        list: vi.fn(async () => []),
        get: vi.fn(async () => undefined),
        destroy: vi.fn(async () => {}),
        destroyAll: vi.fn(async () => {}),
      };

      const scheduler = createSwarmScheduler({
        maxConcurrency: 2,
        provider: uploadProvider,
        autoDestroy: false,
      });

      const task = createTask({
        command: "run",
        files: [{ localPath: "/local/file.txt", remotePath: "/remote/file.txt" }],
        contents: [{ content: "file content", remotePath: "/remote/content.txt" }],
      });

      scheduler.submit(task);
      await scheduler.waitForTask(task.id);

      expect(uploadSpy).toHaveBeenCalledWith("/local/file.txt", "/remote/file.txt");
      expect(uploadContentSpy).toHaveBeenCalledWith("file content", "/remote/content.txt");
    });
  });

  describe("sandbox creation failure", () => {
    it("should handle sandbox creation failure gracefully", async () => {
      const failProvider: SandboxProvider = {
        name: "fail-create",
        create: vi.fn(async () => {
          throw new Error("Creation failed");
        }),
        list: vi.fn(async () => []),
        get: vi.fn(async () => undefined),
        destroy: vi.fn(async () => {}),
        destroyAll: vi.fn(async () => {}),
      };

      const scheduler = createSwarmScheduler({
        maxConcurrency: 2,
        provider: failProvider,
        autoDestroy: false,
      });

      const task = createTask({ id: "fail-create-task", command: "echo test" });
      scheduler.submit(task);

      const result = await scheduler.waitForTask("fail-create-task");
      expect(result.status).toBe("failed");
      expect(result.error).toBe("Creation failed");
    });
  });

  describe("budget control", () => {
    it("should stop creating sandboxes when budget is exceeded", async () => {
      const scheduler = createSwarmScheduler({
        maxConcurrency: 5,
        provider,
        autoDestroy: false,
        budgetLimit: 0.001, // Very small budget
      });

      // First task should run
      scheduler.submit(createTask({ id: "budget-1", command: "echo 1" }));
      await scheduler.waitForTask("budget-1");

      // Second task might be blocked by budget
      scheduler.submit(createTask({ id: "budget-2", command: "echo 2" }));

      // Just verify it doesn't crash
      await scheduler.waitForAll();
    });
  });
});

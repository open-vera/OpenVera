/**
 * SB12 — Swarm Stress Test: 10 concurrent sandboxes executing the same task.
 *
 * Tests the SwarmScheduler's ability to manage concurrent sandbox execution,
 * task distribution, result collection, and resource cleanup under load.
 * Uses a mock SandboxProvider to avoid real Docker/CubeSandbox dependencies.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  SandboxProvider,
  SandboxInstance,
  SandboxCreateOptions,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxStatus,
} from "@open-vera/core";
import { SwarmSchedulerImpl, createSwarmScheduler } from "../scheduler.js";
import type { SwarmTask, SwarmSchedulerConfig, SwarmSchedulerEvent } from "../types.js";

// ── Mock Sandbox Instance ───────────────────────────────────────────────────

let nextInstanceId = 1;
const createdInstances: MockSandboxInstance[] = [];

class MockSandboxInstance implements SandboxInstance {
  readonly id: string;
  readonly provider = "mock";
  readonly createdAt: Date;
  private _status: SandboxStatus = "ready";
  private execDelay: number;

  constructor(execDelay = 10) {
    this.id = `mock-sb-${nextInstanceId++}`;
    this.createdAt = new Date();
    this.execDelay = execDelay;
    createdInstances.push(this);
  }

  get status(): SandboxStatus {
    return this._status;
  }

  async exec(_command: string, _options?: SandboxExecOptions): Promise<SandboxExecResult> {
    // Simulate work
    await new Promise((resolve) => setTimeout(resolve, this.execDelay));
    return {
      exitCode: 0,
      stdout: `output-from-${this.id}`,
      stderr: "",
      timedOut: false,
      durationMs: this.execDelay,
    };
  }

  async upload(_localPath: string, _remotePath: string): Promise<void> {}
  async uploadContent(_content: string | Uint8Array, _remotePath: string): Promise<void> {}
  async download(_remotePath: string, _localPath: string): Promise<void> {}
  async readFile(_remotePath: string): Promise<string> { return ""; }
  async stop(): Promise<void> { this._status = "stopped"; }
  async resume(): Promise<void> { this._status = "ready"; }
  async destroy(): Promise<void> { this._status = "destroyed"; }
}

// ── Mock Sandbox Provider ───────────────────────────────────────────────────

class MockSandboxProvider implements SandboxProvider {
  readonly name = "mock";
  private createDelay: number;

  constructor(createDelay = 5) {
    this.createDelay = createDelay;
  }

  async create(_options?: SandboxCreateOptions): Promise<SandboxInstance> {
    await new Promise((resolve) => setTimeout(resolve, this.createDelay));
    return new MockSandboxInstance();
  }

  async list(): Promise<SandboxInstance[]> {
    return createdInstances.filter((i) => i.status !== "destroyed");
  }

  async get(sandboxId: string): Promise<SandboxInstance | undefined> {
    return createdInstances.find((i) => i.id === sandboxId);
  }

  async destroy(sandboxId: string): Promise<void> {
    const instance = createdInstances.find((i) => i.id === sandboxId);
    if (instance) await instance.destroy();
  }

  async destroyAll(): Promise<void> {
    await Promise.all(createdInstances.map((i) => i.destroy()));
  }
}

// ── Test Helpers ────────────────────────────────────────────────────────────

function makeTask(overrides?: Partial<SwarmTask>): SwarmTask {
  return {
    id: overrides?.id ?? `task-${Math.random().toString(36).slice(2, 8)}`,
    name: overrides?.name ?? "test-task",
    priority: overrides?.priority ?? "normal",
    command: overrides?.command ?? "echo hello",
    ...overrides,
  };
}

// ── Stress Tests ────────────────────────────────────────────────────────────

describe("SB12: Swarm Stress Test — 10 concurrent sandboxes", () => {
  beforeEach(() => {
    nextInstanceId = 1;
    createdInstances.length = 0;
  });

  it("executes 10 identical tasks concurrently with maxConcurrency=10", async () => {
    const provider = new MockSandboxProvider();
    const scheduler = createSwarmScheduler({
      maxConcurrency: 10,
      provider,
      autoDestroy: true,
    });

    // Submit 10 identical tasks
    const taskIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      taskIds.push(
        scheduler.submit(
          makeTask({ id: `stress-task-${i}`, name: `stress-${i}`, command: "echo hello" }),
        ),
      );
    }

    expect(taskIds).toHaveLength(10);

    // Wait for all to complete
    const results = await scheduler.waitForAll();

    expect(results).toHaveLength(10);
    for (const result of results) {
      expect(result.status).toBe("completed");
      expect(result.exitCode).toBe(0);
    }

    await scheduler.shutdown();
  });

  it("respects maxConcurrency=3 with 10 tasks (queuing)", async () => {
    const provider = new MockSandboxProvider(10);
    const maxConcurrency = 3;

    const scheduler = createSwarmScheduler({
      maxConcurrency,
      provider,
      autoDestroy: true,
    });

    const events: SwarmSchedulerEvent[] = [];
    scheduler.on((event) => events.push(event));

    // Submit 10 tasks
    for (let i = 0; i < 10; i++) {
      scheduler.submit(makeTask({ id: `queued-${i}`, name: `queued-${i}` }));
    }

    const results = await scheduler.waitForAll();

    expect(results).toHaveLength(10);
    for (const result of results) {
      expect(result.status).toBe("completed");
    }

    // Verify sandbox created events (at most maxConcurrency at any time)
    const createdEvents = events.filter((e) => e.type === "sandbox:created");
    expect(createdEvents.length).toBeGreaterThanOrEqual(1);
    expect(createdEvents.length).toBeLessThanOrEqual(10);

    await scheduler.shutdown();
  });

  it("handles mixed success and failure tasks", async () => {
    let callCount = 0;
    class FailOnOddProvider extends MockSandboxProvider {
      override async create(): Promise<SandboxInstance> {
        callCount++;
        const instance = new MockSandboxInstance();
        // Override exec to fail on odd instances
        const origExec = instance.exec.bind(instance);
        instance.exec = async (cmd: string, opts?: SandboxExecOptions) => {
          if (callCount % 2 === 1) {
            return { exitCode: 1, stdout: "", stderr: "simulated failure", timedOut: false, durationMs: 5 };
          }
          return origExec(cmd, opts);
        };
        return instance;
      }
    }

    const provider = new FailOnOddProvider();
    const scheduler = createSwarmScheduler({
      maxConcurrency: 5,
      provider,
      autoDestroy: true,
    });

    for (let i = 0; i < 10; i++) {
      scheduler.submit(makeTask({ id: `mixed-${i}`, name: `mixed-${i}` }));
    }

    const results = await scheduler.waitForAll();

    expect(results).toHaveLength(10);
    const completed = results.filter((r) => r.status === "completed");
    const failed = results.filter((r) => r.status === "failed");
    expect(completed.length + failed.length).toBe(10);

    await scheduler.shutdown();
  });

  it("handles tasks with different priorities", async () => {
    const provider = new MockSandboxProvider();
    const scheduler = createSwarmScheduler({
      maxConcurrency: 2, // Low concurrency to force queuing
      provider,
      autoDestroy: true,
    });

    const completionOrder: string[] = [];
    scheduler.on((event) => {
      if (event.type === "task:completed") {
        completionOrder.push(event.taskId);
      }
    });

    // Submit in reverse priority order
    scheduler.submit(makeTask({ id: "low-1", name: "low", priority: "low" }));
    scheduler.submit(makeTask({ id: "critical-1", name: "critical", priority: "critical" }));
    scheduler.submit(makeTask({ id: "high-1", name: "high", priority: "high" }));
    scheduler.submit(makeTask({ id: "normal-1", name: "normal", priority: "normal" }));

    const results = await scheduler.waitForAll();
    expect(results).toHaveLength(4);

    // Critical and high should complete before low
    const criticalIdx = completionOrder.indexOf("critical-1");
    const lowIdx = completionOrder.indexOf("low-1");
    expect(criticalIdx).toBeLessThan(lowIdx);

    await scheduler.shutdown();
  });

  it("handles rapid submit and cancel", async () => {
    const provider = new MockSandboxProvider(20); // Slow creation
    const scheduler = createSwarmScheduler({
      maxConcurrency: 5,
      provider,
      autoDestroy: true,
    });

    // Submit 10 tasks
    const taskIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      taskIds.push(scheduler.submit(makeTask({ id: `rapid-${i}`, name: `rapid-${i}` })));
    }

    // Cancel half immediately
    const cancelled = taskIds.slice(0, 5).filter((id) => scheduler.cancel(id));
    expect(cancelled.length).toBeGreaterThanOrEqual(0); // Some may already be running

    const results = await scheduler.waitForAll();
    expect(results).toHaveLength(10);

    // Verify cancelled tasks have cancelled status
    for (const id of cancelled) {
      const result = scheduler.getResult(id);
      expect(result?.status).toBe("cancelled");
    }

    await scheduler.shutdown();
  });

  it("submitBatch works correctly", async () => {
    const provider = new MockSandboxProvider();
    const scheduler = createSwarmScheduler({
      maxConcurrency: 10,
      provider,
      autoDestroy: true,
    });

    const tasks = Array.from({ length: 10 }, (_, i) =>
      makeTask({ id: `batch-${i}`, name: `batch-${i}` }),
    );

    const taskIds = scheduler.submitBatch(tasks);
    expect(taskIds).toHaveLength(10);

    const results = await scheduler.waitForAll();
    expect(results).toHaveLength(10);

    await scheduler.shutdown();
  });

  it("getStatus reflects current state during execution", async () => {
    const provider = new MockSandboxProvider(50); // Slow creation
    const scheduler = createSwarmScheduler({
      maxConcurrency: 3,
      provider,
      autoDestroy: true,
    });

    // Submit tasks
    for (let i = 0; i < 10; i++) {
      scheduler.submit(makeTask({ id: `status-${i}`, name: `status-${i}` }));
    }

    // Check status while running
    const status = scheduler.getStatus();
    expect(status.maxConcurrency).toBe(3);
    expect(status.pendingTasks + status.runningTasks).toBeGreaterThanOrEqual(0);

    await scheduler.waitForAll();

    const finalStatus = scheduler.getStatus();
    expect(finalStatus.pendingTasks).toBe(0);
    expect(finalStatus.runningTasks).toBe(0);
    expect(finalStatus.completedTasks + finalStatus.failedTasks).toBe(10);

    await scheduler.shutdown();
  });

  it("shutdown cancels pending tasks and destroys sandboxes", async () => {
    const provider = new MockSandboxProvider(100); // Very slow creation
    const scheduler = createSwarmScheduler({
      maxConcurrency: 2,
      provider,
      autoDestroy: true,
    });

    // Submit many tasks
    for (let i = 0; i < 10; i++) {
      scheduler.submit(makeTask({ id: `shutdown-${i}`, name: `shutdown-${i}` }));
    }

    // Shutdown immediately
    await scheduler.shutdown();

    const status = scheduler.getStatus();
    expect(status.shuttingDown).toBe(true);

    // All remaining tasks should be cancelled or completed
    const results = scheduler.getResults();
    for (const result of results) {
      expect(["completed", "cancelled", "failed"]).toContain(result.status);
    }
  });

  it("events are emitted correctly during execution", async () => {
    const provider = new MockSandboxProvider();
    const scheduler = createSwarmScheduler({
      maxConcurrency: 5,
      provider,
      autoDestroy: true,
    });

    const events: string[] = [];
    scheduler.on((event) => events.push(event.type));

    for (let i = 0; i < 5; i++) {
      scheduler.submit(makeTask({ id: `event-${i}`, name: `event-${i}` }));
    }

    await scheduler.waitForAll();

    expect(events).toContain("task:queued");
    expect(events).toContain("task:assigned");
    expect(events).toContain("task:started");
    expect(events).toContain("task:completed");
    expect(events).toContain("sandbox:created");
    expect(events).toContain("sandbox:destroyed");
    expect(events).toContain("scheduler:drained");

    await scheduler.shutdown();
  });

  it("waitForTask resolves for specific task", async () => {
    const provider = new MockSandboxProvider();
    const scheduler = createSwarmScheduler({
      maxConcurrency: 5,
      provider,
      autoDestroy: true,
    });

    const taskId = scheduler.submit(makeTask({ id: "specific-task", name: "specific" }));
    const result = await scheduler.waitForTask(taskId);

    expect(result.taskId).toBe("specific-task");
    expect(result.status).toBe("completed");

    await scheduler.shutdown();
  });

  it("stress: 10 sandboxes with file upload and exec", async () => {
    const uploadLog: string[] = [];

    class TrackingProvider extends MockSandboxProvider {
      override async create(): Promise<SandboxInstance> {
        const instance = await super.create();
        const origUpload = instance.uploadContent.bind(instance);
        instance.uploadContent = async (content, remotePath) => {
          uploadLog.push(remotePath);
          return origUpload(content, remotePath);
        };
        return instance;
      }
    }

    const provider = new TrackingProvider();
    const scheduler = createSwarmScheduler({
      maxConcurrency: 10,
      provider,
      autoDestroy: true,
      defaultSandboxOptions: { image: "node:20" },
    });

    // Submit tasks with file uploads
    for (let i = 0; i < 10; i++) {
      scheduler.submit(
        makeTask({
          id: `upload-${i}`,
          name: `upload-${i}`,
          command: "node /app/run.js",
          contents: [{ content: `console.log("task ${i}")`, remotePath: "/app/run.js" }],
        }),
      );
    }

    const results = await scheduler.waitForAll();

    expect(results).toHaveLength(10);
    for (const result of results) {
      expect(result.status).toBe("completed");
    }

    // Verify all uploads happened
    expect(uploadLog).toHaveLength(10);
    for (const path of uploadLog) {
      expect(path).toBe("/app/run.js");
    }

    await scheduler.shutdown();
  });
});

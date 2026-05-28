/**
 * Swarm Scheduler — Manages concurrent sandbox execution with task queuing.
 *
 * Flow: submit task → queue → assign to idle sandbox → execute → collect result
 * Supports: priority queue, concurrent execution, auto-retry, budget control
 */

import type {
  SandboxProvider,
  SandboxInstance,
  SandboxCreateOptions,
} from "@open-vera/core";
import type {
  SwarmTask,
  SwarmTaskResult,
  SwarmTaskStatus,
  SwarmSchedulerConfig,
  SwarmScheduler,
  SwarmSchedulerStatus,
  SwarmSchedulerEvent,
  SwarmEventListener,
  TaskPriority,
} from "./types.js";

// ── Priority Queue ──────────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

interface QueuedTask {
  task: SwarmTask;
  enqueuedAt: number;
}

/**
 * Simple priority queue using a sorted array.
 * Higher priority tasks are dequeued first; FIFO within the same priority.
 */
class PriorityQueue {
  private items: QueuedTask[] = [];

  get length(): number {
    return this.items.length;
  }

  enqueue(task: SwarmTask): void {
    const item: QueuedTask = { task, enqueuedAt: Date.now() };
    const priority = PRIORITY_ORDER[task.priority ?? "normal"];

    // Insert in sorted position (higher priority first)
    let inserted = false;
    for (let i = 0; i < this.items.length; i++) {
      const itemPriority = PRIORITY_ORDER[this.items[i].task.priority ?? "normal"];
      if (priority > itemPriority) {
        this.items.splice(i, 0, item);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      this.items.push(item);
    }
  }

  dequeue(): QueuedTask | undefined {
    return this.items.shift();
  }

  remove(taskId: string): boolean {
    const idx = this.items.findIndex((i) => i.task.id === taskId);
    if (idx >= 0) {
      this.items.splice(idx, 1);
      return true;
    }
    return false;
  }

  toArray(): QueuedTask[] {
    return [...this.items];
  }
}

// ── Sandbox Wrapper ─────────────────────────────────────────────────────────

interface ManagedSandbox {
  instance: SandboxInstance;
  busy: boolean;
  currentTaskId: string | null;
  createdAt: number;
}

// ── Swarm Scheduler Implementation ──────────────────────────────────────────

export class SwarmSchedulerImpl implements SwarmScheduler {
  private readonly config: Required<SwarmSchedulerConfig>;
  private readonly queue = new PriorityQueue();
  private readonly sandboxes = new Map<string, ManagedSandbox>();
  private readonly results = new Map<string, SwarmTaskResult>();
  private readonly listeners: SwarmEventListener[] = [];
  private readonly pendingPromises = new Map<string, {
    resolve: (result: SwarmTaskResult) => void;
    reject: (error: Error) => void;
  }>();
  private readonly activeTasks = new Set<string>();
  private shuttingDown = false;
  private taskCounter = 0;
  private totalCost = 0;
  private drainedResolvers: Array<() => void> = [];
  private creatingCount = 0;
  private readonly creatingTasks = new Map<string, SwarmTask>();

  constructor(config: SwarmSchedulerConfig) {
    this.config = {
      maxConcurrency: config.maxConcurrency,
      provider: config.provider,
      defaultSandboxOptions: config.defaultSandboxOptions ?? {},
      defaultTimeoutSeconds: config.defaultTimeoutSeconds ?? 300,
      pollIntervalMs: config.pollIntervalMs ?? 100,
      autoDestroy: config.autoDestroy ?? true,
      budgetLimit: config.budgetLimit ?? 0,
    };
  }

  // ── Public API ──────────────────────────────────────────────────────────

  submit(task: SwarmTask): string {
    if (this.shuttingDown) {
      throw new SwarmSchedulerError("SCHEDULER_SHUTDOWN", "Scheduler is shutting down");
    }

    const taskId = task.id ?? `task-${++this.taskCounter}`;
    const taskWithId = { ...task, id: taskId };

    this.activeTasks.add(taskId);
    this.queue.enqueue(taskWithId);
    this.emit({ type: "task:queued", taskId, taskName: task.name });

    // Try to assign immediately
    this.tryAssign();

    return taskId;
  }

  submitBatch(tasks: SwarmTask[]): string[] {
    return tasks.map((t) => this.submit(t));
  }

  cancel(taskId: string): boolean {
    // Try to remove from queue
    if (this.queue.remove(taskId)) {
      this.activeTasks.delete(taskId);
      const result = createCancelledResult(taskId);
      this.results.set(taskId, result);
      this.emit({ type: "task:cancelled", taskId });
      this.resolvePending(taskId, result);
      this.checkDrained();
      return true;
    }

    // Check if task is being created (sandbox in progress)
    if (this.creatingTasks.has(taskId)) {
      this.creatingTasks.delete(taskId);
      this.activeTasks.delete(taskId);
      const result = createCancelledResult(taskId);
      this.results.set(taskId, result);
      this.emit({ type: "task:cancelled", taskId });
      this.resolvePending(taskId, result);
      return true;
    }

    // Find running task and destroy its sandbox
    for (const [sandboxId, sandbox] of this.sandboxes) {
      if (sandbox.currentTaskId === taskId) {
        // Destroy the sandbox to stop execution
        void this.destroySandbox(sandboxId);
        this.activeTasks.delete(taskId);
        const result = createCancelledResult(taskId);
        this.results.set(taskId, result);
        this.emit({ type: "task:cancelled", taskId });
        this.resolvePending(taskId, result);
        this.checkDrained();
        return true;
      }
    }

    return false;
  }

  getResult(taskId: string): SwarmTaskResult | undefined {
    return this.results.get(taskId);
  }

  getResults(): SwarmTaskResult[] {
    return Array.from(this.results.values());
  }

  async waitForAll(): Promise<SwarmTaskResult[]> {
    // If nothing pending, return immediately
    if (this.activeTasks.size === 0 && this.queue.length === 0) {
      return this.getResults();
    }

    // Wait for drained event
    await new Promise<void>((resolve) => {
      this.drainedResolvers.push(resolve);
      // Also check immediately in case it drained while we were setting up
      if (this.activeTasks.size === 0 && this.queue.length === 0) {
        resolve();
        this.drainedResolvers = this.drainedResolvers.filter((r) => r !== resolve);
      }
    });

    return this.getResults();
  }

  async waitForTask(taskId: string): Promise<SwarmTaskResult> {
    // Check if already completed
    const existing = this.results.get(taskId);
    if (existing) return existing;

    return new Promise<SwarmTaskResult>((resolve, reject) => {
      this.pendingPromises.set(taskId, { resolve, reject });
    });
  }

  getStatus(): SwarmSchedulerStatus {
    let runningTasks = 0;
    for (const sandbox of this.sandboxes.values()) {
      if (sandbox.busy) runningTasks++;
    }

    let completedTasks = 0;
    let failedTasks = 0;
    for (const result of this.results.values()) {
      if (result.status === "completed") completedTasks++;
      else if (result.status === "failed" || result.status === "timeout") failedTasks++;
    }

    return {
      pendingTasks: this.queue.length,
      runningTasks,
      completedTasks,
      failedTasks,
      activeSandboxes: this.sandboxes.size,
      maxConcurrency: this.config.maxConcurrency,
      shuttingDown: this.shuttingDown,
    };
  }

  on(listener: SwarmEventListener): void {
    this.listeners.push(listener);
  }

  off(listener: SwarmEventListener): void {
    const idx = this.listeners.indexOf(listener);
    if (idx >= 0) this.listeners.splice(idx, 1);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    // Cancel all pending tasks in queue
    const pending = this.queue.toArray();
    for (const item of pending) {
      this.activeTasks.delete(item.task.id);
      const result = createCancelledResult(item.task.id);
      this.results.set(item.task.id, result);
      this.emit({ type: "task:cancelled", taskId: item.task.id });
      this.resolvePending(item.task.id, result);
    }
    // Clear the queue
    while (this.queue.length > 0) this.queue.dequeue();

    // Cancel tasks being created
    for (const [taskId] of this.creatingTasks) {
      this.activeTasks.delete(taskId);
      const result = createCancelledResult(taskId);
      this.results.set(taskId, result);
      this.emit({ type: "task:cancelled", taskId });
      this.resolvePending(taskId, result);
    }
    this.creatingTasks.clear();

    // Destroy all sandboxes
    const destroyPromises: Promise<void>[] = [];
    for (const sandboxId of this.sandboxes.keys()) {
      destroyPromises.push(this.destroySandbox(sandboxId));
    }
    await Promise.allSettled(destroyPromises);

    this.emit({ type: "scheduler:drained" });
    this.resolveDrained();
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private tryAssign(): void {
    if (this.shuttingDown) return;

    // Check budget
    if (this.config.budgetLimit > 0 && this.totalCost >= this.config.budgetLimit) {
      return;
    }

    // Assign to idle sandboxes first
    while (this.queue.length > 0) {
      const idleSandbox = this.findIdleSandbox();
      if (idleSandbox) {
        this.assignToSandbox(idleSandbox);
      } else {
        break;
      }
    }

    // Create new sandboxes if under limit (account for ones being created)
    while (
      this.queue.length > 0 &&
      this.sandboxes.size + this.creatingCount < this.config.maxConcurrency
    ) {
      this.creatingCount++;
      void this.createAndAssign();
    }
  }

  private findIdleSandbox(): [string, ManagedSandbox] | null {
    for (const [id, sandbox] of this.sandboxes) {
      if (!sandbox.busy && sandbox.instance.status === "ready") {
        return [id, sandbox];
      }
    }
    return null;
  }

  private async createAndAssign(): Promise<void> {
    const queued = this.queue.dequeue();
    if (!queued) {
      this.creatingCount--;
      return;
    }

    const task = queued.task;
    this.creatingTasks.set(task.id, task);
    let sandboxId: string | undefined;

    try {
      // Create sandbox
      const options: SandboxCreateOptions = {
        ...this.config.defaultSandboxOptions,
        ...task.sandboxOptions,
      };

      const instance = await this.config.provider.create(options);
      sandboxId = instance.id;

      const managed: ManagedSandbox = {
        instance,
        busy: false,
        currentTaskId: null,
        createdAt: Date.now(),
      };

      this.sandboxes.set(sandboxId, managed);
      this.creatingCount--;
      this.creatingTasks.delete(task.id);
      this.emit({ type: "sandbox:created", sandboxId });

      // Assign the task
      this.assignTaskToSandbox(sandboxId, managed, task);
    } catch (error) {
      this.creatingCount--;
      this.creatingTasks.delete(task.id);
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.activeTasks.delete(task.id);
      this.emit({ type: "task:failed", taskId: task.id, error: errorMsg });

      const result: SwarmTaskResult = {
        taskId: task.id,
        taskName: task.name,
        status: "failed",
        exitCode: null,
        stdout: "",
        stderr: errorMsg,
        durationMs: 0,
        sandboxId: sandboxId ?? "unknown",
        error: errorMsg,
        retries: 0,
      };

      this.results.set(task.id, result);
      this.resolvePending(task.id, result);
      this.checkDrained();

      // Try next task
      this.tryAssign();
    }
  }

  private assignToSandbox([sandboxId, sandbox]: [string, ManagedSandbox]): void {
    const queued = this.queue.dequeue();
    if (!queued) return;

    this.assignTaskToSandbox(sandboxId, sandbox, queued.task);
  }

  private assignTaskToSandbox(
    sandboxId: string,
    sandbox: ManagedSandbox,
    task: SwarmTask,
  ): void {
    sandbox.busy = true;
    sandbox.currentTaskId = task.id;

    this.emit({ type: "task:assigned", taskId: task.id, sandboxId });
    this.emit({ type: "task:started", taskId: task.id, sandboxId });

    // Execute asynchronously
    void this.executeTask(sandboxId, sandbox, task, 0);
  }

  private async executeTask(
    sandboxId: string,
    sandbox: ManagedSandbox,
    task: SwarmTask,
    retries: number,
  ): Promise<void> {
    const startTime = Date.now();
    const timeoutSeconds = task.timeoutSeconds ?? this.config.defaultTimeoutSeconds;

    try {
      // Upload files
      if (task.files) {
        for (const file of task.files) {
          await sandbox.instance.upload(file.localPath, file.remotePath);
        }
      }

      // Upload content
      if (task.contents) {
        for (const content of task.contents) {
          await sandbox.instance.uploadContent(content.content, content.remotePath);
        }
      }

      // Execute command
      const execResult = await sandbox.instance.exec(task.command, {
        workdir: task.workdir,
        env: task.env,
        timeoutSeconds: timeoutSeconds > 0 ? timeoutSeconds : undefined,
      });

      const durationMs = Date.now() - startTime;
      const maxRetries = task.maxRetries ?? 0;

      // If exit code is non-zero, treat as failure for retry purposes
      if (execResult.exitCode !== 0 && retries < maxRetries) {
        await this.executeTask(sandboxId, sandbox, task, retries + 1);
        return;
      }

      const status: SwarmTaskStatus = execResult.timedOut
        ? "timeout"
        : execResult.exitCode === 0
          ? "completed"
          : "failed";

      // Track cost (simple: 1 unit per second)
      this.totalCost += durationMs / 1000;

      const result: SwarmTaskResult = {
        taskId: task.id,
        taskName: task.name,
        status,
        exitCode: execResult.exitCode,
        stdout: execResult.stdout,
        stderr: execResult.stderr,
        durationMs,
        sandboxId,
        retries,
      };

      this.activeTasks.delete(task.id);
      this.results.set(task.id, result);
      this.emit({ type: "task:completed", taskId: task.id, result });
      this.resolvePending(task.id, result);
      this.checkDrained();
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);
      const maxRetries = task.maxRetries ?? 0;

      // Retry if within limits
      if (retries < maxRetries) {
        await this.executeTask(sandboxId, sandbox, task, retries + 1);
        return;
      }

      const result: SwarmTaskResult = {
        taskId: task.id,
        taskName: task.name,
        status: "failed",
        exitCode: null,
        stdout: "",
        stderr: errorMsg,
        durationMs,
        sandboxId,
        error: errorMsg,
        retries,
      };

      this.activeTasks.delete(task.id);
      this.results.set(task.id, result);
      this.emit({ type: "task:failed", taskId: task.id, error: errorMsg });
      this.resolvePending(task.id, result);
      this.checkDrained();
    } finally {
      // Release sandbox
      sandbox.busy = false;
      sandbox.currentTaskId = null;

      // Auto-destroy if configured
      if (this.config.autoDestroy) {
        await this.destroySandbox(sandboxId);
      }

      // Try to assign next task
      this.tryAssign();

      // Re-check drain after releasing sandbox (the try-block checkDrained
      // ran while this sandbox was still marked busy)
      this.checkDrained();
    }
  }

  private async destroySandbox(sandboxId: string): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return;

    try {
      await sandbox.instance.destroy();
    } catch {
      // Ignore destroy errors
    }

    this.sandboxes.delete(sandboxId);
    this.emit({ type: "sandbox:destroyed", sandboxId });
  }

  private hasBusySandboxes(): boolean {
    for (const sandbox of this.sandboxes.values()) {
      if (sandbox.busy) return true;
    }
    return false;
  }

  private checkDrained(): void {
    if (this.activeTasks.size === 0 && this.queue.length === 0 && !this.hasBusySandboxes()) {
      this.emit({ type: "scheduler:drained" });
      this.resolveDrained();
    }
  }

  private resolveDrained(): void {
    for (const resolver of this.drainedResolvers) {
      resolver();
    }
    this.drainedResolvers = [];
  }

  private resolvePending(taskId: string, result: SwarmTaskResult): void {
    const pending = this.pendingPromises.get(taskId);
    if (pending) {
      pending.resolve(result);
      this.pendingPromises.delete(taskId);
    }
  }

  private emit(event: SwarmSchedulerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors affect scheduler
      }
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a new swarm scheduler instance.
 */
export function createSwarmScheduler(config: SwarmSchedulerConfig): SwarmScheduler {
  return new SwarmSchedulerImpl(config);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function createCancelledResult(taskId: string): SwarmTaskResult {
  return {
    taskId,
    taskName: "",
    status: "cancelled",
    exitCode: null,
    stdout: "",
    stderr: "Task cancelled",
    durationMs: 0,
    sandboxId: "",
    retries: 0,
  };
}

// ── Error Class ─────────────────────────────────────────────────────────────

export class SwarmSchedulerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SwarmSchedulerError";
    this.code = code;
  }
}

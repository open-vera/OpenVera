/**
 * Swarm Scheduler Types — Task queue and scheduling for concurrent sandbox execution.
 */

import type { SandboxProvider, SandboxInstance, SandboxCreateOptions } from "@open-vera/core";

// ── Swarm Task ──────────────────────────────────────────────────────────────

/** Priority levels for swarm tasks */
export type TaskPriority = "critical" | "high" | "normal" | "low";

/** Status of a swarm task */
export type SwarmTaskStatus =
  | "pending"
  | "assigned"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

/** A task to be executed by the swarm */
export interface SwarmTask {
  /** Unique task identifier */
  readonly id: string;

  /** Human-readable task name */
  readonly name: string;

  /** Task priority (higher priority tasks run first) */
  readonly priority: TaskPriority;

  /** Command to execute in the sandbox */
  readonly command: string;

  /** Files to upload before execution (localPath → remotePath) */
  readonly files?: Array<{ localPath: string; remotePath: string }>;

  /** Content to upload before execution */
  readonly contents?: Array<{ content: string | Uint8Array; remotePath: string }>;

  /** Working directory inside the sandbox */
  readonly workdir?: string;

  /** Environment variables for this task */
  readonly env?: Record<string, string>;

  /** Timeout in seconds (0 = no timeout) */
  readonly timeoutSeconds?: number;

  /** Sandbox creation options override */
  readonly sandboxOptions?: Partial<SandboxCreateOptions>;

  /** Maximum retry count on failure */
  readonly maxRetries?: number;
}

/** Result of a swarm task execution */
export interface SwarmTaskResult {
  /** Task that produced this result */
  readonly taskId: string;

  /** Task name */
  readonly taskName: string;

  /** Final status */
  readonly status: SwarmTaskStatus;

  /** Exit code (null if not completed) */
  readonly exitCode: number | null;

  /** Standard output */
  readonly stdout: string;

  /** Standard error */
  readonly stderr: string;

  /** Duration in milliseconds */
  readonly durationMs: number;

  /** Sandbox ID that executed this task */
  readonly sandboxId: string;

  /** Error message if failed */
  readonly error?: string;

  /** Number of retries attempted */
  readonly retries: number;
}

// ── Swarm Scheduler Config ──────────────────────────────────────────────────

/** Configuration for the swarm scheduler */
export interface SwarmSchedulerConfig {
  /** Maximum number of concurrent sandboxes */
  maxConcurrency: number;

  /** Sandbox provider to use */
  provider: SandboxProvider;

  /** Default sandbox creation options */
  defaultSandboxOptions?: Partial<SandboxCreateOptions>;

  /** Default task timeout in seconds (0 = no timeout) */
  defaultTimeoutSeconds?: number;

  /** Polling interval in ms for checking task completion */
  pollIntervalMs?: number;

  /** Whether to destroy sandboxes after task completion */
  autoDestroy?: boolean;

  /** Budget limit (total cost in arbitrary units, 0 = unlimited) */
  budgetLimit?: number;
}

// ── Swarm Scheduler Events ──────────────────────────────────────────────────

/** Events emitted by the swarm scheduler */
export type SwarmSchedulerEvent =
  | { type: "task:queued"; taskId: string; taskName: string }
  | { type: "task:assigned"; taskId: string; sandboxId: string }
  | { type: "task:started"; taskId: string; sandboxId: string }
  | { type: "task:completed"; taskId: string; result: SwarmTaskResult }
  | { type: "task:failed"; taskId: string; error: string }
  | { type: "task:cancelled"; taskId: string }
  | { type: "sandbox:created"; sandboxId: string }
  | { type: "sandbox:destroyed"; sandboxId: string }
  | { type: "scheduler:idle" }
  | { type: "scheduler:drained" };

/** Event listener type */
export type SwarmEventListener = (event: SwarmSchedulerEvent) => void;

// ── Swarm Scheduler Interface ───────────────────────────────────────────────

/** Swarm scheduler manages concurrent sandbox execution */
export interface SwarmScheduler {
  /** Submit a task to the swarm */
  submit(task: SwarmTask): string;

  /** Submit multiple tasks at once */
  submitBatch(tasks: SwarmTask[]): string[];

  /** Cancel a pending or running task */
  cancel(taskId: string): boolean;

  /** Get the result of a completed task */
  getResult(taskId: string): SwarmTaskResult | undefined;

  /** Get all results */
  getResults(): SwarmTaskResult[];

  /** Wait for all submitted tasks to complete */
  waitForAll(): Promise<SwarmTaskResult[]>;

  /** Wait for a specific task to complete */
  waitForTask(taskId: string): Promise<SwarmTaskResult>;

  /** Get current scheduler status */
  getStatus(): SwarmSchedulerStatus;

  /** Register an event listener */
  on(listener: SwarmEventListener): void;

  /** Unregister an event listener */
  off(listener: SwarmEventListener): void;

  /** Shutdown the scheduler, cancelling pending tasks and destroying sandboxes */
  shutdown(): Promise<void>;
}

/** Current status of the swarm scheduler */
export interface SwarmSchedulerStatus {
  /** Number of tasks waiting in queue */
  readonly pendingTasks: number;

  /** Number of tasks currently executing */
  readonly runningTasks: number;

  /** Number of completed tasks */
  readonly completedTasks: number;

  /** Number of failed tasks */
  readonly failedTasks: number;

  /** Number of active sandboxes */
  readonly activeSandboxes: number;

  /** Maximum concurrency */
  readonly maxConcurrency: number;

  /** Whether the scheduler is shutting down */
  readonly shuttingDown: boolean;
}

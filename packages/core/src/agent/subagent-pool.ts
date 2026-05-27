/**
 * SubagentPool — manages concurrent subagent execution with limits.
 *
 * Tracks running subagents, enforces max concurrency,
 * supports cancellation and status queries.
 */

import type { SubagentJobStatus } from "./subagent.js";
import { DuplicateJobError, QueueFullError, MaxDepthExceededError } from "../errors.js";

export interface PoolJob {
  jobId: string;
  agentType: string;
  prompt: string;
  status: SubagentJobStatus;
  createdAt: number;
  updatedAt: number;
  result?: string;
  error?: string;
  cancelToken?: AbortController;
  /** Permissions inherited from parent agent. */
  permissions?: string[];
  /** Token usage accumulated for this job. */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Recursion depth of this job (0 = top-level). */
  depth?: number;
}

export interface SubagentPoolOptions {
  /** Maximum concurrent subagents (default: 3). */
  maxConcurrent?: number;
  /** Maximum queued jobs before rejection (default: 10). */
  maxQueue?: number;
  /** Maximum recursion depth for subagents (default: 3). */
  maxDepth?: number;
}

export class SubagentPool {
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private readonly maxDepth: number;
  private readonly jobs = new Map<string, PoolJob>();
  private readonly queue: string[] = [];
  private runningCount = 0;

  constructor(opts?: SubagentPoolOptions) {
    this.maxConcurrent = opts?.maxConcurrent ?? 3;
    this.maxQueue = opts?.maxQueue ?? 10;
    this.maxDepth = opts?.maxDepth ?? 3;
  }

  /** Submit a job. Returns the jobId. Throws if queue is full or depth exceeded. */
  submit(jobId: string, agentType: string, prompt: string, options?: { depth?: number }): PoolJob {
    if (this.jobs.has(jobId)) {
      throw new DuplicateJobError(jobId);
    }

    const depth = options?.depth ?? 0;
    if (depth >= this.maxDepth) {
      throw new MaxDepthExceededError(depth, this.maxDepth);
    }

    const totalSlots = this.maxConcurrent + this.maxQueue;
    if (this.jobs.size >= totalSlots) {
      throw new QueueFullError(totalSlots);
    }

    const job: PoolJob = {
      jobId,
      agentType,
      prompt,
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cancelToken: new AbortController(),
      depth,
    };

    this.jobs.set(jobId, job);

    if (this.runningCount < this.maxConcurrent) {
      this.runningCount++;
    } else {
      // Conceptual "queued" — status stays "running" but not counted as active
      this.queue.push(jobId);
    }

    return job;
  }

  /** Mark a job as completed. */
  complete(jobId: string, result: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = "succeeded";
    job.result = result;
    job.updatedAt = Date.now();
    this.runningCount = Math.max(0, this.runningCount - 1);
    this.processQueue();
  }

  /** Mark a job as failed. */
  fail(jobId: string, error: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = "failed";
    job.error = error;
    job.updatedAt = Date.now();
    this.runningCount = Math.max(0, this.runningCount - 1);
    this.processQueue();
  }

  /** Cancel a running or queued job. */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running") return false;

    job.cancelToken?.abort();
    job.status = "failed";
    job.error = "Cancelled";
    job.updatedAt = Date.now();

    // Remove from queue if queued
    const queueIdx = this.queue.indexOf(jobId);
    if (queueIdx >= 0) {
      this.queue.splice(queueIdx, 1);
    } else {
      this.runningCount = Math.max(0, this.runningCount - 1);
    }

    this.processQueue();
    return true;
  }

  /** Check if a job should be cancelled. */
  isCancelled(jobId: string): boolean {
    return this.jobs.get(jobId)?.cancelToken?.signal.aborted ?? false;
  }

  /** Get the AbortSignal for a job (pass to subagent execution). */
  getSignal(jobId: string): AbortSignal | undefined {
    return this.jobs.get(jobId)?.cancelToken?.signal;
  }

  /** Get a specific job. */
  get(jobId: string): PoolJob | undefined {
    return this.jobs.get(jobId);
  }

  /** Get all jobs, optionally filtered by status. */
  list(status?: SubagentJobStatus): PoolJob[] {
    const jobs = [...this.jobs.values()];
    if (status) return jobs.filter((j) => j.status === status);
    return jobs.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Get pool status summary. */
  status(): { running: number; queued: number; total: number; maxConcurrent: number } {
    return {
      running: this.runningCount,
      queued: this.queue.length,
      total: this.jobs.size,
      maxConcurrent: this.maxConcurrent,
    };
  }

  /** Clear completed/failed jobs from the pool. */
  clearFinished(): number {
    let cleared = 0;
    for (const [id, job] of this.jobs) {
      if (job.status === "succeeded" || job.status === "failed") {
        this.jobs.delete(id);
        cleared++;
      }
    }
    return cleared;
  }

  /** Aggregate token usage across all jobs. */
  getTotalUsage(): { promptTokens: number; completionTokens: number; totalTokens: number } {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    for (const job of this.jobs.values()) {
      if (job.usage) {
        promptTokens += job.usage.promptTokens;
        completionTokens += job.usage.completionTokens;
        totalTokens += job.usage.totalTokens;
      }
    }
    return { promptTokens, completionTokens, totalTokens };
  }

  /** Set permissions for a job. */
  setPermissions(jobId: string, permissions: string[]): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.permissions = permissions;
  }

  /** Get permissions for a job. */
  getPermissions(jobId: string): string[] {
    return this.jobs.get(jobId)?.permissions ?? [];
  }

  /** Get the recursion depth of a job. */
  getDepth(jobId: string): number {
    return this.jobs.get(jobId)?.depth ?? 0;
  }

  private processQueue(): void {
    while (this.runningCount < this.maxConcurrent && this.queue.length > 0) {
      const nextId = this.queue.shift()!;
      const job = this.jobs.get(nextId);
      // Only increment if job still exists and hasn't been cancelled/completed
      if (job && job.status === "running") {
        this.runningCount++;
        // NOTE: job.status stays "running" (not "active") — no separate queued state needed
        // The presence in `queue` array vs `runningCount` determines conceptual state
      }
    }
  }
}

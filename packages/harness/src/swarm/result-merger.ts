/**
 * Result Merger — Merge results from parallel sandbox executions.
 *
 * Strategies:
 * - concat: concatenate stdout/stderr from all sub-tasks
 * - report: aggregate into a structured report with per-task breakdown
 * - files: collect files from all sandboxes into a local directory
 * - custom: user-provided merge function
 */

import type { SwarmTaskResult } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Merged result from multiple sub-tasks */
export interface MergedResult {
  /** Overall status: completed if all succeeded, partial if some failed, failed if all failed */
  readonly status: "completed" | "partial" | "failed";

  /** Merged stdout */
  readonly stdout: string;

  /** Merged stderr */
  readonly stderr: string;

  /** Per-task results */
  readonly taskResults: SwarmTaskResult[];

  /** Total duration (sum of all tasks) */
  readonly totalDurationMs: number;

  /** Wall-clock duration (max of all tasks, since they ran in parallel) */
  readonly wallClockDurationMs: number;

  /** Number of successful tasks */
  readonly successCount: number;

  /** Number of failed tasks */
  readonly failureCount: number;

  /** Strategy used for merging */
  readonly strategy: string;

  /** Summary message */
  readonly summary: string;
}

/** Interface for result merging strategies */
export interface ResultMergeStrategy {
  /** Unique name of this strategy */
  readonly name: string;

  /** Merge multiple task results into one */
  merge(results: SwarmTaskResult[]): MergedResult;
}

/** Options for the result merger */
export interface ResultMergerOptions {
  /** Strategies available */
  strategies?: ResultMergeStrategy[];

  /** Default strategy name */
  defaultStrategy?: string;
}

// ── Built-in Strategies ──────────────────────────────────────────────────────

/**
 * Concatenation strategy — join stdout/stderr from all sub-tasks.
 * Simple but effective for tasks that produce text output.
 */
export class ConcatMergeStrategy implements ResultMergeStrategy {
  readonly name = "concat";

  merge(results: SwarmTaskResult[]): MergedResult {
    const successCount = results.filter((r) => r.status === "completed").length;
    const failureCount = results.length - successCount;

    const status =
      successCount === results.length
        ? "completed"
        : successCount === 0
          ? "failed"
          : "partial";

    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];

    for (const result of results) {
      if (result.stdout) {
        stdoutParts.push(`[${result.taskName}] ${result.stdout}`);
      }
      if (result.stderr) {
        stderrParts.push(`[${result.taskName}] ${result.stderr}`);
      }
    }

    return {
      status,
      stdout: stdoutParts.join("\n"),
      stderr: stderrParts.join("\n"),
      taskResults: results,
      totalDurationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
      wallClockDurationMs: Math.max(...results.map((r) => r.durationMs), 0),
      successCount,
      failureCount,
      strategy: this.name,
      summary: `${successCount}/${results.length} tasks completed`,
    };
  }
}

/**
 * Report strategy — produce a structured summary with per-task breakdown.
 * Best for tasks that produce discrete, named outputs.
 */
export class ReportMergeStrategy implements ResultMergeStrategy {
  readonly name = "report";

  merge(results: SwarmTaskResult[]): MergedResult {
    const successCount = results.filter((r) => r.status === "completed").length;
    const failureCount = results.length - successCount;

    const status =
      successCount === results.length
        ? "completed"
        : successCount === 0
          ? "failed"
          : "partial";

    const lines: string[] = [
      `## Swarm Execution Report`,
      ``,
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Total tasks | ${results.length} |`,
      `| Succeeded | ${successCount} |`,
      `| Failed | ${failureCount} |`,
      `| Wall-clock time | ${Math.max(...results.map((r) => r.durationMs), 0)}ms |`,
      `| Total CPU time | ${results.reduce((sum, r) => sum + r.durationMs, 0)}ms |`,
      ``,
      `### Per-Task Results`,
      ``,
      `| Task | Status | Duration | Exit Code |`,
      `|------|--------|----------|-----------|`,
    ];

    for (const r of results) {
      const statusIcon = r.status === "completed" ? "pass" : "FAIL";
      lines.push(
        `| ${r.taskName} | ${statusIcon} | ${r.durationMs}ms | ${r.exitCode ?? "N/A"} |`,
      );
    }

    // Failed task details
    const failed = results.filter((r) => r.status !== "completed");
    if (failed.length > 0) {
      lines.push("", "### Failed Tasks", "");
      for (const r of failed) {
        lines.push(`- **${r.taskName}**: ${r.error ?? r.stderr ?? "unknown error"}`);
      }
    }

    const stdout = lines.join("\n");
    const stderr = failed
      .map((r) => `[${r.taskName}] ${r.stderr}`)
      .join("\n");

    return {
      status,
      stdout,
      stderr,
      taskResults: results,
      totalDurationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
      wallClockDurationMs: Math.max(...results.map((r) => r.durationMs), 0),
      successCount,
      failureCount,
      strategy: this.name,
      summary: `Swarm: ${successCount}/${results.length} succeeded in ${Math.max(...results.map((r) => r.durationMs), 0)}ms`,
    };
  }
}

/**
 * Custom merge strategy using a user-provided function.
 */
export class CustomMergeStrategy implements ResultMergeStrategy {
  readonly name: string;
  private readonly merger: (results: SwarmTaskResult[]) => MergedResult;

  constructor(name: string, merger: (results: SwarmTaskResult[]) => MergedResult) {
    this.name = name;
    this.merger = merger;
  }

  merge(results: SwarmTaskResult[]): MergedResult {
    return this.merger(results);
  }
}

// ── Result Merger ────────────────────────────────────────────────────────────

/**
 * Result merger that applies a chosen strategy to combine sub-task results.
 */
export class ResultMerger {
  private readonly strategies = new Map<string, ResultMergeStrategy>();
  private readonly defaultStrategy: string;

  constructor(options: ResultMergerOptions = {}) {
    const strategies = options.strategies ?? [
      new ConcatMergeStrategy(),
      new ReportMergeStrategy(),
    ];

    for (const strategy of strategies) {
      this.strategies.set(strategy.name, strategy);
    }

    this.defaultStrategy = options.defaultStrategy ?? "concat";
  }

  /**
   * Merge results using the default strategy.
   */
  merge(results: SwarmTaskResult[]): MergedResult {
    return this.mergeWith(results, this.defaultStrategy);
  }

  /**
   * Merge results using a specific strategy.
   */
  mergeWith(results: SwarmTaskResult[], strategyName: string): MergedResult {
    const strategy = this.strategies.get(strategyName);
    if (!strategy) {
      throw new ResultMergerError(
        "STRATEGY_NOT_FOUND",
        `Merge strategy not found: ${strategyName}`,
      );
    }

    if (results.length === 0) {
      return {
        status: "completed",
        stdout: "",
        stderr: "",
        taskResults: [],
        totalDurationMs: 0,
        wallClockDurationMs: 0,
        successCount: 0,
        failureCount: 0,
        strategy: strategyName,
        summary: "No tasks to merge",
      };
    }

    return strategy.merge(results);
  }

  /**
   * Register a strategy at runtime.
   */
  addStrategy(strategy: ResultMergeStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  /**
   * List available strategy names.
   */
  listStrategies(): string[] {
    return Array.from(this.strategies.keys());
  }
}

// ── Error ────────────────────────────────────────────────────────────────────

export class ResultMergerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ResultMergerError";
    this.code = code;
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/** Create a result merger with default strategies */
export function createResultMerger(options?: ResultMergerOptions): ResultMerger {
  return new ResultMerger(options);
}

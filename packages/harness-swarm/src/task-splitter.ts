/**
 * Task Splitter — Automatically split large tasks into parallelizable sub-tasks.
 *
 * Strategies:
 * - file-based: split by file groups (e.g., process files in batches)
 * - command-based: split multi-step commands into independent units
 * - custom: user-provided split function
 */

import type { SwarmTask } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** A split result containing sub-tasks and metadata */
export interface TaskSplitResult {
  /** The original task */
  readonly originalTask: SwarmTask;

  /** Sub-tasks that can be executed in parallel */
  readonly subTasks: SwarmTask[];

  /** Strategy used for splitting */
  readonly strategy: string;

  /** Human-readable description of the split */
  readonly description: string;
}

/** Interface for task splitting strategies */
export interface TaskSplitStrategy {
  /** Unique name of this strategy */
  readonly name: string;

  /** Check if this strategy can handle the given task */
  canSplit(task: SwarmTask): boolean;

  /** Split a task into sub-tasks */
  split(task: SwarmTask): TaskSplitResult;
}

/** Options for the task splitter */
export interface TaskSplitterOptions {
  /** Strategies to try, in order of preference */
  strategies?: TaskSplitStrategy[];

  /** Maximum number of sub-tasks to produce */
  maxSubTasks?: number;

  /** Minimum number of files/content items to trigger splitting */
  splitThreshold?: number;
}

// ── Built-in Strategies ──────────────────────────────────────────────────────

/**
 * Split by file groups. If a task has many files to upload,
 * split them into batches processed in parallel.
 */
export class FileBatchSplitStrategy implements TaskSplitStrategy {
  readonly name = "file-batch";

  private readonly batchSize: number;

  constructor(batchSize = 10) {
    this.batchSize = batchSize;
  }

  canSplit(task: SwarmTask): boolean {
    return (task.files?.length ?? 0) > this.batchSize;
  }

  split(task: SwarmTask): TaskSplitResult {
    const files = task.files ?? [];
    const batches: typeof files[] = [];

    for (let i = 0; i < files.length; i += this.batchSize) {
      batches.push(files.slice(i, i + this.batchSize));
    }

    const subTasks: SwarmTask[] = batches.map((batch, idx) => ({
      id: `${task.id}-batch-${idx}`,
      name: `${task.name} (batch ${idx + 1}/${batches.length})`,
      priority: task.priority,
      command: task.command,
      files: batch,
      contents: task.contents,
      workdir: task.workdir,
      env: task.env,
      timeoutSeconds: task.timeoutSeconds,
      sandboxOptions: task.sandboxOptions,
      maxRetries: task.maxRetries,
    }));

    return {
      originalTask: task,
      subTasks,
      strategy: this.name,
      description: `Split ${files.length} files into ${batches.length} batches of ~${this.batchSize}`,
    };
  }
}

/**
 * Split by content chunks. If a task has many content items to upload,
 * split them into batches.
 */
export class ContentBatchSplitStrategy implements TaskSplitStrategy {
  readonly name = "content-batch";

  private readonly batchSize: number;

  constructor(batchSize = 10) {
    this.batchSize = batchSize;
  }

  canSplit(task: SwarmTask): boolean {
    return (task.contents?.length ?? 0) > this.batchSize;
  }

  split(task: SwarmTask): TaskSplitResult {
    const contents = task.contents ?? [];
    const batches: typeof contents[] = [];

    for (let i = 0; i < contents.length; i += this.batchSize) {
      batches.push(contents.slice(i, i + this.batchSize));
    }

    const subTasks: SwarmTask[] = batches.map((batch, idx) => ({
      id: `${task.id}-content-${idx}`,
      name: `${task.name} (content ${idx + 1}/${batches.length})`,
      priority: task.priority,
      command: task.command,
      files: task.files,
      contents: batch,
      workdir: task.workdir,
      env: task.env,
      timeoutSeconds: task.timeoutSeconds,
      sandboxOptions: task.sandboxOptions,
      maxRetries: task.maxRetries,
    }));

    return {
      originalTask: task,
      subTasks,
      strategy: this.name,
      description: `Split ${contents.length} content items into ${batches.length} batches of ~${this.batchSize}`,
    };
  }
}

/**
 * Split by parallel commands. If a task's command contains multiple
 * independent commands joined by && or ;, split them.
 * Only splits when commands are clearly independent (joined by ; not &&).
 */
export class ParallelCommandSplitStrategy implements TaskSplitStrategy {
  readonly name = "parallel-command";

  canSplit(task: SwarmTask): boolean {
    // Only split if commands are joined by ; (independent), not && (dependent)
    const cmd = task.command;
    if (!cmd.includes(";")) return false;

    // Don't split if it has && (dependency chain)
    if (cmd.includes("&&")) return false;

    const parts = this.splitCommands(cmd);
    return parts.length > 1;
  }

  split(task: SwarmTask): TaskSplitResult {
    const parts = this.splitCommands(task.command);

    const subTasks: SwarmTask[] = parts.map((cmd, idx) => ({
      id: `${task.id}-cmd-${idx}`,
      name: `${task.name} (cmd ${idx + 1}/${parts.length})`,
      priority: task.priority,
      command: cmd.trim(),
      files: task.files,
      contents: task.contents,
      workdir: task.workdir,
      env: task.env,
      timeoutSeconds: task.timeoutSeconds,
      sandboxOptions: task.sandboxOptions,
      maxRetries: task.maxRetries,
    }));

    return {
      originalTask: task,
      subTasks,
      strategy: this.name,
      description: `Split ${parts.length} independent commands`,
    };
  }

  private splitCommands(command: string): string[] {
    // Split by ; but respect quoted strings
    const parts: string[] = [];
    let current = "";
    let inSingleQuote = false;
    let inDoubleQuote = false;

    for (let i = 0; i < command.length; i++) {
      const ch = command[i];
      if (ch === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        current += ch;
      } else if (ch === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        current += ch;
      } else if (ch === ";" && !inSingleQuote && !inDoubleQuote) {
        if (current.trim()) parts.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    if (current.trim()) parts.push(current.trim());

    return parts;
  }
}

/**
 * Custom split strategy using a user-provided function.
 */
export class CustomSplitStrategy implements TaskSplitStrategy {
  readonly name: string;

  private readonly predicate: (task: SwarmTask) => boolean;
  private readonly splitter: (task: SwarmTask) => SwarmTask[];

  constructor(
    name: string,
    predicate: (task: SwarmTask) => boolean,
    splitter: (task: SwarmTask) => SwarmTask[],
  ) {
    this.name = name;
    this.predicate = predicate;
    this.splitter = splitter;
  }

  canSplit(task: SwarmTask): boolean {
    return this.predicate(task);
  }

  split(task: SwarmTask): TaskSplitResult {
    const subTasks = this.splitter(task);
    return {
      originalTask: task,
      subTasks,
      strategy: this.name,
      description: `Custom split into ${subTasks.length} sub-tasks`,
    };
  }
}

// ── Task Splitter ────────────────────────────────────────────────────────────

/**
 * Task splitter that tries multiple strategies to split a task
 * into parallelizable sub-tasks.
 */
export class TaskSplitter {
  private readonly strategies: TaskSplitStrategy[];
  private readonly maxSubTasks: number;
  private readonly splitThreshold: number;

  constructor(options: TaskSplitterOptions = {}) {
    this.strategies = options.strategies ?? [
      new FileBatchSplitStrategy(),
      new ContentBatchSplitStrategy(),
      new ParallelCommandSplitStrategy(),
    ];
    this.maxSubTasks = options.maxSubTasks ?? 20;
    this.splitThreshold = options.splitThreshold ?? 1;
  }

  /**
   * Try to split a task. Returns null if no strategy can split it
   * or if the task doesn't meet the split threshold.
   */
  trySplit(task: SwarmTask): TaskSplitResult | null {
    // Check threshold — don't split trivial tasks
    const taskSize = this.estimateTaskSize(task);
    if (taskSize < this.splitThreshold) return null;

    for (const strategy of this.strategies) {
      if (strategy.canSplit(task)) {
        const result = strategy.split(task);

        // Cap at maxSubTasks
        if (result.subTasks.length > this.maxSubTasks) {
          return {
            ...result,
            subTasks: result.subTasks.slice(0, this.maxSubTasks),
            description: `${result.description} (capped at ${this.maxSubTasks})`,
          };
        }

        return result;
      }
    }

    return null;
  }

  /**
   * Force split a task using a specific strategy.
   */
  splitWith(task: SwarmTask, strategyName: string): TaskSplitResult | null {
    const strategy = this.strategies.find((s) => s.name === strategyName);
    if (!strategy || !strategy.canSplit(task)) return null;
    return strategy.split(task);
  }

  /**
   * Add a custom strategy at runtime.
   */
  addStrategy(strategy: TaskSplitStrategy): void {
    this.strategies.push(strategy);
  }

  /**
   * Estimate task complexity (higher = more likely to benefit from splitting).
   */
  private estimateTaskSize(task: SwarmTask): number {
    let size = 1;
    size += task.files?.length ?? 0;
    size += task.contents?.length ?? 0;
    // Multi-command tasks are bigger
    if (task.command.includes(";") || task.command.includes("&&")) {
      size += 2;
    }
    return size;
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/** Create a task splitter with default strategies */
export function createTaskSplitter(options?: TaskSplitterOptions): TaskSplitStrategy {
  return new TaskSplitter(options) as unknown as TaskSplitStrategy;
}

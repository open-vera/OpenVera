/**
 * SubagentOrchestrator — coordinate multiple subagents with patterns.
 *
 * Supports fan-out/fan-in (parallel), sequential pipelines,
 * and map-reduce style coordination.
 */

import { SubagentPool } from "./subagent-pool.js";
import { UnknownDependencyError, CircularDependencyError } from "../errors.js";

export type OrchestratorStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface OrchestratorTask {
  id: string;
  agentType: string;
  prompt: string;
  /** Dependencies — task won't start until these complete. */
  dependsOn?: string[];
  /** Inject results from dependencies as context. */
  injectResults?: boolean;
}

export interface OrchestratorResult {
  taskId: string;
  status: OrchestratorStatus;
  output?: string;
  error?: string;
  durationMs: number;
}

export interface OrchestratorRunOptions {
  /** Execute a single task. Should invoke a subagent and return its output. */
  executeTask: (task: OrchestratorTask, context: string) => Promise<string>;
  /** Called when each task completes. */
  onTaskComplete?: (taskId: string, output: string) => void;
  /** Called when each task fails. */
  onTaskFail?: (taskId: string, error: string) => void;
  /** Abort signal for the entire orchestration. */
  signal?: AbortSignal;
}

export class SubagentOrchestrator {
  private readonly tasks: OrchestratorTask[];
  private readonly results = new Map<string, OrchestratorResult>();
  private status: OrchestratorStatus = "pending";

  constructor(tasks: OrchestratorTask[]) {
    this.tasks = tasks;
    this.validateDeps();
  }

  /** Run all tasks respecting dependency order. */
  async run(opts: OrchestratorRunOptions): Promise<Map<string, OrchestratorResult>> {
    this.status = "running";
    const completed = new Set<string>();
    const failed = new Set<string>();

    const getRunnable = (): OrchestratorTask[] =>
      this.tasks.filter(
        (t) =>
          !completed.has(t.id) &&
          !failed.has(t.id) &&
          !this.results.has(t.id) &&
          (t.dependsOn ?? []).every((dep) => completed.has(dep))
      );

    while (true) {
      if (opts.signal?.aborted) {
        this.status = "cancelled";
        break;
      }

      const runnable = getRunnable();
      if (runnable.length === 0) {
        // Check if all done
        if (completed.size + failed.size >= this.tasks.length) break;
        // If no runnable but not all done, there's a deadlock (circular deps)
        if (runnable.length === 0 && this.results.size < this.tasks.length) {
          this.status = "failed";
          break;
        }
        break;
      }

      // Execute all runnable tasks in parallel
      const promises = runnable.map(async (task) => {
        const startMs = Date.now();

        try {
          // Gather context from dependencies
          const depContext = (task.dependsOn ?? [])
            .filter((dep) => completed.has(dep))
            .map((dep) => {
              const r = this.results.get(dep);
              return r?.output ? `[${dep}]: ${r.output}` : "";
            })
            .filter(Boolean)
            .join("\n\n");

          const output = await opts.executeTask(task, depContext);

          const result: OrchestratorResult = {
            taskId: task.id,
            status: "completed",
            output,
            durationMs: Date.now() - startMs,
          };
          this.results.set(task.id, result);
          completed.add(task.id);
          opts.onTaskComplete?.(task.id, output);
        } catch (err) {
          const result: OrchestratorResult = {
            taskId: task.id,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - startMs,
          };
          this.results.set(task.id, result);
          failed.add(task.id);
          opts.onTaskFail?.(task.id, result.error!);
        }
      });

      await Promise.allSettled(promises);
    }

    // Don't overwrite "cancelled" status set by abort signal
    if (this.status !== "cancelled") {
      this.status = completed.size === this.tasks.length ? "completed" : "failed";
    }
    return new Map(this.results);
  }

  /** Get all results. */
  getResults(): Map<string, OrchestratorResult> {
    return new Map(this.results);
  }

  /** Get orchestrator status. */
  getStatus(): OrchestratorStatus {
    return this.status;
  }

  /** Get summary of all task results. */
  getSummary(): string {
    const lines: string[] = [];
    for (const task of this.tasks) {
      const result = this.results.get(task.id);
      const icon = result?.status === "completed" ? "✅" : result?.status === "failed" ? "❌" : "⏳";
      lines.push(`${icon} ${task.id}: ${result?.status ?? "pending"}`);
      if (result?.error) lines.push(`   Error: ${result.error}`);
    }
    return lines.join("\n");
  }

  private validateDeps(): void {
    const taskIds = new Set(this.tasks.map((t) => t.id));
    for (const task of this.tasks) {
      for (const dep of task.dependsOn ?? []) {
        if (!taskIds.has(dep)) {
          throw new UnknownDependencyError(task.id, dep);
        }
      }
    }
    // Simple cycle detection via topological sort
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (id: string): boolean => {
      if (visited.has(id)) return true;
      if (visiting.has(id)) return false; // cycle
      visiting.add(id);
      const task = this.tasks.find((t) => t.id === id);
      for (const dep of task?.dependsOn ?? []) {
        if (!visit(dep)) return false;
      }
      visiting.delete(id);
      visited.add(id);
      return true;
    };
    for (const task of this.tasks) {
      if (!visit(task.id)) {
        throw new CircularDependencyError(task.id);
      }
    }
  }
}

// ── Convenience: Fan-out / Fan-in ──────────────────────────────────────────

/**
 * Run N independent tasks in parallel, collect all results.
 */
export function fanOut(
  tasks: Array<{ id: string; agentType: string; prompt: string }>,
  executeTask: (task: OrchestratorTask) => Promise<string>
): SubagentOrchestrator {
  return new SubagentOrchestrator(tasks);
}

/**
 * Create a sequential pipeline where each task feeds into the next.
 */
export function pipeline(
  tasks: Array<{ id: string; agentType: string; prompt: string }>
): SubagentOrchestrator {
  const pipelined: OrchestratorTask[] = tasks.map((task, i) => ({
    ...task,
    dependsOn: i > 0 ? [tasks[i - 1]!.id] : undefined,
    injectResults: i > 0,
  }));
  return new SubagentOrchestrator(pipelined);
}

/**
 * Map-reduce: run map tasks in parallel, then reduce with a final task.
 */
export function mapReduce(
  mapTasks: Array<{ id: string; agentType: string; prompt: string }>,
  reduceTask: { id: string; agentType: string; prompt: string }
): SubagentOrchestrator {
  const allTasks: OrchestratorTask[] = [
    ...mapTasks,
    {
      ...reduceTask,
      dependsOn: mapTasks.map((t) => t.id),
      injectResults: true,
    },
  ];
  return new SubagentOrchestrator(allTasks);
}

import type { AgentAssignment, StepResult } from "@open-vera/core/types";
import type { RunAssignmentOptions } from "../runtime/internal.js";

/**
 * AgentRunner — pluggable agent execution backend.
 *
 * Implement this interface to integrate any agent:
 *   - Local LLM loop (StreamAgentRunner, the default)
 *   - External CLI subprocess (ExternalCliRunner)
 *   - Remote HTTP agent API
 *   - Specialized coding agents (opencode, codex, etc.)
 */
export interface AgentRunner {
  /**
   * Execute one agent assignment and return the result.
   * The runner is responsible for all tool dispatch and producing
   * a final text output.
   */
  run(
    assignment: AgentAssignment,
    options: RunAssignmentOptions
  ): Promise<StepResult>;

  /**
   * Optional human-readable name for this runner.
   */
  name?: string;

  /**
   * Optional capabilities this runner supports.
   */
  capabilities?: AgentRunnerCapabilities;

  /**
   * Optional lifecycle hooks for the runner.
   */
  hooks?: AgentRunnerHooks;

  /**
   * Check if this runner is currently available and ready to execute.
   * Return { ready: true } or { ready: false, reason: "..." }.
   */
  isReady?(): Promise<RunnerReadiness>;
}

/**
 * Capabilities declared by an AgentRunner.
 * Used by the dispatcher to match steps to runners.
 */
export interface AgentRunnerCapabilities {
  /** Does this runner support tool/function calling? */
  supportsTools?: boolean;
  /** Does this runner support streaming output? */
  supportsStreaming?: boolean;
  /** Maximum context window size in tokens (approximate). */
  maxContextTokens?: number;
  /** Maximum output tokens per turn. */
  maxOutputTokens?: number;
  /** Supported tool names (empty = all tools via caller). */
  supportedTools?: string[];
  /** Tags for capability-based matching (e.g., ["coding", "search"]). */
  tags?: string[];
  /** Is this runner suitable for long-running tasks? */
  longRunning?: boolean;
}

/**
 * Lifecycle hooks for an AgentRunner.
 * Called by the harness at appropriate points during execution.
 */
export interface AgentRunnerHooks {
  /** Called before the runner starts executing an assignment. */
  onStart?: (assignment: AgentAssignment) => Promise<void> | void;
  /** Called after the runner completes an assignment successfully. */
  onComplete?: (assignment: AgentAssignment, result: StepResult) => Promise<void> | void;
  /** Called when the runner throws an error. */
  onError?: (assignment: AgentAssignment, error: Error) => Promise<void> | void;
}

/**
 * Result of a readiness check.
 */
export interface RunnerReadiness {
  ready: boolean;
  reason?: string;
}

/**
 * Registry of named AgentRunners.
 * "default" is used when a step has no assignedAgent.
 */
export type AgentRunnerMap = Map<string, AgentRunner>;

/**
 * AgentRunnerRegistry — manages runners with fallback support.
 * Wraps AgentRunnerMap with convenience methods.
 */
export class AgentRunnerRegistry {
  private readonly runners = new Map<string, AgentRunner>();

  register(name: string, runner: AgentRunner): void {
    runner.name = runner.name ?? name;
    this.runners.set(name, runner);
  }

  get(name: string): AgentRunner | undefined {
    return this.runners.get(name);
  }

  has(name: string): boolean {
    return this.runners.has(name);
  }

  /**
   * Get a runner by name, or fall back through the fallback chain.
   * Returns undefined if no runner is available.
   */
  async getAvailable(name: string, fallbacks: string[] = []): Promise<AgentRunner | undefined> {
    const names = [name, ...fallbacks];
    for (const n of names) {
      const runner = this.runners.get(n);
      if (!runner) continue;
      if (runner.isReady) {
        try {
          const readiness = await runner.isReady();
          if (readiness.ready) return runner;
        } catch {
          // isReady throwing → treat as not ready, skip
        }
      } else {
        return runner; // No readiness check = always ready
      }
    }
    return undefined;
  }

  /**
   * Find runners that match a set of required capabilities.
   */
  findByCapabilities(required: Partial<AgentRunnerCapabilities>): AgentRunner[] {
    const results: AgentRunner[] = [];
    for (const runner of this.runners.values()) {
      if (this.matchesCapabilities(runner, required)) {
        results.push(runner);
      }
    }
    return results;
  }

  list(): Array<{ name: string; runner: AgentRunner }> {
    return [...this.runners.entries()].map(([name, runner]) => ({ name, runner }));
  }

  /** Convert to AgentRunnerMap for backward compatibility. */
  toMap(): AgentRunnerMap {
    return new Map(this.runners);
  }

  private matchesCapabilities(
    runner: AgentRunner,
    required: Partial<AgentRunnerCapabilities>
  ): boolean {
    const caps = runner.capabilities;
    if (!caps) return Object.keys(required).length === 0; // No caps = matches nothing specific

    if (required.supportsTools && !caps.supportsTools) return false;
    if (required.supportsStreaming && !caps.supportsStreaming) return false;
    if (required.longRunning && !caps.longRunning) return false;
    if (required.maxContextTokens && (caps.maxContextTokens ?? Infinity) < required.maxContextTokens) return false;
    if (required.tags && required.tags.length > 0) {
      const runnerTags = new Set(caps.tags ?? []);
      if (!required.tags.every((t) => runnerTags.has(t))) return false;
    }
    return true;
  }
}

import {
  AdapterError,
  AgentError,
  ConfigError,
  DispatchError,
  FlowStateError,
  GitError,
  IntentError,
  PlannerError,
  ReplError,
  RuntimeError,
  SessionError,
  ToolError,
  ValidationError,
  VeraError,
} from "@open-vera/core/errors";
import type { PlanStep, TaskFlow } from "@open-vera/core/types";
import type { ArtifactStore, FlowHandle, TimelineEntry } from "./internal.js";
import { appendTimeline } from "./timeline.js";

// ── Failure category ──────────────────────────────────────────────────────────

export type FailureCategory =
  | "model"
  | "tool"
  | "permission"
  | "context"
  | "plan_deviation";

// ── Failure attribution result ────────────────────────────────────────────────

export interface FailureAttribution {
  stepId: string;
  category: FailureCategory;
  rootCause: string;
  errorCode: string;
  recoverable: boolean;
}

// ── Failed step for replay ────────────────────────────────────────────────────

export interface FailedStep {
  stepId: string;
  action: string;
  type: string;
  category: FailureCategory;
  rootCause: string;
  dependsOn: string[];
}

// ── Replay plan ──────────────────────────────────────────────────────────────

export interface ReplayPlan {
  /** Steps that have been reset to "pending" for re-execution */
  stepsToReplay: FailedStep[];
  /** Steps that were already completed and should be skipped */
  completedSteps: string[];
  /** Whether any steps were actually reset */
  hasReplayableSteps: boolean;
}

// ── Timeline failure entry ────────────────────────────────────────────────────

export interface FailureTimelineEntry {
  type: "failure";
  ts: string;
  stepId: string;
  category: FailureCategory;
  rootCause: string;
  error: string;
}

// ── Category mapping rules ────────────────────────────────────────────────────

interface CategoryRule {
  match: (error: unknown) => boolean;
  category: FailureCategory;
  rootCause: (error: unknown) => string;
  recoverable: boolean;
}

const CATEGORY_RULES: CategoryRule[] = [
  // Adapter errors → model (LLM returned bad output / request failed)
  {
    match: (e): e is AdapterError => e instanceof AdapterError,
    category: "model",
    rootCause: (e) => `LLM adapter error: ${(e as AdapterError).message}`,
    recoverable: true,
  },
  // Tool errors → tool execution failure
  {
    match: (e): e is ToolError => e instanceof ToolError,
    category: "tool",
    rootCause: (e) => `Tool execution failed: ${(e as ToolError).message}`,
    recoverable: true,
  },
  // Agent errors (remote runner, queue full, duplicate job) → tool
  {
    match: (e): e is AgentError => e instanceof AgentError,
    category: "tool",
    rootCause: (e) => `Agent execution failed: ${(e as AgentError).message}`,
    recoverable: true,
  },
  // Flow state / dispatch errors → plan deviation
  {
    match: (e): e is FlowStateError => e instanceof FlowStateError,
    category: "plan_deviation",
    rootCause: (e) =>
      `Illegal flow state transition: ${(e as FlowStateError).message}`,
    recoverable: false,
  },
  {
    match: (e): e is DispatchError => e instanceof DispatchError,
    category: "plan_deviation",
    rootCause: (e) => `Dispatch error: ${(e as DispatchError).message}`,
    recoverable: false,
  },
  // Runtime errors (checkpoint, fork config) → plan deviation
  {
    match: (e): e is RuntimeError => e instanceof RuntimeError,
    category: "plan_deviation",
    rootCause: (e) => `Runtime error: ${(e as RuntimeError).message}`,
    recoverable: false,
  },
  // Config errors → context
  {
    match: (e): e is ConfigError => e instanceof ConfigError,
    category: "context",
    rootCause: (e) => `Configuration error: ${(e as ConfigError).message}`,
    recoverable: true,
  },
  // Session errors → context
  {
    match: (e): e is SessionError => e instanceof SessionError,
    category: "context",
    rootCause: (e) => `Session error: ${(e as SessionError).message}`,
    recoverable: true,
  },
  // Planner errors → plan deviation
  {
    match: (e): e is PlannerError => e instanceof PlannerError,
    category: "plan_deviation",
    rootCause: (e) => `Planner error: ${(e as PlannerError).message}`,
    recoverable: true,
  },
  // Validation errors → context
  {
    match: (e): e is ValidationError => e instanceof ValidationError,
    category: "context",
    rootCause: (e) => `Validation error: ${(e as ValidationError).message}`,
    recoverable: true,
  },
  // Git errors → tool
  {
    match: (e): e is GitError => e instanceof GitError,
    category: "tool",
    rootCause: (e) => `Git operation failed: ${(e as GitError).message}`,
    recoverable: true,
  },
  // Intent errors → context
  {
    match: (e): e is IntentError => e instanceof IntentError,
    category: "context",
    rootCause: (e) => `Intent resolution failed: ${(e as IntentError).message}`,
    recoverable: true,
  },
  // Repl errors → tool
  {
    match: (e): e is ReplError => e instanceof ReplError,
    category: "tool",
    rootCause: (e) => `REPL error: ${(e as ReplError).message}`,
    recoverable: true,
  },
  // Permission heuristic: look for 403 / 401 / "permission" / "denied" in message
  {
    match: (e) => {
      const msg = extractErrorMessage(e).toLowerCase();
      return (
        msg.includes("permission") ||
        msg.includes("denied") ||
        msg.includes("403") ||
        msg.includes("401") ||
        msg.includes("unauthorized") ||
        msg.includes("forbidden")
      );
    },
    category: "permission",
    rootCause: (e) => `Permission denied: ${extractErrorMessage(e)}`,
    recoverable: false,
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function now(): string {
  return new Date().toISOString();
}

function categorize(error: unknown): {
  category: FailureCategory;
  rootCause: string;
  recoverable: boolean;
} {
  for (const rule of CATEGORY_RULES) {
    if (rule.match(error)) {
      return {
        category: rule.category,
        rootCause: rule.rootCause(error),
        recoverable: rule.recoverable,
      };
    }
  }
  // Default: unknown error → context
  return {
    category: "context",
    rootCause: `Unknown error: ${extractErrorMessage(error)}`,
    recoverable: false,
  };
}

// ── FailureAttributor ─────────────────────────────────────────────────────────

export class FailureAttributor {
  /**
   * Attribute root cause of a failed step and record it to the session timeline.
   */
  async attribute(
    handle: FlowHandle,
    failedStepId: string,
    error: unknown
  ): Promise<FailureAttribution> {
    const { category, rootCause, recoverable } = categorize(error);
    const errorCode =
      error instanceof VeraError ? error.code : "UNKNOWN_ERROR";

    const entry = {
      type: "failure" as const,
      ts: now(),
      stepId: failedStepId,
      category,
      rootCause,
      error: extractErrorMessage(error),
    };

    await appendTimeline(handle.store, entry as unknown as TimelineEntry);

    return {
      stepId: failedStepId,
      category,
      rootCause,
      errorCode,
      recoverable,
    };
  }

  /**
   * Extract all failed steps from a flow that can be re-executed.
   */
  extractFailedSteps(handle: FlowHandle): FailedStep[] {
    const plan = handle.flow.plan;
    if (!plan) return [];

    const failedSteps: FailedStep[] = [];

    for (const step of plan.steps) {
      if (step.status === "failed") {
        failedSteps.push({
          stepId: step.id,
          action: step.action,
          type: step.type,
          category: "tool",
          rootCause: `Step ${step.id} failed during execution`,
          dependsOn: step.dependsOn ?? [],
        });
      }
    }

    return failedSteps;
  }

  /**
   * Prepare a replay plan: reset failed steps to "pending" and update flow state.
   * Call this before re-executing failed steps through the runtime.
   */
  prepareReplay(handle: FlowHandle): ReplayPlan {
    const plan = handle.flow.plan;
    if (!plan) {
      return { stepsToReplay: [], completedSteps: [], hasReplayableSteps: false };
    }

    const stepsToReplay: FailedStep[] = [];
    const completedSteps: string[] = [];

    for (const step of plan.steps) {
      if (step.status === "failed") {
        stepsToReplay.push({
          stepId: step.id,
          action: step.action,
          type: step.type,
          category: "tool",
          rootCause: `Step ${step.id} failed during execution`,
          dependsOn: step.dependsOn ?? [],
        });
        step.status = "pending";
      } else if (step.status === "done") {
        completedSteps.push(step.id);
      }
    }

    // Reset flow state so the runtime can re-execute
    if (stepsToReplay.length > 0) {
      handle.flow.state = "executing";
      handle.flow.activeStepId = undefined;
    }

    return {
      stepsToReplay,
      completedSteps,
      hasReplayableSteps: stepsToReplay.length > 0,
    };
  }

  /**
   * Synchronous categorization without timeline recording.
   * Useful for diagnostics and testing.
   */
  categorizeError(error: unknown): FailureAttribution {
    const { category, rootCause, recoverable } = categorize(error);
    const errorCode =
      error instanceof VeraError ? error.code : "UNKNOWN_ERROR";

    return {
      stepId: "",
      category,
      rootCause,
      errorCode,
      recoverable,
    };
  }
}

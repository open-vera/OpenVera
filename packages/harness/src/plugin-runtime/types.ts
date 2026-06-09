/**
 * Shared types for the plugin-runtime module.
 *
 * These are lightweight structural types that the event-bus and hooks need.
 * They are intentionally decoupled from runtime/internal.ts so that external
 * plugin packages only depend on @open-vera/harness plugin API, not internals.
 */

import type { ExecutionPlan, StepResult } from "@open-vera/core/types";

// Re-export StepResult for convenience
export type { StepResult };

/** Describes what changed between the original and replanned execution plan. */
export interface PlanDiff {
  /** Step ids that were "done" in the original and are preserved unchanged. */
  preserved: string[];
  /** Non-done step ids that existed in both plans but were changed by the LLM. */
  modified: string[];
  /** New step ids introduced by the LLM. */
  added: string[];
  /** Non-done step ids from the original that the LLM dropped. */
  removed: string[];
}

/** Result returned by runFlowLoop. */
export interface FlowLoopResult {
  completedSteps: string[];
  failedStepId?: string;
  pausedOnStepId?: string;
}

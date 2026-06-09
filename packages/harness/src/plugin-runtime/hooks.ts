/**
 * Hook protocol for Harness plugins.
 *
 * Hooks are interception points that allow plugins to modify the execution
 * flow. Unlike events (which are async subscriptions), hooks run inline and
 * can transform data or short-circuit execution.
 *
 * Hook semantics:
 * - Multiple plugins can register the same hook; they run in registration order.
 * - "before*" hooks receive input and return (possibly modified) input.
 *   Return `undefined` or the same value to pass through.
 * - "after*" hooks receive output and return (possibly modified) output.
 * - Returning `false` from `beforeStep` skips the step entirely.
 */

import type { ExecutionPlan, PolicyProposal, StepResult } from "@open-vera/core/types";

export interface HarnessHooks {
  // ---------------------------------------------------------------------------
  // Interception hooks (can modify flow)
  // ---------------------------------------------------------------------------

  /**
   * Called before the planner generates an ExecutionPlan.
   * Return a modified goal string to rewrite the input.
   */
  beforePlan?: (goal: string) => Promise<string>;

  /**
   * Called after the planner generates an ExecutionPlan.
   * Return a modified plan to override what gets executed.
   */
  afterPlan?: (plan: ExecutionPlan) => Promise<ExecutionPlan>;

  /**
   * Called before a step is dispatched.
   * Return `false` to skip this step; return `true` or `undefined` to proceed.
   */
  beforeStep?: (stepId: string) => Promise<boolean | void>;

  /**
   * Called after a step completes and before critique.
   * Return a modified StepResult to alter what the critique sees.
   */
  afterStep?: (stepId: string, result: StepResult) => Promise<StepResult>;

  /**
   * Called before a critique runs (both plan and step critique).
   * Return modified input to alter what the challenger reviews.
   */
  beforeCritique?: (input: unknown) => Promise<unknown>;

  // ---------------------------------------------------------------------------
  // Extension hooks (inject additional capabilities)
  // ---------------------------------------------------------------------------

  /**
   * Resolve a skill by intent. If the plugin can resolve it, return a
   * SkillBundle-like object; otherwise return null to fall through.
   */
  resolveSkill?: (intent: string) => Promise<{
    system: string;
    tools: unknown[];
    executors: Map<string, unknown>;
  } | null>;

  /**
   * Propose policy actions (e.g. self-improvement proposals).
   * Called at flow completion; returns proposals to record.
   */
  proposeAction?: (context: {
    flowId: string;
    completedSteps: string[];
  }) => Promise<PolicyProposal[]>;
}

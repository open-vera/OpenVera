/**
 * SelfLoopRunner — orchestrates multi-cycle plan-execute-critique loops.
 *
 * Each cycle:
 *   1. Executes the full plan via HarnessRuntime.runFlowLoop
 *   2. Collects the cycle result
 *   3. Runs a meta-critique (via CriticAgent if provided, heuristic otherwise)
 *   4. Decides: continue / stop / replan
 *
 * Termination conditions (S2):
 *   - confidence >= confidenceThreshold (default 0.9)
 *   - cycle count >= maxCycles (default 5)
 *   - accumulated cost >= budgetUsd
 *   - consecutive duplicate critiques detected → replan or stop
 *
 * Each cycle writes a cycle_end JSONL entry to the session timeline (S3).
 */

import type { StepResult } from "@open-vera/core/types";
import type { HarnessRuntime } from "../runtime/runtime.js";
import type { FlowHandle, FlowLoopResult } from "../runtime/internal.js";
import type { CriticAgent, CriticResult } from "../critic/index.js";

// ── Public types ──────────────────────────────────────────────────────────────

/** Outcome of a single self-loop cycle. */
export interface CycleEntry {
  cycleNumber: number;
  critiqueSummary: string;
  shouldReplan: boolean;
  confidence: number;
  cost: number;
  completedSteps: string[];
  failedStepId?: string;
  terminationReason?: TerminationReason;
}

/** Reasons the self-loop can terminate. */
export type TerminationReason =
  | "max_cycles"
  | "high_confidence"
  | "budget_exceeded"
  | "duplicate_critique"
  | "flow_failed"
  | "flow_paused";

/** Final result of the self-loop run. */
export interface SelfLoopResult {
  handle: FlowHandle;
  cycles: CycleEntry[];
  terminationReason: TerminationReason;
  totalCost: number;
}

/** Configuration for SelfLoopRunner. */
export interface SelfLoopRunnerConfig {
  /** Maximum number of cycles before forced stop. Default: 5. */
  maxCycles?: number;
  /** Confidence threshold at or above which the loop stops. Default: 0.9. */
  confidenceThreshold?: number;
  /** Maximum accumulated USD cost before forced stop. */
  budgetUsd?: number;
  /** Number of consecutive duplicate critiques before stopping. Default: 2. */
  duplicateThreshold?: number;
  /** Max steps per flow loop cycle. */
  maxStepsPerCycle?: number;
}

// ── Internal types ────────────────────────────────────────────────────────────

/** JSONL entry written at the end of each cycle. */
interface CycleTimelineEntry {
  type: "cycle_end";
  ts: string;
  cycleNumber: number;
  confidence: number;
  shouldReplan: boolean;
  cost: number;
  summary: string;
  terminationReason?: TerminationReason;
}

/** Decision returned by the critique/termination analysis. */
interface CycleDecision {
  action: "continue" | "stop" | "replan";
  reason?: TerminationReason;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_CYCLES = 5;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.9;
const DEFAULT_DUPLICATE_THRESHOLD = 2;
const ESTIMATED_COST_PER_STEP_USD = 0.02;

// ── SelfLoopRunner ────────────────────────────────────────────────────────────

export class SelfLoopRunner {
  private readonly runtime: HarnessRuntime;
  private readonly critic: CriticAgent | undefined;
  private readonly config: Required<
    Pick<SelfLoopRunnerConfig, "maxCycles" | "confidenceThreshold" | "duplicateThreshold">
  > &
    Pick<SelfLoopRunnerConfig, "budgetUsd" | "maxStepsPerCycle">;

  constructor(
    runtime: HarnessRuntime,
    critic: CriticAgent | undefined,
    config: SelfLoopRunnerConfig = {}
  ) {
    this.runtime = runtime;
    this.critic = critic;
    this.config = {
      maxCycles: config.maxCycles ?? DEFAULT_MAX_CYCLES,
      confidenceThreshold: config.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
      duplicateThreshold: config.duplicateThreshold ?? DEFAULT_DUPLICATE_THRESHOLD,
      budgetUsd: config.budgetUsd,
      maxStepsPerCycle: config.maxStepsPerCycle,
    };
  }

  /**
   * Run the self-loop from an initial FlowHandle.
   *
   * Each iteration executes the full plan, critiques the result, and decides
   * whether to continue with another cycle or stop.
   */
  async run(initialHandle: FlowHandle): Promise<SelfLoopResult> {
    let handle = initialHandle;
    const entries: CycleEntry[] = [];
    let accumulatedCost = 0;
    let terminationReason: TerminationReason | undefined;

    for (let cycle = 1; cycle <= this.config.maxCycles; cycle++) {
      // Execute the full plan via the flow loop
      const flowResult = await this.runtime.runFlowLoop(handle, {
        maxSteps: this.config.maxStepsPerCycle,
      });
      handle = flowResult.handle;
      const cycleCost = this.estimateCycleCost(flowResult);
      accumulatedCost += cycleCost;

      // Meta-critique this cycle
      const critique = await this.runCycleCritique(flowResult);
      const critiqueSummary = this.summarizeCritique(critique);

      // Decide next action
      const decision = this.evaluateDecision(critique, cycle, accumulatedCost);
      const shouldReplan = decision.action === "replan";

      const entry: CycleEntry = {
        cycleNumber: cycle,
        critiqueSummary,
        shouldReplan,
        confidence: critique.confidence,
        cost: cycleCost,
        completedSteps: flowResult.completedSteps,
        failedStepId: flowResult.failedStepId,
        terminationReason: decision.reason,
      };
      entries.push(entry);

      // Write cycle_end JSONL entry to session timeline
      await this.appendCycleTimeline(handle, entry);

      // If termination triggered, stop
      if (decision.action === "stop") {
        terminationReason = decision.reason;
        break;
      }

      // If replan requested, prepare for next cycle
      if (decision.action === "replan") {
        handle = await this.replanForNextCycle(handle, flowResult, critique);
      }
    }

    // If we exhausted all cycles without explicit termination
    if (!terminationReason) {
      terminationReason = "max_cycles";
    }

    return {
      handle,
      cycles: entries,
      terminationReason,
      totalCost: accumulatedCost,
    };
  }

  // ── Critique ──────────────────────────────────────────────────────────────

  /**
   * Run meta-critique on the cycle result.
   * Uses CriticAgent if available, otherwise extracts a heuristic assessment.
   */
  private async runCycleCritique(flowResult: FlowLoopResult): Promise<CriticResult> {
    if (this.critic) {
      return this.criticWithAgent(flowResult);
    }
    return this.heuristicCritique(flowResult);
  }

  private async criticWithAgent(flowResult: FlowLoopResult): Promise<CriticResult> {
    const stepResults = this.extractStepResults(flowResult);
    const planContext = {
      plan: flowResult.handle.flow.plan!,
      projectContext: flowResult.handle.flow.goal,
    };
    return this.critic!.critique(stepResults, planContext);
  }

  /**
   * Heuristic critique when no CriticAgent is available.
   * Derives confidence from flow completion state and step critique scores.
   */
  private heuristicCritique(flowResult: FlowLoopResult): CriticResult {
    const flow = flowResult.handle.flow;

    if (flow.state === "failed") {
      return {
        issues: [`Flow failed at step: ${flowResult.failedStepId ?? "unknown"}`],
        confidence: 0,
        nextAction: "replan",
        reasoning: "Flow execution failed; replanning may help.",
      };
    }

    if (flow.state === "completed") {
      return {
        issues: [],
        confidence: 1.0,
        nextAction: "stop",
        reasoning: "Flow completed successfully.",
      };
    }

    if (flowResult.pausedOnStepId) {
      return {
        issues: [`Flow paused at step: ${flowResult.pausedOnStepId}`],
        confidence: 0.5,
        nextAction: "stop",
        reasoning: "Flow is waiting for human input.",
      };
    }

    // Partially completed
    const totalSteps = flow.plan?.steps.length ?? 0;
    const completedCount = flowResult.completedSteps.length;
    const confidence = totalSteps > 0 ? completedCount / totalSteps : 0;

    return {
      issues:
        completedCount < totalSteps
          ? [`Only ${completedCount}/${totalSteps} steps completed`]
          : [],
      confidence,
      nextAction: confidence >= this.config.confidenceThreshold ? "stop" : "replan",
      reasoning: `Completed ${completedCount}/${totalSteps} steps.`,
    };
  }

  // ── Termination decision (S2) ─────────────────────────────────────────────

  /**
   * Evaluate termination conditions and decide next action.
   *
   * Priority order:
   *   1. confidence >= threshold → stop (high_confidence)
   *   2. maxCycles reached → stop (max_cycles)
   *   3. budgetUsd exceeded → stop (budget_exceeded)
   *   4. consecutive duplicate critiques → stop (duplicate_critique)
   *   5. otherwise → continue or replan based on critique
   */
  private evaluateDecision(
    critique: CriticResult,
    currentCycle: number,
    accumulatedCost: number
  ): CycleDecision {
    // 1. High confidence → stop
    if (critique.confidence >= this.config.confidenceThreshold) {
      return { action: "stop", reason: "high_confidence" };
    }

    // 2. Max cycles reached → stop
    if (currentCycle >= this.config.maxCycles) {
      return { action: "stop", reason: "max_cycles" };
    }

    // 3. Budget exceeded → stop
    if (
      this.config.budgetUsd !== undefined &&
      accumulatedCost >= this.config.budgetUsd
    ) {
      return { action: "stop", reason: "budget_exceeded" };
    }

    // 4. Consecutive duplicate critiques → replan instead of looping
    if (this.detectDuplicateCritique(critique)) {
      return { action: "replan", reason: "duplicate_critique" };
    }

    // 5. Follow the critique's recommendation
    if (critique.nextAction === "replan") {
      return { action: "replan" };
    }

    return { action: "continue" };
  }

  /**
   * Detect if the current critique is a duplicate of a recent one.
   * After `duplicateThreshold` consecutive duplicates, returns true.
   *
   * A critique is "duplicate" if it shares the same set of issues as the
   * previous critique (same issues, same count).
   */
  private detectDuplicateCritique(critique: CriticResult): boolean {
    const entries = this.getCycleHistory();
    if (entries.length < this.config.duplicateThreshold) return false;

    const recentEntries = entries.slice(-this.config.duplicateThreshold);
    const currentKey = this.critiqueKey(critique);

    return recentEntries.every((entry) => this.entryKey(entry) === currentKey);
  }

  /**
   * Generate a stable key for duplicate detection from a CriticResult.
   * Uses sorted issue list as the identity of a critique.
   */
  private critiqueKey(critique: CriticResult): string {
    const sorted = [...critique.issues].sort();
    return `issues:[${sorted.join("|")}]`;
  }

  /**
   * Extract a comparable key from a CycleEntry.
   * Parses the issue list from critiqueSummary to match critiqueKey format.
   */
  private entryKey(entry: CycleEntry): string {
    // critiqueSummary format: "confidence=X.XX: issue1; issue2" or "confidence=X.XX: no issues"
    const colonIdx = entry.critiqueSummary.indexOf(": ");
    if (colonIdx === -1) return entry.critiqueSummary;
    const issuesPart = entry.critiqueSummary.slice(colonIdx + 2);
    if (issuesPart === "no issues") return "issues:[]";
    const issues = issuesPart.split("; ").sort();
    return `issues:[${issues.join("|")}]`;
  }

  // ── Replan ────────────────────────────────────────────────────────────────

  /**
   * Prepare the handle for the next cycle after a replan decision.
   * The runtime's replanFlow creates a revised plan; we reset to dispatching.
   */
  private async replanForNextCycle(
    handle: FlowHandle,
    flowResult: FlowLoopResult,
    critique: CriticResult
  ): Promise<FlowHandle> {
    const failedStepId = flowResult.failedStepId ?? flowResult.handle.flow.activeStepId;
    if (!failedStepId || !handle.flow.plan) {
      // Can't replan without a failed step or plan; return as-is
      return handle;
    }

    const { handle: replanned } = await this.runtime.replanFlow(handle, {
      plan: handle.flow.plan,
      failedStepId,
      critique: {
        confidence: critique.confidence,
        issues: critique.issues,
        missingChecks: [],
        nextAction: "replan",
        rationale: critique.reasoning,
      },
      projectContext: handle.flow.goal,
    });

    return replanned;
  }

  // ── Cycle history (for duplicate detection) ───────────────────────────────

  private cycleHistory: CycleEntry[] = [];

  private getCycleHistory(): CycleEntry[] {
    return this.cycleHistory;
  }

  private recordCycle(entry: CycleEntry): void {
    this.cycleHistory.push(entry);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private extractStepResults(flowResult: FlowLoopResult): StepResult[] {
    // Extract StepResult artifacts from the flow's artifact list.
    // Step results are stored as artifacts with type "step_result".
    const artifacts = flowResult.handle.flow.artifacts;
    const results: StepResult[] = [];

    for (const artifact of artifacts) {
      if (artifact.type === "step_result") {
        // The artifact summary is the stepId; the actual result is in the
        // artifact file. For the critic, we construct a minimal StepResult
        // from what's available on the flow.
        results.push({
          flowId: flowResult.handle.flow.flowId,
          stepId: artifact.summary ?? artifact.id,
          output: "",
          toolCalls: [],
        });
      }
    }

    return results;
  }

  private estimateCycleCost(flowResult: FlowLoopResult): number {
    // Use budget tracking if available, otherwise estimate from steps
    const usdUsed = flowResult.handle.flow.budget.usdUsed;
    if (usdUsed !== undefined && usdUsed > 0) {
      return usdUsed;
    }
    return flowResult.completedSteps.length * ESTIMATED_COST_PER_STEP_USD;
  }

  private summarizeCritique(critique: CriticResult): string {
    if (critique.issues.length === 0) {
      return `confidence=${critique.confidence.toFixed(2)}: no issues`;
    }
    return `confidence=${critique.confidence.toFixed(2)}: ${critique.issues.join("; ")}`;
  }

  // ── JSONL cycle_end entry (S3) ────────────────────────────────────────────

  /**
   * Write a cycle_end JSONL entry to the session timeline file.
   * Appends to timeline.ndjson alongside the existing flow events.
   */
  private async appendCycleTimeline(
    handle: FlowHandle,
    entry: CycleEntry
  ): Promise<void> {
    this.recordCycle(entry);

    const timelineEntry: CycleTimelineEntry = {
      type: "cycle_end",
      ts: new Date().toISOString(),
      cycleNumber: entry.cycleNumber,
      confidence: entry.confidence,
      shouldReplan: entry.shouldReplan,
      cost: entry.cost,
      summary: entry.critiqueSummary,
      terminationReason: entry.terminationReason,
    };

    const { appendFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const path = join(handle.store.flowDir, "timeline.ndjson");
    await appendFile(path, `${JSON.stringify(timelineEntry)}\n`, "utf-8");
  }
}

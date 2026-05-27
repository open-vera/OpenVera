import type { LLMAdapter } from "@open-vera/core/adapters";
import type { StepResult, ExecutionPlan } from "@open-vera/core/types";
import { completeJson } from "../runtime/json.js";

// ── Public types ──────────────────────────────────────────────────────────────

/** Structured output from the critic LLM evaluation. */
export interface CriticResult {
  issues: string[];
  confidence: number;
  nextAction: "continue" | "replan" | "stop";
  reasoning: string;
}

/** Input context for a critique evaluation. */
export interface PlanContext {
  plan: ExecutionPlan;
  projectContext?: string;
  customChallenge?: string;
}

/** A single round in the debate between main agent and critic. */
export interface DebateRound {
  round: number;
  mainAgentResponse: string;
  critique: CriticResult;
}

/** Full result of a debate exchange. */
export interface DebateResult {
  rounds: DebateRound[];
  finalCritique: CriticResult;
  totalRounds: number;
  stopReason: "max_rounds" | "high_confidence" | "no_new_issues";
}

/** Summarized view of a step result for prompt construction. */
interface StepSummary {
  stepId: string;
  output: string;
  toolCallCount: number;
  toolCallsSummary: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_DEBATE_ROUNDS = 3;
const HIGH_CONFIDENCE_THRESHOLD = 0.8;

// ── Prompt template ───────────────────────────────────────────────────────────

/**
 * Generate the structured prompt that asks the LLM to evaluate step results
 * against the plan and produce a CriticResult.
 */
export function critiquePrompt(
  stepResults: StepResult[],
  planContext: PlanContext,
  mainAgentResponse?: string,
  priorIssues?: string[]
): string {
  const stepSummaries = stepResults.map(buildStepSummary);
  const stepsBlock = stepSummaries.map(formatStepSummary).join("\n\n");
  const plan = planContext.plan;

  const stepsList = plan.steps
    .map(
      (s, i) =>
        `${i + 1}. [${s.status}] ${s.id}: ${s.action} (type=${s.type})`
    )
    .join("\n");

  const sections: string[] = [
    `You are a strict quality reviewer evaluating plan execution results.`,
    ``,
    `## Plan`,
    `Goal: ${plan.goal}`,
    `Risk: ${plan.risk}`,
    `Assumptions: ${plan.assumptions.join("; ") || "(none)"}`,
    ``,
    `## Plan Steps`,
    stepsList,
    ``,
    `## Step Results`,
    stepsBlock || "(no step results provided)",
  ];

  if (planContext.projectContext) {
    sections.push(``, `## Project Context`, planContext.projectContext);
  }

  if (mainAgentResponse) {
    sections.push(
      ``,
      `## Main Agent Response (under review)`,
      mainAgentResponse
    );
  }

  if (priorIssues && priorIssues.length > 0) {
    sections.push(
      ``,
      `## Previously Raised Issues (do not repeat unless still unresolved)`,
      ...priorIssues.map((issue) => `- ${issue}`)
    );
  }

  if (planContext.customChallenge) {
    sections.push(``, `## Additional Challenge`, planContext.customChallenge);
  }

  sections.push(
    ``,
    `## Instructions`,
    `Evaluate the step results against the plan. Identify specific, actionable issues.`,
    `Rate your confidence that the execution is correct (0.0 = no confidence, 1.0 = fully confident).`,
    `Suggest the next action: "continue" if results are acceptable, "replan" if the plan needs revision, "stop" if execution should halt.`,
    ``,
    `Return JSON only:`,
    `{`,
    `  "issues": ["specific actionable issue 1", "..."],`,
    `  "confidence": 0.0,`,
    `  "nextAction": "continue" | "replan" | "stop",`,
    `  "reasoning": "overall assessment explaining the confidence and nextAction"`,
    `}`
  );

  return sections.join("\n");
}

// ── CriticAgent ───────────────────────────────────────────────────────────────

/**
 * CriticAgent — independent agent that reviews plan execution results.
 *
 * Produces structured critiques via an LLM adapter and supports a limited
 * debate loop (max 3 rounds) between the main agent and the critic.
 */
export class CriticAgent {
  constructor(
    private readonly adapter: LLMAdapter,
    private readonly model: string,
    private readonly maxDebateRounds: number = DEFAULT_MAX_DEBATE_ROUNDS
  ) {}

  /**
   * Evaluate step results against the plan and return a structured critique.
   */
  async critique(
    stepResults: StepResult[],
    planContext: PlanContext
  ): Promise<CriticResult> {
    const prompt = critiquePrompt(stepResults, planContext);
    const result = await completeJson<Record<string, unknown>>(
      this.adapter,
      this.model,
      prompt
    );
    return normalizeCriticResult(result.parsed);
  }

  /**
   * Run a limited debate between the main agent and the critic.
   *
   * Flow:
   *   1. Critic evaluates the main agent's initial response
   *   2. If confidence >= threshold or no new issues → stop
   *   3. Main agent adjusts its response (via `mainAgentDefend`)
   *   4. Critic re-evaluates, considering prior issues
   *   5. Repeat until max rounds or early stop
   *
   * @param mainAgentResponse - The main agent's initial response to critique
   * @param stepResults - Step execution results for context
   * @param planContext - Plan context for evaluation
   * @param mainAgentDefend - Callback that produces the main agent's defense
   *   given the current critique. If it returns `undefined`, the debate ends.
   */
  async debate(
    mainAgentResponse: string,
    stepResults: StepResult[],
    planContext: PlanContext,
    mainAgentDefend: (critique: CriticResult) => Promise<string | undefined>
  ): Promise<DebateResult> {
    const rounds: DebateRound[] = [];
    let currentResponse = mainAgentResponse;
    let priorIssues: string[] = [];
    let stopReason: DebateResult["stopReason"] = "max_rounds";

    for (let round = 1; round <= this.maxDebateRounds; round++) {
      const prompt = critiquePrompt(
        stepResults,
        planContext,
        currentResponse,
        priorIssues
      );
      const raw = await completeJson<Record<string, unknown>>(
        this.adapter,
        this.model,
        prompt
      );
      const critique = normalizeCriticResult(raw.parsed);

      rounds.push({ round, mainAgentResponse: currentResponse, critique });

      // Early stop: high confidence
      if (critique.confidence >= HIGH_CONFIDENCE_THRESHOLD) {
        stopReason = "high_confidence";
        break;
      }

      // Early stop: no new issues (and we have prior rounds to compare)
      if (
        round > 1 &&
        critique.issues.length > 0 &&
        areAllIssuesKnown(critique.issues, priorIssues)
      ) {
        stopReason = "no_new_issues";
        break;
      }

      // Last round — no more debate
      if (round >= this.maxDebateRounds) {
        stopReason = "max_rounds";
        break;
      }

      // Ask main agent to defend
      const defense = await mainAgentDefend(critique);
      if (defense === undefined) {
        // Main agent chose not to defend — end debate
        break;
      }

      priorIssues = [...priorIssues, ...critique.issues];
      currentResponse = defense;
    }

    const finalCritique = rounds[rounds.length - 1]?.critique ?? {
      issues: [],
      confidence: 0,
      nextAction: "stop" as const,
      reasoning: "No critique rounds completed",
    };

    return {
      rounds,
      finalCritique,
      totalRounds: rounds.length,
      stopReason,
    };
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function buildStepSummary(result: StepResult): StepSummary {
  const toolCallsSummary =
    result.toolCalls.length > 0
      ? result.toolCalls
          .map((tc) => `${tc.name}(${JSON.stringify(tc.arguments)})`)
          .join(", ")
      : "(none)";

  return {
    stepId: result.stepId,
    output: result.output.slice(0, 2000),
    toolCallCount: result.toolCalls.length,
    toolCallsSummary,
  };
}

function formatStepSummary(summary: StepSummary): string {
  return [
    `### Step: ${summary.stepId}`,
    `Tool calls (${summary.toolCallCount}): ${summary.toolCallsSummary}`,
    `Output:\n${summary.output}`,
  ].join("\n");
}

/**
 * Normalize a raw LLM-parsed result into a valid CriticResult.
 * Handles missing fields, out-of-range confidence, and invalid nextAction.
 */
function normalizeCriticResult(raw: Record<string, unknown>): CriticResult {
  const issues = Array.isArray(raw["issues"])
    ? (raw["issues"] as unknown[]).filter((i): i is string => typeof i === "string")
    : [];

  let confidence = typeof raw["confidence"] === "number" ? raw["confidence"] : 0;
  confidence = Math.max(0, Math.min(1, confidence));

  const validActions = new Set(["continue", "replan", "stop"]);
  const rawAction = typeof raw["nextAction"] === "string" ? raw["nextAction"] : "continue";
  const nextAction = validActions.has(rawAction)
    ? (rawAction as CriticResult["nextAction"])
    : "continue";

  const reasoning =
    typeof raw["reasoning"] === "string"
      ? raw["reasoning"]
      : typeof raw["rationale"] === "string"
        ? raw["rationale"]
        : "No reasoning provided";

  return { issues, confidence, nextAction, reasoning };
}

/**
 * Check whether all issues in the current set were already raised in prior rounds.
 * Used to detect stale critiques for early-stop.
 */
function areAllIssuesKnown(current: string[], prior: string[]): boolean {
  if (prior.length === 0) return false;
  const priorSet = new Set(prior);
  return current.every((issue) => priorSet.has(issue));
}

import type { LLMAdapter } from "@open-vera/core/adapters";
import type {
  CritiqueResult,
  ExecutionPlan,
  PlanStep,
  RetrospectiveResult,
  StepResult,
} from "@open-vera/core/types";
import { completeJson } from "./json.js";
import type {
  LegacyChallengeIssue,
  LegacyChallengeResult,
  PlanCritiqueInput,
  PlanDiff,
  ReplanInput,
  StepCritiqueArtifact,
  StepCritiqueInput,
} from "./internal.js";

function toIssueText(issue: LegacyChallengeIssue): string {
  return `[${issue.severity}] ${issue.issue}${issue.suggestion ? ` -> ${issue.suggestion}` : ""}`;
}

export function adaptChallengeToCritique(
  result: LegacyChallengeResult
): CritiqueResult {
  return {
    confidence: Number.isFinite(result.score) ? result.score : 0,
    issues: result.critiques.map(toIssueText),
    missingChecks: [...result.requiredFixes],
    nextAction: result.passed ? "complete" : "replan",
    rationale: result.verdict,
  };
}

/**
 * Extract a structured outputs map from a StepResult so that the Challenger
 * gets richer context: the agent's prose output AND a summary of every tool
 * call it made during the step.
 */
export function buildStepCritiqueOutputs(
  result: StepResult
): Record<string, string> {
  const outputs: Record<string, string> = {};

  if (result.output) {
    outputs["output"] = result.output;
  }

  if (result.toolCalls.length > 0) {
    outputs["tool_calls"] = result.toolCalls
      .map(
        (tc) =>
          `[${tc.name}]\nargs: ${JSON.stringify(tc.arguments)}\nresult: ${tc.result}`
      )
      .join("\n\n");
  }

  return outputs;
}

export function buildPlanChallengePrompt(input: PlanCritiqueInput): string {
  const plan = input.plan;
  const steps = plan.steps
    .map((step, index) => {
      const deps = step.dependsOn?.join(", ") ?? "(none)";
      return `${index + 1}. ${step.id}
- type: ${step.type}
- action: ${step.action}
- dependsOn: ${deps}
- assignedAgent: ${step.assignedAgent ?? "(unassigned)"}`;
    })
    .join("\n\n");

  return `You are a strict quality reviewer for an execution Plan.

Review the following Plan and return JSON only.

Goal:
${plan.goal}

Risk:
${plan.risk}

Assumptions:
${plan.assumptions.join("\n") || "(none)"}

Steps:
${steps}

Project Context:
${input.projectContext}

Return:
{
  "passed": true,
  "score": 0.0,
  "action": "pass" | "reject",
  "critiques": [
    { "severity": "critical" | "major" | "minor", "issue": "specific finding", "suggestion": "exact fix" }
  ],
  "verdict": "overall judgment",
  "requiredFixes": ["blocking issue 1"]
}`;
}

export function buildStepChallengePrompt(input: StepCritiqueInput): string {
  const outputText = Object.entries(input.outputs)
    .map(([name, content]) => `## ${name}\n${content}`)
    .join("\n\n");

  return `You are a strict reviewer for a Step result.

Step:
${input.stepName}

Goal:
${input.goal}

Step Definition:
${input.stepReadme}

Custom Challenge:
${input.customChallengePrompt ?? "Review this output critically."}

Outputs:
${outputText || "(no outputs)"}

Return JSON only:
{
  "passed": true,
  "score": 0.0,
  "action": "pass" | "reject",
  "critiques": [
    { "severity": "critical" | "major" | "minor", "issue": "specific finding", "suggestion": "exact fix" }
  ],
  "verdict": "overall judgment",
  "requiredFixes": ["blocking issue 1"]
}`;
}

export function buildReplanPrompt(input: ReplanInput): string {
  const doneStepIds = input.plan.steps
    .filter((s) => s.status === "done")
    .map((s) => s.id);

  const remainingSteps = input.plan.steps
    .filter((s) => s.status !== "done")
    .map((step, index) => {
      const deps = step.dependsOn?.join(", ") ?? "(none)";
      return `${index + 1}. ${step.id}
- type: ${step.type}
- action: ${step.action}
- dependsOn: ${deps}
- assignedAgent: ${step.assignedAgent ?? "(unassigned)"}
- status: ${step.status}`;
    })
    .join("\n\n");

  const doneSection =
    doneStepIds.length > 0
      ? `\nAlready completed (do not modify): ${doneStepIds.join(", ")}\n`
      : "";

  return `You are a replanner for a Harness runtime.

Your task is to revise the current Plan after a failed Step critique.

Goal:
${input.plan.goal}
${doneSection}
Remaining steps to revise:
${remainingSteps || "(none)"}

Failed Step:
${input.failedStepId}

Critique:
- confidence: ${input.critique.confidence}
- issues:
${input.critique.issues.join("\n") || "(none)"}
- missingChecks:
${input.critique.missingChecks.join("\n") || "(none)"}
- rationale:
${input.critique.rationale}

Project Context:
${input.projectContext}

Return JSON only in this shape:
{
  "planId": "string",
  "goal": "string",
  "assumptions": ["string"],
  "steps": [
    {
      "id": "string",
      "type": "analyze" | "tool" | "delegate" | "critique" | "finalize",
      "action": "string",
      "dependsOn": ["string"],
      "assignedAgent": "string",
      "status": "pending" | "running" | "done" | "failed" | "blocked"
    }
  ],
  "risk": "low" | "medium" | "high"
}

Rules:
- Include already-completed steps in the output with status "done" and their original field values
- Replace or adjust the failed step so the critique is addressed
- Any future steps should be reset to "pending" unless they must remain "blocked"
- Do not drop essential steps required to achieve the goal`;
}

export async function critiquePlan(
  adapter: LLMAdapter,
  model: string,
  input: PlanCritiqueInput
): Promise<StepCritiqueArtifact> {
  const raw = await completeJson<LegacyChallengeResult>(
    adapter,
    model,
    buildPlanChallengePrompt(input)
  );
  return {
    critique: adaptChallengeToCritique(raw.parsed),
    raw: raw.parsed,
  };
}

export async function critiqueStep(
  adapter: LLMAdapter,
  model: string,
  input: StepCritiqueInput
): Promise<StepCritiqueArtifact> {
  const raw = await completeJson<LegacyChallengeResult>(
    adapter,
    model,
    buildStepChallengePrompt(input)
  );
  return {
    critique: adaptChallengeToCritique(raw.parsed),
    raw: raw.parsed,
  };
}

/**
 * Compute what the LLM changed relative to the original plan (before merge).
 * `preserved` = done steps in original that appear in the LLM output.
 * `modified`  = non-done steps the LLM kept but may have changed.
 * `added`     = brand-new step ids the LLM introduced.
 * `removed`   = non-done step ids from original that the LLM dropped.
 */
export function diffPlans(
  original: ExecutionPlan,
  replanned: ExecutionPlan
): PlanDiff {
  const originalById = new Map(original.steps.map((s) => [s.id, s]));
  const replannedIds = new Set(replanned.steps.map((s) => s.id));
  const doneIds = new Set(
    original.steps.filter((s) => s.status === "done").map((s) => s.id)
  );

  return {
    preserved: [...doneIds].filter((id) => replannedIds.has(id)),
    modified: replanned.steps
      .filter((s) => originalById.has(s.id) && !doneIds.has(s.id))
      .map((s) => s.id),
    added: replanned.steps
      .filter((s) => !originalById.has(s.id))
      .map((s) => s.id),
    removed: original.steps
      .filter((s) => !replannedIds.has(s.id) && !doneIds.has(s.id))
      .map((s) => s.id),
  };
}

/**
 * Hard-merge: any step that was "done" in `original` is restored from the
 * original unchanged, regardless of what the LLM returned.  Done steps that
 * the LLM accidentally dropped are re-inserted before the first non-done step.
 */
export function mergePlans(
  original: ExecutionPlan,
  replanned: ExecutionPlan
): ExecutionPlan {
  const doneById = new Map<string, PlanStep>(
    original.steps.filter((s) => s.status === "done").map((s) => [s.id, s])
  );

  // Restore done steps from original, keep everything else from LLM.
  const mergedSteps = replanned.steps.map(
    (step) => doneById.get(step.id) ?? step
  );

  // Re-insert done steps the LLM dropped, preserving their relative order.
  const replannedIds = new Set(replanned.steps.map((s) => s.id));
  const droppedDone = original.steps.filter(
    (s) => s.status === "done" && !replannedIds.has(s.id)
  );

  if (droppedDone.length > 0) {
    const firstNonDone = mergedSteps.findIndex((s) => s.status !== "done");
    const insertAt = firstNonDone === -1 ? mergedSteps.length : firstNonDone;
    mergedSteps.splice(insertAt, 0, ...droppedDone);
  }

  return { ...replanned, steps: mergedSteps };
}

export async function replanWithCritique(
  adapter: LLMAdapter,
  model: string,
  input: ReplanInput
): Promise<{ plan: ExecutionPlan; diff: PlanDiff }> {
  const raw = await completeJson<ExecutionPlan>(
    adapter,
    model,
    buildReplanPrompt(input)
  );
  const diff = diffPlans(input.plan, raw.parsed);
  const plan = mergePlans(input.plan, raw.parsed);
  return { plan, diff };
}

export function buildRetrospectivePrompt(
  stepName: string,
  critique: CritiqueResult,
  existingLessons?: string
): string {
  const issueText = critique.issues.join("\n") || "(none)";
  const missedText = critique.missingChecks.join("\n") || "(none)";
  return `You are writing a retrospective for step "${stepName}".

Critique result:
- confidence: ${critique.confidence}
- issues:
${issueText}
- missing checks:
${missedText}
- rationale: ${critique.rationale}

${existingLessons ? `Previously recorded lessons:\n${existingLessons}\n\n---\n` : ""}
Write a brief retrospective. Respond with JSON only:

{
  "strengths": ["what was done well"],
  "mistakes": ["what was done wrong or missed"],
  "takeaways": ["lessons to remember next time"]
}

Rules:
- Be specific and actionable, not generic
- Reference actual issues from the critique
- Each item should be one concise sentence
- Only include NEW lessons not already in previous lessons`;
}

export async function generateRetrospective(
  adapter: LLMAdapter,
  model: string,
  stepName: string,
  critique: CritiqueResult,
  existingLessons?: string
): Promise<RetrospectiveResult> {
  const raw = await completeJson<RetrospectiveResult>(
    adapter,
    model,
    buildRetrospectivePrompt(stepName, critique, existingLessons)
  );
  return raw.parsed;
}

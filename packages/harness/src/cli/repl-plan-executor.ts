import type { LLMAdapter } from "@open-vera/core/adapters";
import type { Message } from "@open-vera/core/types";
import type { PlanExecutor, PlanStepDef } from "@open-vera/core/plan";
import { streamAgent } from "@open-vera/core/agent";
import { planFromPrompt } from "../runtime/planner.js";
import { critiqueStep } from "../runtime/critique.js";
import { assertTransition } from "../runtime/flow-state.js";
import type { HarnessState } from "@open-vera/core/types";

/**
 * Convert an ExecutionPlan's steps into PlanStepDef[] for REPL UI events.
 */
function stepsToDefs(steps: Array<{ id: string; action: string }>): PlanStepDef[] {
  return steps.map((s) => ({ id: s.id, description: s.action }));
}

/**
 * Harness-side REPL plan executor using the full Harness pipeline:
 *
 *   planFromPrompt (LLM planner) → streamAgent per step → critique → replan
 *
 * Unlike the core defaultPlanExecutor, this executor:
 *   - Uses the Harness planner (planFromPrompt) for richer plans
 *     (step types, dependsOn, risk assessment)
 *   - Runs critiqueStep after each step and replans on low confidence
 *   - Uses the Flow State Machine for execution state tracking
 *
 * Streaming (text deltas, tool calls) is preserved via streamAgent so the
 * REPL UI can show real-time progress within each step.
 */
export function createHarnessPlanExecutor(
  critiqueAdapter: LLMAdapter,
  critiqueModel: string,
): PlanExecutor {
  return async (goal, ctx, onEvent, onUsage) => {
    // ── 1. Generate plan via Harness planner ────────────────────────────────

    let plan;
    try {
      plan = await planFromPrompt(goal, ctx.adapter, {
        tools: ctx.tools.map((t) => t.name),
        model: ctx.model,
      });
    } catch (err) {
      onEvent({
        type: "plan_error",
        error: `规划失败：${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    let steps = plan.steps;
    onEvent({ type: "plan_ready", steps: stepsToDefs(steps) });

    // ── 2. Execute each step with critique ──────────────────────────────────

    // Track execution state through the flow state machine.
    // Use plain state strings with assertTransition for validation;
    // a full TaskFlow object isn't needed for REPL display.
    let flowState: HarnessState = "dispatching";
    assertTransition("planning", flowState);

    let history: Message[] = [...(ctx.history ?? [])];
    let i = 0;

    while (i < steps.length) {
      if (ctx.signal.aborted) return;

      const step = steps[i]!;
      assertTransition(flowState, "executing");
      flowState = "executing";

      onEvent({ type: "step_start", stepIndex: i, total: steps.length });

      const stepPrompt = [
        `总目标：${goal}`,
        ``,
        `当前步骤（${i + 1}/${steps.length}）：${step.action}`,
        `类型：${step.type}`,
        history.length > 0
          ? `\n（前面步骤的输出已包含在对话历史中，可作为上下文参考）`
          : "",
      ].join("\n");

      let stepOutput = "";
      try {
        stepOutput = await streamAgent(
          stepPrompt,
          {
            adapter: ctx.adapter,
            model: ctx.model,
            tools: ctx.tools,
            system: ctx.system,
            history,
            onUsage,
            signal: ctx.signal,
            runDir: ctx.runDir,
            contextOptions: ctx.contextOptions,
            compressionOptions: ctx.compressionOptions,
            microCompactOptions: ctx.microCompactOptions,
            compressionState: ctx.compressionState,
            microCompactState: ctx.microCompactState,
            memoryTracker: ctx.memoryTracker,
            scannedMemoryFiles: ctx.scannedMemoryFiles,
            onMemorySelected: ctx.onMemorySelected,
            onContextUpdate: ctx.onContextUpdate
              ? (messages, update) => {
                  history = messages;
                  ctx.onContextUpdate?.(messages, update);
                }
              : undefined,
            onToolCall: async (name, args) => {
              const result = await ctx.onToolCall(
                name,
                args as Record<string, unknown>,
              );
              onEvent({
                type: "step_tool",
                name,
                args: args as Record<string, unknown>,
                result,
              });
              return result.content;
            },
          },
          (delta) => onEvent({ type: "step_text", delta }),
        );
      } catch (err) {
        if (ctx.signal.aborted) return;
        onEvent({
          type: "plan_error",
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      // ── Critique ──────────────────────────────────────────────────────────

      assertTransition(flowState, "critiquing");
      flowState = "critiquing";

      let nextAction: string = "complete";
      try {
        const artifact = await critiqueStep(critiqueAdapter, critiqueModel, {
          stepName: step.action,
          goal,
          stepReadme: step.action,
          outputs: { output: stepOutput },
        });
        nextAction = artifact.critique.nextAction;
      } catch {
        // Critique failure is non-fatal — treat as complete
      }

      // ── Replan if needed ──────────────────────────────────────────────────

      if (nextAction === "replan") {
        assertTransition(flowState, "replanning");
        flowState = "replanning";

        const doneSteps = steps.slice(0, i + 1);
        const doneSummary = doneSteps
          .map((s, j) => `${j + 1}. ${s.action} ✓`)
          .join("\n");
        const replanGoal = `${goal}\n\n已完成步骤：\n${doneSummary}\n\n请重新规划剩余步骤。`;

        try {
          const newPlan = await planFromPrompt(replanGoal, ctx.adapter, {
            tools: ctx.tools.map((t) => t.name),
            model: ctx.model,
          });
          // Keep done steps, replace remaining with new plan steps
          steps = [...doneSteps, ...newPlan.steps];
          onEvent({ type: "plan_ready", steps: stepsToDefs(steps) });
        } catch {
          // Replan failure — carry on with existing steps
        }
      }

      if (!ctx.onContextUpdate) {
        history.push(
          { role: "user", content: stepPrompt },
          { role: "assistant", content: stepOutput },
        );
      }

      assertTransition(flowState, "dispatching");
      flowState = "dispatching";

      onEvent({ type: "step_done", stepIndex: i, output: stepOutput });
      i++;
    }

    // ── 3. Complete ─────────────────────────────────────────────────────────

    onEvent({ type: "plan_done" });
  };
}

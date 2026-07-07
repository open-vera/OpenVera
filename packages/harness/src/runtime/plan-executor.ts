import type { LLMAdapter } from "@open-vera/core/adapters";
import type { PlanExecutor, PlanStepDef } from "@open-vera/core/plan";
import { streamAgent } from "@open-vera/core/agent";
import type { HarnessState, Message } from "@open-vera/core/types";
import { critiqueStep } from "./critique.js";
import { assertTransition } from "./flow-state.js";
import { planFromPrompt } from "./planner.js";

const MAX_INTERACTIVE_REPLANS = 1;

function stepsToDefs(steps: Array<{ id: string; action: string }>): PlanStepDef[] {
  return steps.map((step) => ({ id: step.id, description: step.action }));
}

/**
 * Harness-backed plan executor for interactive hosts.
 *
 * It preserves token-level streaming while using Harness planning, flow-state
 * checks, step critique, and replanning. Hosts such as the CLI REPL and Partner
 * can map PlanEvent back into their own UI protocol.
 */
export function createHarnessPlanExecutor(
  critiqueAdapter: LLMAdapter,
  critiqueModel: string,
): PlanExecutor {
  return async (goal, ctx, onEvent, onUsage) => {
    let plan;
    try {
      plan = await planFromPrompt(goal, ctx.adapter, {
        tools: ctx.tools.map((tool) => tool.name),
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

    let flowState: HarnessState = "dispatching";
    assertTransition("planning", flowState);

    let history: Message[] = [...(ctx.history ?? [])];
    let index = 0;
    let replanCount = 0;

    while (index < steps.length) {
      if (ctx.signal.aborted) return;

      const step = steps[index]!;
      assertTransition(flowState, "executing");
      flowState = "executing";

      onEvent({ type: "step_start", stepIndex: index, total: steps.length });

      const stepPrompt = [
        `总目标：${goal}`,
        "",
        `当前步骤（${index + 1}/${steps.length}）：${step.action}`,
        `类型：${step.type}`,
        history.length > 0
          ? "\n（前面步骤的输出已包含在对话历史中，可作为上下文参考）"
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
        // Critique is advisory in interactive mode; keep the run moving.
      }

      if (nextAction === "replan" && replanCount < MAX_INTERACTIVE_REPLANS) {
        replanCount++;
        assertTransition(flowState, "replanning");
        flowState = "replanning";

        const doneSteps = steps.slice(0, index + 1);
        const doneSummary = doneSteps
          .map((doneStep, doneIndex) => `${doneIndex + 1}. ${doneStep.action} ✓`)
          .join("\n");
        const replanGoal = `${goal}\n\n已完成步骤：\n${doneSummary}\n\n请重新规划剩余步骤。`;

        try {
          const newPlan = await planFromPrompt(replanGoal, ctx.adapter, {
            tools: ctx.tools.map((tool) => tool.name),
            model: ctx.model,
          });
          steps = [...doneSteps, ...newPlan.steps];
          onEvent({ type: "plan_ready", steps: stepsToDefs(steps) });
        } catch {
          // Replan failure should not discard progress already made.
        }
      } else if (nextAction === "replan") {
        nextAction = "complete";
      }

      if (!ctx.onContextUpdate) {
        history.push(
          { role: "user", content: stepPrompt },
          { role: "assistant", content: stepOutput },
        );
      }

      assertTransition(flowState, "dispatching");
      flowState = "dispatching";

      onEvent({ type: "step_done", stepIndex: index, output: stepOutput });
      index++;
    }

    onEvent({ type: "plan_done" });
  };
}

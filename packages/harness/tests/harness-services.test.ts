import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { LLMAdapter } from "@open-vera/core/adapters";
import type { ToolContext, ToolResult } from "@open-vera/core/tools";
import type { AgentAssignment, CompletionRequest, CritiqueResult, ExecutionPlan, StepResult, StreamEvent } from "@open-vera/core/types";
import { HarnessRuntime } from "../src/runtime/runtime.js";
import type { AgentRunner } from "../src/agent/types.js";
import { createHarnessServices, type HarnessServices } from "../src/runtime/services.js";
import { updateFlowState } from "../src/runtime/flow.js";

class NoopAdapter implements LLMAdapter {
  async complete() {
    return {
      message: { role: "assistant" as const, content: "{}" },
      stop_reason: "end_turn" as const,
    };
  }

  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "done", stop_reason: "end_turn" };
  }
}

class ServiceRunner implements AgentRunner {
  readonly calls: string[] = [];

  async run(assignment: AgentAssignment): Promise<StepResult> {
    this.calls.push(assignment.stepId);
    return {
      flowId: assignment.flowId,
      stepId: assignment.stepId,
      output: `service-runner:${assignment.stepId}`,
      toolCalls: [],
    };
  }
}

class JsonAdapter implements LLMAdapter {
  async complete(request: CompletionRequest) {
    const prompt = String(request.messages[0]?.content ?? "");
    let content: string;
    if (prompt.includes("任务规划器")) {
      content = JSON.stringify(makePlan("llm_planned"));
    } else if (prompt.includes("Retrospective")) {
      content = JSON.stringify({ strengths: ["s"], mistakes: [], takeaways: ["t"] });
    } else if (prompt.includes("replanner")) {
      content = JSON.stringify(makePlan("llm_replanned"));
    } else {
      content = JSON.stringify({
        passed: true,
        score: 1,
        action: "pass",
        critiques: [],
        verdict: "ok",
        requiredFixes: [],
      });
    }
    return {
      message: { role: "assistant" as const, content },
      stop_reason: "end_turn" as const,
    };
  }

  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "done", stop_reason: "end_turn" };
  }
}

function makePlan(stepId = "step_1"): ExecutionPlan {
  return {
    planId: "plan-services",
    goal: "service goal",
    assumptions: [],
    risk: "low",
    steps: [
      {
        id: stepId,
        type: "tool",
        action: "run service step",
        dependsOn: [],
        assignedAgent: "default",
        status: "pending",
      },
    ],
  };
}

function completeCritique(): CritiqueResult {
  return {
    confidence: 1,
    issues: [],
    missingChecks: [],
    nextAction: "complete",
    rationale: "ok",
  };
}

describe("HarnessServices compatibility", () => {
  it("uses purpose-aware LlmService adapters for builtin planner and critique services", async () => {
    const adapter = new JsonAdapter();
    const buildAdapter = vi.fn(() => adapter);
    const services = createHarnessServices({
      adapter: new NoopAdapter(),
      model: "service-model",
      provider: "service-provider",
      llmService: { buildAdapter } as never,
    });

    const planned = await services.planner.plan("make a plan");
    await services.critique.critiquePlan({ plan: planned, projectContext: "ctx" });
    await services.critique.critiqueStep({
      stepName: "step",
      goal: "goal",
      stepReadme: "readme",
      outputs: { output: "ok" },
    });
    await services.critique.replan({
      plan: planned,
      failedStepId: "llm_planned",
      critique: completeCritique(),
      projectContext: "ctx",
    });
    await services.critique.retrospective("step", completeCritique());

    expect(planned.steps.map((step) => step.id)).toEqual(["llm_planned"]);
    expect(buildAdapter).toHaveBeenCalledTimes(5);
    expect(buildAdapter.mock.calls.map((call) => call[2])).toEqual([
      { purpose: "tool" },
      { purpose: "tool" },
      { purpose: "tool" },
      { purpose: "tool" },
      { purpose: "tool" },
    ]);
  });

  it("uses services for default runner, planner, step critique, and retrospective", async () => {
    const artifactsRootDir = await mkdtemp(join(tmpdir(), "vera-harness-services-"));
    const runner = new ServiceRunner();
    const services: Partial<HarnessServices> = {
      runner: {
        createDefaultRunner: () => runner,
      },
      planner: {
        plan: vi.fn(async () => makePlan("service_step")),
      },
      critique: {
        critiquePlan: vi.fn(async () => ({
          critique: completeCritique(),
          raw: { passed: true, score: 1, action: "pass", critiques: [], verdict: "ok", requiredFixes: [] },
        })),
        critiqueStep: vi.fn(async () => ({
          critique: completeCritique(),
          raw: { passed: true, score: 1, action: "pass", critiques: [], verdict: "ok", requiredFixes: [] },
        })),
        replan: vi.fn(async () => ({ plan: makePlan("replanned"), diff: { preserved: [], modified: [], added: ["replanned"], removed: [] } })),
        retrospective: vi.fn(async () => ({
          strengths: ["used service"],
          mistakes: [],
          takeaways: ["services are injectable"],
        })),
      },
    };
    const runtime = new HarnessRuntime(new NoopAdapter(), "service-model", {
      artifactsRootDir,
      services,
    });

    const handle = await runtime.planAndStart("goal", "flow-services");
    const result = await runtime.runFlowLoop(handle, { maxSteps: 1 });

    expect(services.planner?.plan).toHaveBeenCalledWith("goal", {});
    expect(runner.calls).toEqual(["service_step"]);
    expect(services.critique?.critiqueStep).toHaveBeenCalledOnce();
    expect(services.critique?.retrospective).toHaveBeenCalledOnce();
    expect(result.handle.flow.state).toBe("completed");
  });

  it("default StreamAgentRunner consumes LlmService and ToolHost services", async () => {
    const artifactsRootDir = await mkdtemp(join(tmpdir(), "vera-harness-services-"));
    const streamCalls: CompletionRequest[] = [];
    const toolCalls: Array<{ name: string; args: Record<string, unknown>; ctx: ToolContext }> = [];

    const llmService = {
      stream: async function* (request: CompletionRequest): AsyncIterable<StreamEvent> {
        streamCalls.push(request);
        if (streamCalls.length === 1) {
          yield {
            type: "tool_call",
            id: "call_1",
            name: "service_tool",
            arguments: JSON.stringify({ value: "from-llm" }),
          };
          yield { type: "done", stop_reason: "tool_use" };
          return;
        }
        yield { type: "text", text: "tool result accepted" };
        yield { type: "done", stop_reason: "end_turn" };
      },
    };
    const toolHost = {
      execute: vi.fn(async (
        name: string,
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<ToolResult> => {
        toolCalls.push({ name, args, ctx });
        return { ok: true, content: `host:${String(args.value)}` };
      }),
    };
    const runtime = new HarnessRuntime(new NoopAdapter(), "service-model", {
      artifactsRootDir,
      llmService: llmService as never,
      toolHost,
      toolContext: { cwd: artifactsRootDir, sessionId: "runtime-session" },
      services: {
        critique: {
          critiquePlan: vi.fn(async () => ({
            critique: completeCritique(),
            raw: { passed: true, score: 1, action: "pass", critiques: [], verdict: "ok", requiredFixes: [] },
          })),
          critiqueStep: vi.fn(async () => ({
            critique: completeCritique(),
            raw: { passed: true, score: 1, action: "pass", critiques: [], verdict: "ok", requiredFixes: [] },
          })),
          replan: vi.fn(async () => ({ plan: makePlan("replanned"), diff: { preserved: [], modified: [], added: ["replanned"], removed: [] } })),
          retrospective: vi.fn(async () => ({ strengths: [], mistakes: [], takeaways: [] })),
        },
      },
    });
    const handle = await runtime.startFlow({
      flowId: "flow-service-runner",
      goal: "service runner goal",
      plan: makePlan("service_runner_step"),
      scope: { workdir: artifactsRootDir },
    });

    const result = await runtime.runFlowLoop(handle, {
      maxSteps: 1,
      tools: [
        {
          name: "service_tool",
          description: "service tool",
          parameters: { type: "object", properties: {} },
        },
      ],
    });

    expect(streamCalls).toHaveLength(2);
    expect(streamCalls[0]?.model).toBe("service-model");
    expect(toolHost.execute).toHaveBeenCalledOnce();
    expect(toolCalls[0]).toMatchObject({
      name: "service_tool",
      args: { value: "from-llm" },
      ctx: { cwd: artifactsRootDir, sessionId: "runtime-session" },
    });
    expect(result.completedSteps).toEqual(["service_runner_step"]);
  });

  it("uses service replan without calling legacy replan directly", async () => {
    const artifactsRootDir = await mkdtemp(join(tmpdir(), "vera-harness-services-"));
    const services: Partial<HarnessServices> = {
      critique: {
        critiquePlan: vi.fn(async () => ({
          critique: completeCritique(),
          raw: { passed: true, score: 1, action: "pass", critiques: [], verdict: "ok", requiredFixes: [] },
        })),
        critiqueStep: vi.fn(async () => ({
          critique: completeCritique(),
          raw: { passed: true, score: 1, action: "pass", critiques: [], verdict: "ok", requiredFixes: [] },
        })),
        replan: vi.fn(async () => ({
          plan: makePlan("service_replan"),
          diff: { preserved: [], modified: [], added: ["service_replan"], removed: ["old"] },
        })),
        retrospective: vi.fn(async () => ({ strengths: [], mistakes: [], takeaways: [] })),
      },
    };
    const runtime = new HarnessRuntime(new NoopAdapter(), "service-model", {
      artifactsRootDir,
      services,
    });
    const handle = await runtime.startFlow({
      flowId: "flow-replan-services",
      goal: "replan goal",
      plan: makePlan("old"),
      scope: { workdir: artifactsRootDir },
    });
    const replanningHandle = {
      ...handle,
      flow: updateFlowState(
        updateFlowState(updateFlowState(handle.flow, "executing"), "critiquing"),
        "replanning",
      ),
    };

    const result = await runtime.replanFlow(replanningHandle, {
      plan: makePlan("old"),
      failedStepId: "old",
      critique: completeCritique(),
      projectContext: "ctx",
    });

    expect(services.critique?.replan).toHaveBeenCalledOnce();
    expect(result.plan.steps.map((step) => step.id)).toEqual(["service_replan"]);
    expect(result.diff.added).toEqual(["service_replan"]);
  });
});

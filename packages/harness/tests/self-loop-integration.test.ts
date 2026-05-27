import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExecutionPlan } from "@open-vera/core/types";
import type { FlowHandle, FlowLoopResult } from "../src/runtime/internal.js";
import type { SelfLoopRunnerConfig } from "../src/flow/self-loop.js";

// Mock external dependencies (LLM calls and filesystem)
vi.mock("../src/runtime/planner.js", () => ({
  planFromPrompt: vi.fn().mockResolvedValue({
    planId: "plan-1",
    goal: "test goal",
    assumptions: [],
    risk: "low",
    steps: [
      { id: "s1", type: "tool", action: "step 1", dependsOn: [], status: "pending" },
      { id: "s2", type: "tool", action: "step 2", dependsOn: ["s1"], status: "pending" },
    ],
  } satisfies ExecutionPlan),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue("{}"),
}));

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual };
});

import { HarnessRuntime } from "../src/runtime/runtime.js";

function makeCompletedFlowLoopResult(flowId: string, goal: string): FlowLoopResult {
  return {
    handle: {
      flow: {
        flowId,
        state: "completed",
        goal,
        activeStepId: undefined,
        budget: { usdUsed: 0 },
        plan: {
          planId: "plan-1",
          goal,
          assumptions: [],
          risk: "low",
          steps: [
            { id: "s1", type: "tool", action: "step 1", dependsOn: [], status: "done" },
            { id: "s2", type: "tool", action: "step 2", dependsOn: ["s1"], status: "done" },
          ],
        },
        artifacts: [],
      },
      store: { rootDir: "/tmp/test", flowDir: `/tmp/test/${flowId}` },
    } as unknown as FlowHandle,
    completedSteps: ["s1", "s2"],
    failedStepId: undefined,
    pausedOnStepId: undefined,
  };
}

function makePartialFlowLoopResult(flowId: string, goal: string): FlowLoopResult {
  return {
    handle: {
      flow: {
        flowId,
        state: "executing",
        goal,
        activeStepId: "s2",
        budget: { usdUsed: 0.02 },
        plan: {
          planId: "plan-1",
          goal,
          assumptions: [],
          risk: "low",
          steps: [
            { id: "s1", type: "tool", action: "step 1", dependsOn: [], status: "done" },
            { id: "s2", type: "tool", action: "step 2", dependsOn: ["s1"], status: "failed" },
          ],
        },
        artifacts: [
          { id: "step-result-s1", type: "step_result", summary: "s1" },
        ],
      },
      store: { rootDir: "/tmp/test", flowDir: `/tmp/test/${flowId}` },
    } as unknown as FlowHandle,
    completedSteps: ["s1"],
    failedStepId: "s2",
    pausedOnStepId: undefined,
  };
}

describe("HarnessRuntime.runSelfLoop integration", () => {
  let runtime: HarnessRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = new HarnessRuntime(
      { complete: vi.fn() } as never,
      "test-model",
      { artifactsRootDir: "/tmp/test" }
    );
  });

  it("creates a SelfLoopRunner and returns SelfLoopResult with cycles and termination reason", async () => {
    vi.spyOn(runtime, "runFlowLoop").mockResolvedValue(
      makeCompletedFlowLoopResult("f1", "test goal")
    );

    const handle = await runtime.planAndStart("test goal", "f1");
    const result = await runtime.runSelfLoop(handle);

    expect(result).toHaveProperty("handle");
    expect(result).toHaveProperty("cycles");
    expect(result).toHaveProperty("terminationReason");
    expect(result).toHaveProperty("totalCost");
    expect(Array.isArray(result.cycles)).toBe(true);
    expect(result.cycles.length).toBeGreaterThanOrEqual(1);
    expect(result.terminationReason).toBe("high_confidence");
  });

  it("passes config through to SelfLoopRunner", async () => {
    let capturedMaxSteps: number | undefined;
    vi.spyOn(runtime, "runFlowLoop").mockImplementation(async (_h, opts) => {
      capturedMaxSteps = opts?.maxSteps;
      return makeCompletedFlowLoopResult("f2", "test goal");
    });

    const config: SelfLoopRunnerConfig = {
      maxCycles: 3,
      confidenceThreshold: 0.8,
      budgetUsd: 1.0,
      duplicateThreshold: 4,
      maxStepsPerCycle: 10,
    };

    const handle = await runtime.planAndStart("test goal", "f2");
    await runtime.runSelfLoop(handle, config);

    expect(capturedMaxSteps).toBe(10);
  });

  it("respects maxCycles config with low-confidence critic", async () => {
    vi.spyOn(runtime, "runFlowLoop").mockResolvedValue(
      makePartialFlowLoopResult("f3", "test goal")
    );
    vi.spyOn(runtime, "replanFlow").mockResolvedValue({
      handle: {
        flow: {
          flowId: "f3",
          state: "dispatching",
          goal: "test goal",
          activeStepId: "s2",
          budget: { usdUsed: 0 },
          plan: {
            planId: "plan-1",
            goal: "test goal",
            assumptions: [],
            risk: "low",
            steps: [
              { id: "s1", type: "tool", action: "step 1", dependsOn: [], status: "done" },
              { id: "s2", type: "tool", action: "step 2", dependsOn: ["s1"], status: "pending" },
            ],
          },
          artifacts: [],
        },
        store: { rootDir: "/tmp/test", flowDir: "/tmp/test/f3" },
      } as unknown as FlowHandle,
      plan: {} as ExecutionPlan,
      diff: { preserved: [], modified: [], added: [], removed: [] },
    });

    const config: SelfLoopRunnerConfig = { maxCycles: 2 };
    const handle = await runtime.planAndStart("test goal", "f3");
    const result = await runtime.runSelfLoop(handle, config);

    expect(result.cycles).toHaveLength(2);
    expect(result.terminationReason).toBe("max_cycles");
  });

  it("returns totalCost accumulated across cycles", async () => {
    vi.spyOn(runtime, "runFlowLoop").mockResolvedValue(
      makeCompletedFlowLoopResult("f4", "test goal")
    );

    const handle = await runtime.planAndStart("test goal", "f4");
    const result = await runtime.runSelfLoop(handle);

    expect(result.totalCost).toBeGreaterThanOrEqual(0);
    expect(result.totalCost).toBe(
      result.cycles.reduce((sum, c) => sum + c.cost, 0)
    );
  });

  it("accepts an optional CriticAgent", async () => {
    vi.spyOn(runtime, "runFlowLoop").mockResolvedValue(
      makeCompletedFlowLoopResult("f5", "test goal")
    );

    const critic = {
      critique: vi.fn().mockResolvedValue({
        issues: [],
        confidence: 0.99,
        nextAction: "stop",
        reasoning: "Looks great",
      }),
      debate: vi.fn(),
    };

    const handle = await runtime.planAndStart("test goal", "f5");
    const result = await runtime.runSelfLoop(handle, {}, critic as never);

    expect(result.terminationReason).toBe("high_confidence");
    expect(critic.critique).toHaveBeenCalled();
  });
});

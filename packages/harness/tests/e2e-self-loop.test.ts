/**
 * S6: End-to-End Self-Loop Test
 *
 * Tests the full pipeline: plan → self-loop → critique → replan → complete
 * Uses mocked LLM adapter but exercises real SelfLoopRunner + CriticAgent integration.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SelfLoopRunner } from "../src/flow/self-loop.js";
import { CriticAgent } from "../src/critic/critic-agent.js";
import type { FlowHandle, FlowLoopResult } from "../src/runtime/internal.js";
import type { HarnessRuntime } from "../src/runtime/runtime.js";
import type { ExecutionPlan } from "@open-vera/core/types";

// Mock fs/promises for appendFile
vi.mock("node:fs/promises", () => ({
  appendFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:path", () => ({
  join: vi.fn((...args: string[]) => args.join("/")),
}));

// Mock completeJson for CriticAgent
vi.mock("../src/runtime/json.js", () => ({
  completeJson: vi.fn(),
}));

import { completeJson } from "../src/runtime/json.js";
const mockCompleteJson = vi.mocked(completeJson);

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePlan(goal: string, stepCount: number = 3): ExecutionPlan {
  const steps = Array.from({ length: stepCount }, (_, i) => ({
    id: `step-${i + 1}`,
    action: `Execute step ${i + 1}`,
    type: i === 0 ? "analyze" : i === stepCount - 1 ? "finalize" : "tool",
    status: "pending" as const,
    dependsOn: i > 0 ? [`step-${i}`] : [],
  }));

  return {
    planId: "plan-e2e",
    goal,
    assumptions: ["test assumption"],
    risk: "low",
    steps,
  } as unknown as ExecutionPlan;
}

function makeFlowHandle(
  state: string = "dispatching",
  plan?: ExecutionPlan
): FlowHandle {
  const p = plan ?? makePlan("E2E test goal");
  return {
    flow: {
      flowId: "flow-e2e",
      state,
      goal: p.goal,
      activeStepId: undefined,
      budget: { usdUsed: 0 },
      plan: p,
      artifacts: [],
      scope: undefined,
      assignedAgents: [],
      loopCount: 0,
      maxLoops: 10,
    },
    store: { rootDir: "/tmp/e2e", flowDir: "/tmp/e2e/flow-e2e" },
  } as unknown as FlowHandle;
}

function makeFlowLoopResult(
  handle: FlowHandle,
  completedSteps: string[],
  opts: Partial<FlowLoopResult> = {}
): FlowLoopResult {
  return {
    handle,
    completedSteps,
    failedStepId: undefined,
    pausedOnStepId: undefined,
    ...opts,
  };
}

function makeMockRuntime(
  flowResults: FlowLoopResult[]
): HarnessRuntime {
  let callIndex = 0;
  return {
    runFlowLoop: vi.fn().mockImplementation(async () => {
      const result = flowResults[Math.min(callIndex, flowResults.length - 1)];
      callIndex++;
      return result;
    }),
    replanFlow: vi.fn().mockImplementation(async (handle: FlowHandle) => {
      // Simulate replan: reset failed step to pending
      const plan = handle.flow.plan!;
      return {
        handle: {
          ...handle,
          flow: {
            ...handle.flow,
            state: "dispatching",
            plan: {
              ...plan,
              steps: plan.steps.map((s) =>
                s.status === "failed" ? { ...s, status: "pending" } : s
              ),
            },
          },
        },
        plan: handle.flow.plan,
        diff: { preserved: [], modified: [], added: [], removed: [] },
      };
    }),
  } as unknown as HarnessRuntime;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("S6: E2E self-loop pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("plan → self-loop → high confidence → complete", () => {
    it("completes in 1 cycle when confidence is high", async () => {
      const handle = makeFlowHandle();
      const completedHandle = {
        ...handle,
        flow: { ...handle.flow, state: "completed" },
      };

      const runtime = makeMockRuntime([
        makeFlowLoopResult(completedHandle, ["step-1", "step-2", "step-3"]),
      ]);

      // CriticAgent returns high confidence
      mockCompleteJson.mockResolvedValue({
        parsed: {
          issues: [],
          confidence: 0.95,
          nextAction: "stop",
          reasoning: "All steps completed successfully",
        },
        raw: "",
      });

      const critic = new CriticAgent({} as never, "test-model");
      const runner = new SelfLoopRunner(runtime, critic, { maxCycles: 5 });
      const result = await runner.run(handle);

      expect(result.terminationReason).toBe("high_confidence");
      expect(result.cycles).toHaveLength(1);
      expect(result.cycles[0].confidence).toBe(0.95);
      expect(result.cycles[0].shouldReplan).toBe(false);
      expect(result.totalCost).toBeGreaterThanOrEqual(0);
    });
  });

  describe("plan → self-loop → critique → replan → complete", () => {
    it("replans once then completes on second cycle", async () => {
      const handle = makeFlowHandle();

      // Cycle 1: partial completion, critic says replan
      const partialHandle = {
        ...handle,
        flow: {
          ...handle.flow,
          state: "failed",
          plan: {
            ...handle.flow.plan!,
            steps: handle.flow.plan!.steps.map((s, i) =>
              i === 1 ? { ...s, status: "failed" as const } : s
            ),
          },
        },
      };

      // Cycle 2: full completion after replan
      const completedHandle = {
        ...handle,
        flow: { ...handle.flow, state: "completed" },
      };

      const runtime = makeMockRuntime([
        makeFlowLoopResult(partialHandle, ["step-1"], {
          failedStepId: "step-2",
        }),
        makeFlowLoopResult(completedHandle, [
          "step-1",
          "step-2",
          "step-3",
        ]),
      ]);

      // Critic returns: cycle 1 = replan, cycle 2 = high confidence
      let critiqueCallCount = 0;
      mockCompleteJson.mockImplementation(async () => {
        critiqueCallCount++;
        if (critiqueCallCount === 1) {
          return {
            parsed: {
              issues: ["Step 2 failed to execute"],
              confidence: 0.3,
              nextAction: "replan",
              reasoning: "Step 2 needs retry with different approach",
            },
            raw: "",
          };
        }
        return {
          parsed: {
            issues: [],
            confidence: 0.95,
            nextAction: "stop",
            reasoning: "All steps completed after replan",
          },
          raw: "",
        };
      });

      const critic = new CriticAgent({} as never, "test-model");
      const runner = new SelfLoopRunner(runtime, critic, { maxCycles: 5 });
      const result = await runner.run(handle);

      expect(result.terminationReason).toBe("high_confidence");
      expect(result.cycles).toHaveLength(2);
      expect(result.cycles[0].shouldReplan).toBe(true);
      expect(result.cycles[0].failedStepId).toBe("step-2");
      expect(result.cycles[1].shouldReplan).toBe(false);
      expect(runtime.replanFlow).toHaveBeenCalledTimes(1);
    });
  });

  describe("plan → self-loop → budget exceeded → stop", () => {
    it("stops when budget is exceeded mid-loop", async () => {
      const handle = makeFlowHandle();
      const runtime = makeMockRuntime([
        makeFlowLoopResult(handle, ["step-1", "step-2", "step-3"]),
        makeFlowLoopResult(handle, ["step-1", "step-2", "step-3"]),
        makeFlowLoopResult(handle, ["step-1", "step-2", "step-3"]),
      ]);

      // Low confidence each cycle to keep looping
      mockCompleteJson.mockResolvedValue({
        parsed: {
          issues: ["still not good enough"],
          confidence: 0.3,
          nextAction: "continue",
          reasoning: "Needs more work",
        },
        raw: "",
      });

      const critic = new CriticAgent({} as never, "test-model");
      // Budget of $0.05, each cycle ~$0.06 (3 steps × $0.02)
      const runner = new SelfLoopRunner(runtime, critic, {
        maxCycles: 10,
        budgetUsd: 0.05,
      });
      const result = await runner.run(handle);

      expect(result.terminationReason).toBe("budget_exceeded");
      expect(result.totalCost).toBeGreaterThanOrEqual(0.05);
    });
  });

  describe("plan → self-loop → max cycles → stop", () => {
    it("stops after maxCycles even with low confidence", async () => {
      const handle = makeFlowHandle();
      const runtime = makeMockRuntime([
        makeFlowLoopResult(handle, ["step-1"]),
        makeFlowLoopResult(handle, ["step-1"]),
        makeFlowLoopResult(handle, ["step-1"]),
      ]);

      mockCompleteJson.mockResolvedValue({
        parsed: {
          issues: ["needs improvement"],
          confidence: 0.4,
          nextAction: "continue",
          reasoning: "Not there yet",
        },
        raw: "",
      });

      const critic = new CriticAgent({} as never, "test-model");
      const runner = new SelfLoopRunner(runtime, critic, { maxCycles: 3 });
      const result = await runner.run(handle);

      expect(result.terminationReason).toBe("max_cycles");
      expect(result.cycles).toHaveLength(3);
    });
  });

  describe("plan → self-loop → heuristic critique (no critic) → complete", () => {
    it("uses heuristic critique when no CriticAgent is provided", async () => {
      const handle = makeFlowHandle();
      const completedHandle = {
        ...handle,
        flow: { ...handle.flow, state: "completed" },
      };

      const runtime = makeMockRuntime([
        makeFlowLoopResult(completedHandle, ["step-1", "step-2", "step-3"]),
      ]);

      const runner = new SelfLoopRunner(runtime, undefined, { maxCycles: 5 });
      const result = await runner.run(handle);

      // Heuristic: completed flow → confidence=1.0 → high_confidence
      expect(result.terminationReason).toBe("high_confidence");
      expect(result.cycles[0].confidence).toBe(1.0);
    });
  });

  describe("plan → self-loop → multiple replans → complete", () => {
    it("handles multiple replan cycles before completing", async () => {
      const handle = makeFlowHandle();

      // Cycle 1: fail at step-2
      const fail1 = {
        ...handle,
        flow: {
          ...handle.flow,
          state: "failed",
          plan: {
            ...handle.flow.plan!,
            steps: handle.flow.plan!.steps.map((s, i) =>
              i === 1 ? { ...s, status: "failed" as const } : s
            ),
          },
        },
      };

      // Cycle 2: fail at step-3
      const fail2 = {
        ...handle,
        flow: {
          ...handle.flow,
          state: "failed",
          plan: {
            ...handle.flow.plan!,
            steps: handle.flow.plan!.steps.map((s, i) =>
              i === 2 ? { ...s, status: "failed" as const } : s
            ),
          },
        },
      };

      // Cycle 3: success
      const success = {
        ...handle,
        flow: { ...handle.flow, state: "completed" },
      };

      const runtime = makeMockRuntime([
        makeFlowLoopResult(fail1, ["step-1"], { failedStepId: "step-2" }),
        makeFlowLoopResult(fail2, ["step-1", "step-2"], {
          failedStepId: "step-3",
        }),
        makeFlowLoopResult(success, ["step-1", "step-2", "step-3"]),
      ]);

      let callCount = 0;
      mockCompleteJson.mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          return {
            parsed: {
              issues: [`failure at cycle ${callCount}`],
              confidence: 0.2,
              nextAction: "replan",
              reasoning: `Need to fix step ${callCount + 1}`,
            },
            raw: "",
          };
        }
        return {
          parsed: {
            issues: [],
            confidence: 0.95,
            nextAction: "stop",
            reasoning: "All done",
          },
          raw: "",
        };
      });

      const critic = new CriticAgent({} as never, "test-model");
      const runner = new SelfLoopRunner(runtime, critic, { maxCycles: 5 });
      const result = await runner.run(handle);

      expect(result.terminationReason).toBe("high_confidence");
      expect(result.cycles).toHaveLength(3);
      expect(result.cycles[0].shouldReplan).toBe(true);
      expect(result.cycles[1].shouldReplan).toBe(true);
      expect(result.cycles[2].shouldReplan).toBe(false);
      expect(runtime.replanFlow).toHaveBeenCalledTimes(2);
    });
  });

  describe("cycle timeline JSONL writing", () => {
    it("writes cycle_end entries for each cycle", async () => {
      const { appendFile } = await import("node:fs/promises");
      const mockAppendFile = vi.mocked(appendFile);

      const handle = makeFlowHandle();
      const completedHandle = {
        ...handle,
        flow: { ...handle.flow, state: "completed" },
      };

      const runtime = makeMockRuntime([
        makeFlowLoopResult(handle, ["step-1"]),
        makeFlowLoopResult(completedHandle, ["step-1", "step-2", "step-3"]),
      ]);

      let callCount = 0;
      mockCompleteJson.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            parsed: {
              issues: ["issue"],
              confidence: 0.5,
              nextAction: "replan",
              reasoning: "needs fix",
            },
            raw: "",
          };
        }
        return {
          parsed: {
            issues: [],
            confidence: 0.95,
            nextAction: "stop",
            reasoning: "done",
          },
          raw: "",
        };
      });

      const critic = new CriticAgent({} as never, "test-model");
      const runner = new SelfLoopRunner(runtime, critic, { maxCycles: 3 });
      await runner.run(handle);

      // Should have written 2 cycle_end entries
      const appendCalls = mockAppendFile.mock.calls;
      const cycleEndCalls = appendCalls.filter((call) => {
        const data = call[1] as string;
        return data.includes('"type":"cycle_end"');
      });
      expect(cycleEndCalls).toHaveLength(2);

      // Verify entry structure
      const entry1 = JSON.parse(cycleEndCalls[0][1] as string);
      expect(entry1.type).toBe("cycle_end");
      expect(entry1.cycleNumber).toBe(1);
      expect(entry1.confidence).toBe(0.5);
      expect(entry1.shouldReplan).toBe(true);
    });
  });

  describe("cost tracking across cycles", () => {
    it("accumulates cost correctly across multiple cycles", async () => {
      const handle = makeFlowHandle();
      const runtime = makeMockRuntime([
        makeFlowLoopResult(handle, ["step-1", "step-2", "step-3"]),
        makeFlowLoopResult(handle, ["step-1", "step-2", "step-3"]),
        makeFlowLoopResult(handle, ["step-1", "step-2", "step-3"]),
      ]);

      mockCompleteJson.mockResolvedValue({
        parsed: {
          issues: ["keep going"],
          confidence: 0.3,
          nextAction: "continue",
          reasoning: "more work needed",
        },
        raw: "",
      });

      const critic = new CriticAgent({} as never, "test-model");
      const runner = new SelfLoopRunner(runtime, critic, { maxCycles: 3 });
      const result = await runner.run(handle);

      expect(result.totalCost).toBe(
        result.cycles.reduce((sum, c) => sum + c.cost, 0)
      );
      expect(result.totalCost).toBeGreaterThan(0);
    });
  });
});

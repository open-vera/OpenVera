import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { LLMAdapter } from "@open-vera/core/adapters";
import type { AgentAssignment, ExecutionPlan, StepResult, StreamEvent } from "@open-vera/core/types";
import { HarnessRuntime } from "../src/runtime/runtime.js";
import type { AgentRunner } from "../src/agent/types.js";

class PassingJsonAdapter implements LLMAdapter {
  async complete() {
    return {
      message: {
        role: "assistant" as const,
        content: JSON.stringify({
          passed: true,
          score: 1,
          action: "pass",
          critiques: [],
          verdict: "ok",
          requiredFixes: [],
          strengths: ["ok"],
          mistakes: [],
          takeaways: ["ok"],
        }),
      },
      stop_reason: "end_turn" as const,
    };
  }

  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text", text: "ok" };
    yield { type: "done", stop_reason: "end_turn" };
  }
}

class RecordingRunner implements AgentRunner {
  readonly started: string[] = [];

  async run(assignment: AgentAssignment): Promise<StepResult> {
    this.started.push(assignment.stepId);
    return {
      flowId: assignment.flowId,
      stepId: assignment.stepId,
      output: `done:${assignment.stepId}`,
      toolCalls: [],
    };
  }
}

function makePlan(): ExecutionPlan {
  return {
    planId: "plan-1",
    goal: "Run stages",
    assumptions: [],
    risk: "medium",
    steps: [
      {
        id: "a",
        type: "delegate",
        action: "A",
        dependsOn: [],
        assignedAgent: "default",
        status: "pending",
      },
      {
        id: "b",
        type: "delegate",
        action: "B",
        dependsOn: [],
        assignedAgent: "default",
        status: "pending",
      },
      {
        id: "c",
        type: "delegate",
        action: "C",
        dependsOn: ["a", "b"],
        assignedAgent: "default",
        status: "pending",
      },
    ],
  };
}

describe("flow parallel runtime", () => {
  it("dispatches dependency-ready steps in the same batch", async () => {
    const runner = new RecordingRunner();
    const artifactsRootDir = await mkdtemp(join(tmpdir(), "vera-flow-runtime-"));
    const runtime = new HarnessRuntime(new PassingJsonAdapter(), "test-model", {
      artifactsRootDir,
      agents: new Map([["default", runner]]),
    });
    const events: Array<{ type: string; stepIds?: string[] }> = [];

    const handle = await runtime.startFlow({
      flowId: "iter-test",
      goal: "Run stages",
      plan: makePlan(),
      scope: { workdir: artifactsRootDir },
    });
    const result = await runtime.runFlowLoop(handle, {
      maxParallel: 2,
      onEvent: (event) => {
        if (event.type === "batch_start") {
          events.push({ type: event.type, stepIds: event.stepIds });
        }
      },
    });

    expect(events[0]).toEqual({ type: "batch_start", stepIds: ["a", "b"] });
    expect(runner.started).toEqual(["a", "b", "c"]);
    expect(result.completedSteps).toEqual(["a", "b", "c"]);
    expect(result.handle.flow.state).toBe("completed");
  });
});

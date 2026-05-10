/**
 * D5: End-to-End Smoke Test
 *
 * Tests the complete pipeline through harness-local modules only,
 * avoiding `@open-vera/core` export restrictions.
 *
 * Pipeline: Plan → Flow state machine → Checkpoint save/load/resume
 *           → Tool registry + middleware → Agent runner registry
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock ink to prevent terminal UI crash in vitest
vi.mock("ink", () => ({
  default: {},
  render: vi.fn(),
  Box: vi.fn(),
  Text: vi.fn(),
}));

import type { ExecutionPlan } from "@open-vera/core/types";
import type { AgentRunner } from "../src/agent/types.js";

import { CheckpointStore, makeCheckpointId } from "../src/runtime/checkpoint-store.js";
import {
  checkpointFromFlow,
  createTaskFlow,
} from "../src/runtime/flow.js";
import {
  canTransition,
  isFlowDone,
} from "../src/runtime/flow-state.js";
import { ToolRegistry } from "@open-vera/core/tools";
import type { ToolDef } from "@open-vera/core/tools";
import { AgentRunnerRegistry } from "../src/agent/types.js";

// ─── helpers ───────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `e2e-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makePlan(goal: string): ExecutionPlan {
  return {
    planId: "plan-smoke",
    goal,
    assumptions: [],
    risk: "low" as const,
    steps: [
      {
        id: "analyze",
        type: "analyze",
        action: "Analyze codebase",
        dependsOn: [],
        assignedAgent: "coder",
        status: "pending",
      },
      {
        id: "implement",
        type: "tool",
        action: "Implement changes",
        dependsOn: ["analyze"],
        assignedAgent: "coder",
        status: "pending",
      },
      {
        id: "test",
        type: "finalize",
        action: "Run tests",
        dependsOn: ["implement"],
        assignedAgent: "coder",
        status: "pending",
      },
    ],
  };
}

// ─── tests ─────────────────────────────────────────────────────

describe("D5: End-to-end smoke test", () => {
  let dir: string;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("full pipeline: plan → flow → checkpoint → modify → checkpoint → resume", () => {
    // Step 1: Create a plan and flow
    const plan = makePlan("Fix auth bug");
    const flow = createTaskFlow({ flowId: "smoke-1", goal: plan.goal, plan });
    expect(flow.state).toBe("planning");
    expect(flow.plan!.steps).toHaveLength(3);

    // Step 2: planning → dispatching → executing (valid state machine path)
    expect(canTransition(flow.state, "dispatching")).toBe(true);
    flow.state = "dispatching";
    expect(canTransition(flow.state, "executing")).toBe(true);
    flow.state = "executing";
    flow.activeStepId = "analyze";

    // Step 3: Checkpoint at "analyze" step
    const cpStore = new CheckpointStore({ checkpointsDir: join(dir, "checkpoints") });
    const cp1 = checkpointFromFlow({
      checkpointId: makeCheckpointId(),
      flow,
      artifacts: [],
    });
    cpStore.save(cp1);

    // Step 4: Complete "analyze", move to "implement"
    flow.plan!.steps[0].status = "done";
    flow.activeStepId = "implement";
    const cp2 = checkpointFromFlow({
      checkpointId: makeCheckpointId(),
      flow,
      artifacts: [
        {
          id: "art-1",
          stepId: "analyze",
          type: "report",
          description: "Analysis result",
        },
      ],
    });
    cpStore.save(cp2);

    // Step 5: Resume from latest checkpoint
    const resumed = cpStore.loadLatest("smoke-1")!;
    expect(resumed.activeStepId).toBe("implement");
    expect(resumed.plan!.steps[0].status).toBe("done");
    expect(resumed.artifacts).toHaveLength(1);

    // Step 6: Create a new flow from resumed checkpoint (simulate resume)
    const resumedFlow = createTaskFlow({
      flowId: resumed.flowId,
      goal: resumed.plan!.goal,
      plan: resumed.plan!,
    });
    resumedFlow.state = resumed.state;
    resumedFlow.activeStepId = resumed.activeStepId;
    expect(resumedFlow.activeStepId).toBe("implement");
  });

  it("tool registry with middleware processes a pipeline correctly", async () => {
    const ctx = { cwd: "/tmp", readonlyMode: false };

    const registry = new ToolRegistry();

    // Register a "lint" tool
    const lintTool: ToolDef<{ file: string }> = {
      name: "lint",
      description: "Lint a file",
      parameters: {
        type: "object",
        properties: { file: { type: "string" } },
        required: ["file"],
      },
      execute: async (args) => ({
        ok: true,
        content: `Linted ${args.file}: 0 errors`,
      }),
    };
    registry.register(lintTool);

    // Add logging middleware
    const log: string[] = [];
    registry.addMiddleware({
      name: "logger",
      before: async (name, args) => {
        log.push(`before:${name}`);
        return { args };
      },
      after: async (name, _args, result) => {
        log.push(`after:${name}`);
        return result;
      },
    });

    // Add validation middleware
    registry.addMiddleware({
      name: "validator",
      before: async (_name, args) => {
        const file = (args as { file?: string }).file;
        if (!file) {
          return {
            skip: true,
            result: { ok: false, content: "Missing file" },
            args,
          };
        }
        return { args };
      },
    });

    // Valid call
    const result = await registry.execute("lint", { file: "auth.ts" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("0 errors");
    expect(log).toEqual(["before:lint", "after:lint"]);

    // Invalid call (skip by validator)
    log.length = 0;
    const bad = await registry.execute("lint", { file: "" }, ctx);
    expect(bad.ok).toBe(false);
    expect(bad.content).toBe("Missing file");
    // logger still runs even on skip
    expect(log).toEqual(["before:lint", "after:lint"]);
  });

  it("agent runner registry: register → capability match → fallback chain", async () => {
    const registry = new AgentRunnerRegistry();

    const coder: AgentRunner = {
      name: "coder",
      capabilities: { tags: ["coding"], supportsTools: true },
      isReady: async () => ({ ready: true }),
      run: async (a) => ({
        flowId: a.flowId,
        stepId: a.stepId,
        output: "coded",
        toolCalls: [],
      }),
    };

    const reviewer: AgentRunner = {
      name: "reviewer",
      capabilities: { tags: ["review"], supportsTools: true },
      run: async (a) => ({
        flowId: a.flowId,
        stepId: a.stepId,
        output: "reviewed",
        toolCalls: [],
      }),
    };

    const fallback: AgentRunner = {
      name: "fallback",
      capabilities: { tags: ["coding", "review"] },
      isReady: async () => ({ ready: true }),
      run: async (a) => ({
        flowId: a.flowId,
        stepId: a.stepId,
        output: "fallback-done",
        toolCalls: [],
      }),
    };

    registry.register("coder", coder);
    registry.register("reviewer", reviewer);
    registry.register("fallback", fallback);

    // Capability match
    const coders = registry.findByCapabilities({ tags: ["coding"] });
    expect(coders).toHaveLength(2); // coder + fallback

    // Fallback chain: coder is ready → use coder
    const primary = await registry.getAvailable("coder", ["fallback"]);
    expect(primary!.name).toBe("coder");

    // Fallback chain: coder offline → use fallback
    coder.isReady = async () => ({ ready: false, reason: "offline" });
    const fallbackResult = await registry.getAvailable("coder", ["fallback"]);
    expect(fallbackResult!.name).toBe("fallback");
  });

  it("flow state machine: valid transition paths through planning → completed", () => {
    const plan = makePlan("Full lifecycle");
    const flow = createTaskFlow({ flowId: "lifecycle-1", goal: plan.goal, plan });

    expect(flow.state).toBe("planning");

    // planning → dispatching
    expect(canTransition(flow.state, "dispatching")).toBe(true);
    flow.state = "dispatching";
    expect(isFlowDone(flow)).toBe(false);

    // dispatching → waiting_approval → executing → critiquing → completed
    expect(canTransition(flow.state, "waiting_approval")).toBe(true);
    flow.state = "waiting_approval";
    expect(canTransition(flow.state, "executing")).toBe(true);
    flow.state = "executing";
    expect(canTransition(flow.state, "critiquing")).toBe(true);
    flow.state = "critiquing";
    expect(canTransition(flow.state, "completed")).toBe(true);
    flow.state = "completed";
    expect(isFlowDone(flow)).toBe(true);
  });

  it("checkpoint compaction + load preserves data integrity", () => {
    const cpStore = new CheckpointStore({
      checkpointsDir: join(dir, "compact-cp"),
      compactAfter: 5,
      compactToKeep: 3,
    });

    const plan = makePlan("Compaction test");
    const flow = createTaskFlow({
      flowId: "compact-flow",
      goal: plan.goal,
      plan,
    });

    // Save 8 checkpoints. After 6 lines, auto-compact fires (6 > 5) → keeps last 3.
    // Then 2 more saves add 2 lines → total 5.
    for (let i = 0; i < 8; i++) {
      flow.loopCount = i;
      flow.activeStepId = flow.plan!.steps[i % 3].id;
      const cp = checkpointFromFlow({
        checkpointId: `cp-${i}`,
        flow,
        artifacts: [],
      });
      cpStore.save(cp);
    }

    // After compaction (fires at 6th save) + 2 more saves: should be 5
    expect(cpStore.count("compact-flow")).toBe(5);

    const latest = cpStore.loadLatest("compact-flow")!;
    expect(latest.checkpointId).toBe("cp-7");
    expect(latest.loopCount).toBe(7);
  });
});
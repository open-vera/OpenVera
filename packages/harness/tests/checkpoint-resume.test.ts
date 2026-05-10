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

import type { ExecutionPlan, TaskFlow } from "@open-vera/core/types";
import { CheckpointStore, makeCheckpointId } from "../src/runtime/checkpoint-store.js";
import {
  checkpointFromFlow,
  createTaskFlow,
} from "../src/runtime/flow.js";

// ─── helpers ───────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `checkpoint-resume-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makePlan(): ExecutionPlan {
  return {
    planId: "plan-test",
    goal: "Test checkpoint resume",
    assumptions: [],
    risk: "low",
    steps: [
      { id: "s1", type: "analyze", action: "Analyze code", dependsOn: [], assignedAgent: "default", status: "pending" },
      { id: "s2", type: "tool", action: "Implement fix", dependsOn: ["s1"], assignedAgent: "default", status: "pending" },
      { id: "s3", type: "finalize", action: "Run tests", dependsOn: ["s2"], assignedAgent: "default", status: "pending" },
    ],
  };
}

function makeFlow(flowId: string, goal: string, plan?: ExecutionPlan): TaskFlow {
  return createTaskFlow({ flowId, goal, plan: plan ?? makePlan() });
}

function saveFlow(store: CheckpointStore, flow: TaskFlow, checkpointId: string): void {
  store.save(checkpointFromFlow({
    checkpointId,
    flow,
    artifacts: flow.artifacts ?? [],
  }));
}

// ─── tests ─────────────────────────────────────────────────────

describe("D2: Checkpoint resume complete flow", () => {
  let dir: string;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("plan → checkpoint → resume restores flow state", () => {
    const store = new CheckpointStore({ checkpointsDir: join(dir, "cp") });
    const flow = makeFlow("resume-test", "Test checkpoint resume");

    expect(flow.flowId).toBe("resume-test");
    expect(flow.state).toBe("planning");

    // Transition to executing and set active step
    flow.state = "executing";
    flow.activeStepId = "s1";
    saveFlow(store, flow, "cp-mid-exec");

    // Load checkpoint back
    const loaded = store.loadLatest("resume-test");
    expect(loaded).not.toBeNull();
    expect(loaded!.checkpointId).toBe("cp-mid-exec");
    expect(loaded!.flowId).toBe("resume-test");
    expect(loaded!.state).toBe("executing");
    expect(loaded!.activeStepId).toBe("s1");
    expect(loaded!.plan!.steps).toHaveLength(3);
  });

  it("checkpoint with plan steps done preserves step status", () => {
    const store = new CheckpointStore({ checkpointsDir: join(dir, "cp") });
    const flow = makeFlow("skip-test", "Test skip");

    flow.plan!.steps[0].status = "done";
    flow.state = "executing";
    flow.activeStepId = "s2";
    saveFlow(store, flow, "cp-s1-done");

    const loaded = store.loadLatest("skip-test")!;
    expect(loaded.plan!.steps[0].status).toBe("done");
    expect(loaded.plan!.steps[0].id).toBe("s1");
    expect(loaded.plan!.steps[1].status).toBe("pending");
  });

  it("multiple checkpoints → loadLatest returns the latest", () => {
    const store = new CheckpointStore({ checkpointsDir: join(dir, "cp") });
    const flow = makeFlow("latest-test", "Test loadLatest");

    flow.state = "executing";
    flow.activeStepId = "s1";
    saveFlow(store, flow, "cp-1");

    flow.activeStepId = "s2";
    saveFlow(store, flow, "cp-2");

    expect(store.count("latest-test")).toBe(2);

    const latest = store.loadLatest("latest-test");
    expect(latest!.checkpointId).toBe("cp-2");
    expect(latest!.activeStepId).toBe("s2");
  });

  it("fork from checkpoint creates independent copy with reset steps", () => {
    const store = new CheckpointStore({ checkpointsDir: join(dir, "cp") });
    const flow = makeFlow("original-flow", "Original goal");

    flow.plan!.steps[0].status = "done";
    flow.state = "executing";
    flow.activeStepId = "s2";
    saveFlow(store, flow, "cp-for-fork");

    // Load original checkpoint
    const original = store.loadLatest("original-flow")!;

    // Create fork: new flow with reset s1
    const forked = createTaskFlow({
      flowId: "forked-flow",
      goal: "Forked goal",
      plan: {
        ...original.plan!,
        planId: "plan-forked",
        steps: original.plan!.steps.map((s) => ({
          ...s,
          status: s.id === "s1" ? "pending" as const : s.status,
        })),
      },
    });

    expect(forked.flowId).toBe("forked-flow");
    expect(forked.goal).toBe("Forked goal");
    expect(forked.plan!.steps[0].status).toBe("pending"); // reset
    expect(forked.plan!.steps[1].status).toBe("pending");

    // Original is unaffected
    const origReloaded = store.loadLatest("original-flow")!;
    expect(origReloaded.plan!.steps[0].status).toBe("done");
  });

  it("resume returns null for non-existent flow", () => {
    const store = new CheckpointStore({ checkpointsDir: join(dir, "cp") });
    expect(store.loadLatest("no-such-flow")).toBeNull();
  });

  it("checkpoint preserves full plan with all steps", () => {
    const store = new CheckpointStore({ checkpointsDir: join(dir, "cp") });
    const flow = makeFlow("full-plan", "Test full plan preservation");
    saveFlow(store, flow, "cp-full");

    const loaded = store.loadLatest("full-plan")!;
    expect(loaded.plan).toBeDefined();
    expect(loaded.plan!.planId).toBe("plan-test");
    expect(loaded.plan!.steps).toHaveLength(3);
    expect(loaded.plan!.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(loaded.plan!.steps[1].dependsOn).toEqual(["s1"]);
  });

  it("multi-round: checkpoint → modify → checkpoint → load latest", () => {
    const store = new CheckpointStore({ checkpointsDir: join(dir, "cp") });
    const flow = makeFlow("multi-round", "Multi-round test");

    // Round 1: initial
    saveFlow(store, flow, "cp-start");

    // Round 2: executing s1
    flow.state = "executing";
    flow.activeStepId = "s1";
    flow.loopCount = 1;
    saveFlow(store, flow, "cp-s1");

    // Round 3: s1 done, s2
    flow.plan!.steps[0].status = "done";
    flow.activeStepId = "s2";
    flow.loopCount = 2;
    saveFlow(store, flow, "cp-s2");

    const latest = store.loadLatest("multi-round")!;
    expect(latest.loopCount).toBe(2);
    expect(latest.activeStepId).toBe("s2");
    expect(latest.plan!.steps[0].status).toBe("done");
    // Verify count and specific checkpoints by ID
    expect(store.count("multi-round")).toBe(3);

    const cpStart = store.load("multi-round", "cp-start");
    const cpS2 = store.load("multi-round", "cp-s2");
    expect(cpStart!.checkpointId).toBe("cp-start");
    expect(cpS2!.checkpointId).toBe("cp-s2");
  });

  it("auto-compact preserves data integrity", () => {
    const store = new CheckpointStore({
      checkpointsDir: join(dir, "cp"),
      compactAfter: 5,
      compactToKeep: 3,
    });

    const flow = makeFlow("compact-test", "Compact test");
    for (let i = 0; i < 6; i++) {
      flow.loopCount = i;
      flow.activeStepId = `s${(i % 3) + 1}`;
      saveFlow(store, flow, `cp-${i}`);
    }

    // After compaction, latest should still be cp-5
    const latest = store.loadLatest("compact-test")!;
    expect(latest.checkpointId).toBe("cp-5");
    expect(latest.loopCount).toBe(5);

    // Count should be reduced (compactToKeep=3)
    expect(store.count("compact-test")).toBe(3);
  });

  it("concurrent saves to different flows don't interfere", () => {
    const store = new CheckpointStore({ checkpointsDir: join(dir, "cp") });
    const flowA = makeFlow("flow-a", "Flow A");
    const flowB = makeFlow("flow-b", "Flow B");

    saveFlow(store, flowA, "cp-a1");
    saveFlow(store, flowB, "cp-b1");
    saveFlow(store, flowA, "cp-a2");

    expect(store.count("flow-a")).toBe(2);
    expect(store.count("flow-b")).toBe(1);
    expect(store.loadLatest("flow-a")!.checkpointId).toBe("cp-a2");
    expect(store.loadLatest("flow-b")!.checkpointId).toBe("cp-b1");
  });

  it("checkpoint preserves artifacts arrays", () => {
    const store = new CheckpointStore({ checkpointsDir: join(dir, "cp") });
    const flow = makeFlow("data-test", "Data preservation");

    flow.artifacts = [
      { id: "art-1", stepId: "s1", type: "code", path: "/tmp/test.ts", description: "test artifact" },
    ] as typeof flow.artifacts;

    const cp = checkpointFromFlow({
      checkpointId: "cp-data",
      flow,
      artifacts: flow.artifacts,
    });
    store.save(cp);

    const loaded = store.loadLatest("data-test")!;
    expect(loaded.artifacts).toHaveLength(1);
    expect(loaded.artifacts[0].path).toBe("/tmp/test.ts");
  });
});

import { describe, expect, it } from "vitest";
import type { ExecutionPlan } from "@open-vera/core/types";
import {
  assertTransition,
  canTransition,
  isFlowDone,
  isFlowWaiting,
  transitionFlow,
  transitionFlowPath,
} from "../src/runtime/flow-state.js";
import {
  attachArtifacts,
  checkpointFromFlow,
  createTaskFlow,
  planToArtifact,
} from "../src/runtime/flow.js";
import { parseExecutionPlan } from "../src/runtime/plan-parser.js";
import {
  buildStepCritiqueOutputs,
  diffPlans,
  mergePlans,
} from "../src/runtime/critique.js";
import { SkillResolver } from "../src/skill/resolver.js";
import type { Skill } from "../src/skill/types.js";

function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    planId: "plan-1",
    goal: "Ship P0",
    assumptions: [],
    risk: "medium",
    steps: [
      {
        id: "analyze",
        type: "analyze",
        action: "Read current code",
        dependsOn: [],
        assignedAgent: "default",
        status: "pending",
      },
      {
        id: "implement",
        type: "tool",
        action: "Apply changes",
        dependsOn: ["analyze"],
        assignedAgent: "default",
        status: "pending",
      },
    ],
    ...overrides,
  };
}

describe("P0 flow primitives", () => {
  it("enforces legal state transitions", () => {
    expect(canTransition("planning", "dispatching")).toBe(true);
    expect(canTransition("completed", "dispatching")).toBe(false);
    expect(() => assertTransition("completed", "dispatching")).toThrow(
      "Illegal flow state transition",
    );
  });

  it("creates flows, transitions through a path, and checkpoints state", () => {
    const plan = makePlan();
    const flow = createTaskFlow({
      flowId: "flow-1",
      goal: "Ship P0",
      plan,
      scope: { workdir: "/repo", budgetTokens: 10_000, budgetUsd: 1 },
      maxLoops: 5,
    });

    expect(flow).toMatchObject({
      state: "planning",
      activeStepId: "analyze",
      maxLoops: 5,
      budget: { tokenBudget: 10_000, usdBudget: 1, tokensUsed: 0, usdUsed: 0 },
    });

    const dispatching = transitionFlow(flow, "dispatching");
    const executing = transitionFlowPath(dispatching, ["executing", "critiquing"]);
    const withArtifacts = attachArtifacts(executing, [
      { id: "result-1", type: "step_result", summary: "done" },
    ]);
    const checkpoint = checkpointFromFlow({
      checkpointId: "cp-1",
      flow: withArtifacts,
      artifacts: withArtifacts.artifacts,
    });

    expect(checkpoint).toMatchObject({
      checkpointId: "cp-1",
      flowId: "flow-1",
      state: "critiquing",
      loopCount: 0,
    });
    expect(checkpoint.artifacts).toHaveLength(1);
    expect(isFlowWaiting({ ...flow, state: "waiting_approval" })).toBe(true);
    expect(isFlowDone({ ...flow, state: "completed" })).toBe(true);
  });

  it("converts a plan into an artifact record", () => {
    expect(planToArtifact(makePlan())).toEqual({
      id: "plan-plan-1",
      type: "plan",
      summary: "Ship P0",
    });
  });
});

describe("P0 plan parsing", () => {
  it("parses fenced JSON and normalizes step fields", () => {
    const plan = parseExecutionPlan(
      `Planner output:
\`\`\`json
{
  "planId": "p-json",
  "goal": "Improve tests",
  "assumptions": ["repo exists"],
  "risk": "high",
  "steps": [
    { "id": "s1", "type": "inspect files", "action": "Read tests", "dependsOn": [1, "root"] },
    { "type": "final verification", "action": "Run tests" }
  ]
}
\`\`\``,
      "Improve tests",
    );

    expect(plan.planId).toBe("p-json");
    expect(plan.risk).toBe("high");
    expect(plan.steps[0]).toMatchObject({
      id: "s1",
      type: "analyze",
      dependsOn: ["root"],
      status: "pending",
    });
    expect(plan.steps[1]).toMatchObject({
      id: "step_2",
      type: "finalize",
      assignedAgent: "default",
    });
  });

  it("falls back to numbered lists when JSON parsing fails", () => {
    const plan = parseExecutionPlan(
      ["1. Read the existing files", "2. Edit the implementation", "3. Run tests"].join("\n"),
      "Finish P0",
    );

    expect(plan.assumptions).toContain("解析失败，降级为单步 Plan");
    expect(plan.steps.map((s) => s.type)).toEqual(["analyze", "tool", "tool"]);
  });
});

describe("P0 critique/replan helpers", () => {
  it("builds critique outputs from agent prose and tool calls", () => {
    const outputs = buildStepCritiqueOutputs({
      flowId: "flow-1",
      stepId: "step-1",
      output: "Implemented auth",
      toolCalls: [
        { name: "edit_file", arguments: { path: "auth.ts" }, result: "patched" },
      ],
    });

    expect(outputs.output).toBe("Implemented auth");
    expect(outputs.tool_calls).toContain("[edit_file]");
    expect(outputs.tool_calls).toContain('"path":"auth.ts"');
    expect(outputs.tool_calls).toContain("patched");
  });

  it("preserves completed steps when merging replanned output", () => {
    const original = makePlan({
      steps: [
        {
          id: "done",
          type: "analyze",
          action: "Original completed action",
          status: "done",
        },
        {
          id: "failed",
          type: "tool",
          action: "Old failed action",
          status: "failed",
        },
      ],
    });
    const replanned = makePlan({
      planId: "plan-2",
      steps: [
        {
          id: "failed",
          type: "tool",
          action: "New fixed action",
          status: "pending",
        },
        {
          id: "new",
          type: "finalize",
          action: "Verify",
          status: "pending",
        },
      ],
    });

    expect(diffPlans(original, replanned)).toEqual({
      preserved: [],
      modified: ["failed"],
      added: ["new"],
      removed: [],
    });

    const merged = mergePlans(original, replanned);
    expect(merged.steps[0]).toMatchObject({
      id: "done",
      action: "Original completed action",
      status: "done",
    });
    expect(merged.steps.map((s) => s.id)).toEqual(["done", "failed", "new"]);
  });
});

describe("P0 skill resolver", () => {
  const codeSkill: Skill = {
    id: "code",
    name: "Code",
    description: "Code skill",
    triggers: [{ type: "domain", domains: ["code"] }],
    systemFragment: "Use repo conventions.",
    tools: [
      {
        definition: {
          name: "inspect",
          description: "Inspect code",
          parameters: { type: "object", properties: {} },
        },
        executor: () => "inspected",
      },
    ],
  };

  it("activates skills by trigger and merges system/tools/executors", () => {
    const resolver = new SkillResolver();
    resolver.registerAll([
      codeSkill,
      {
        id: "explicit",
        name: "Explicit",
        description: "Explicit skill",
        triggers: [{ type: "explicit" }],
        systemFragment: "Explicit fragment.",
      },
    ]);

    const bundle = resolver.resolve(
      { domain: "code", level: 1, needs_tools: true },
      "Base system",
    );

    expect(bundle.system).toContain("Base system");
    expect(bundle.system).toContain("Use repo conventions.");
    expect(bundle.system).not.toContain("Explicit fragment.");
    expect(bundle.tools.map((t) => t.name)).toEqual(["inspect"]);
    expect(bundle.executors.get("inspect")?.({})).toBe("inspected");
  });

  it("supports explicit activation and reports auto skills", () => {
    const resolver = new SkillResolver();
    resolver.register(codeSkill);
    resolver.register({
      id: "manual",
      name: "Manual",
      description: "Manual only",
      triggers: [{ type: "explicit" }],
      systemFragment: "Manual fragment.",
    });

    expect(resolver.list()).toEqual([
      expect.objectContaining({ id: "code", auto: true }),
      expect.objectContaining({ id: "manual", auto: false }),
    ]);
    expect(
      resolver.resolve(
        { domain: "chat", level: 0, needs_tools: false, explicitIds: ["manual"] },
        "Base",
      ).system,
    ).toContain("Manual fragment.");
  });
});

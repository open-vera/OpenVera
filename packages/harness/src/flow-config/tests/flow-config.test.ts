import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { listFlowDefinitions, loadFlowDefinition } from "../index.js";
import { flowDefinitionToPlan } from "../../cli/plan.js";

async function writeMarkdown(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf-8");
}

describe("flow config loader", () => {
  it("loads flow, stages, and agents from .vera/flows layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-flows-"));
    const flowsDir = join(root, ".vera", "flows");

    await writeMarkdown(
      join(flowsDir, "flow", "demo", "main.md"),
      `---
name: demo
workspace: ../..
max_retries: 2
max_parallel: 4
---

# Goal
Ship the feature

## Stages

- id: requirement
  stage: requirement
  agents: [pm]

- id: implement
  stage: implement
  agents: [engineer]
  depends_on: [requirement]
`
    );
    await writeMarkdown(
      join(flowsDir, "stages", "requirement", "main.md"),
      `---
name: Requirement
agents: [pm]
---

# Requirement

## 准出标准

- clear scope
`
    );
    await writeMarkdown(
      join(flowsDir, "stages", "implement", "main.md"),
      `---
name: Implement
agents: [engineer]
---

# Implement
`
    );
    await writeMarkdown(
      join(flowsDir, "agents", "engineer", "main.md"),
      `---
name: Engineer
skills: [quality-scan]
rules: [project]
mcp: [filesystem]
---

Build the implementation.
`
    );

    expect(await listFlowDefinitions(flowsDir)).toEqual(["demo"]);

    const flow = await loadFlowDefinition(flowsDir, "demo");
    expect(flow).toMatchObject({
      id: "demo",
      name: "demo",
      workspaceRel: "../..",
      maxRetries: 2,
      maxParallel: 4,
      goal: "Ship the feature",
    });
    expect(flow.stages).toEqual([
      { id: "requirement", stage: "requirement", agents: ["pm"], dependsOn: [] },
      { id: "implement", stage: "implement", agents: ["engineer"], dependsOn: ["requirement"] },
    ]);
    expect(flow.stageDefinitions.get("requirement")?.exitCriteria).toContain("clear scope");
    expect(flow.agents[0]).toMatchObject({
      id: "engineer",
      skills: ["quality-scan"],
      rules: ["project"],
      mcp: ["filesystem"],
    });

    const plan = flowDefinitionToPlan(flow, "iter-1");
    expect(plan.steps.map((step) => ({
      id: step.id,
      dependsOn: step.dependsOn,
      assignedAgent: step.assignedAgent,
    }))).toEqual([
      { id: "requirement", dependsOn: [], assignedAgent: "pm" },
      { id: "implement", dependsOn: ["requirement"], assignedAgent: "engineer" },
    ]);
  });

  it("requires flow selection when multiple flows exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-flows-"));
    const flowsDir = join(root, ".vera", "flows");

    for (const name of ["auto-dev", "test"]) {
      await writeMarkdown(
        join(flowsDir, "flow", name, "main.md"),
        `---
name: ${name}
---

# Goal
Run ${name}

## Stages
`
      );
    }

    await expect(loadFlowDefinition(flowsDir)).rejects.toThrow(
      "Specify one with openvera run <name>"
    );
    expect((await loadFlowDefinition(flowsDir, "test")).id).toBe("test");
  });
});

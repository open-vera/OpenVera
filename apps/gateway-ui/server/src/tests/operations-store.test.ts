import { describe, expect, it } from "vitest";
import { createProject } from "@open-vera/gateway";
import { buildProjectActivity } from "../operations-store.js";
import type { RunSummary } from "../runtime-store.js";

describe("buildProjectActivity", () => {
  it("groups runs by projectId", () => {
    const projectA = createProject("/tmp/a");
    const projectB = createProject("/tmp/b");
    const runs: RunSummary[] = [
      {
        runId: "iter-a",
        projectId: projectA.id,
        projectName: projectA.name,
        status: "running",
        startedAt: "2026-06-04T10:00:00.000Z",
        totalSteps: 1,
        completedSteps: 0,
        failedSteps: 0,
        costUsd: 0,
      },
      {
        runId: "iter-b",
        projectId: projectB.id,
        projectName: projectB.name,
        status: "completed",
        startedAt: "2026-06-04T09:00:00.000Z",
        totalSteps: 2,
        completedSteps: 2,
        failedSteps: 0,
        costUsd: 0.01,
      },
    ];

    const activity = buildProjectActivity([projectA, projectB], runs);
    const a = activity.find((item) => item.projectId === projectA.id);
    const b = activity.find((item) => item.projectId === projectB.id);

    expect(a?.runCount).toBe(1);
    expect(a?.status).toBe("running");
    expect(a?.activeRunId).toBe("iter-a");
    expect(b?.runCount).toBe(1);
    expect(b?.status).toBe("idle");
  });
});

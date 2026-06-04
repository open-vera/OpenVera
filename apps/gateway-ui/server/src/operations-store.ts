import { cpus, freemem, totalmem } from "node:os";
import type { GatewayProject } from "@open-vera/gateway";
import type { RunSummary } from "./runtime-store.js";

export interface HostResources {
  cpu: { cores: number; loadPercent: number };
  memory: { totalBytes: number; usedBytes: number; usedPercent: number };
  disk: { totalBytes: number; usedBytes: number; usedPercent: number };
}

export interface ProjectActivity {
  projectId: string;
  name: string;
  rootDir: string;
  status: "idle" | "running" | "paused";
  activeRunId: string | null;
  runCount: number;
  lastRunAt: string | null;
}

export interface ActivityBucket {
  hour: number;
  runStarts: number;
}

export interface OperationsSummary {
  projectCount: number;
  runningRuns: number;
  completedRuns: number;
  failedRuns: number;
  host: HostResources;
  projects: ProjectActivity[];
}

export function getHostResources(): HostResources {
  const memoryTotal = totalmem();
  const memoryUsed = memoryTotal - freemem();
  return {
    cpu: { cores: cpus().length, loadPercent: 0 },
    memory: {
      totalBytes: memoryTotal,
      usedBytes: memoryUsed,
      usedPercent: memoryTotal > 0 ? Number(((memoryUsed / memoryTotal) * 100).toFixed(1)) : 0,
    },
    disk: { totalBytes: 0, usedBytes: 0, usedPercent: 0 },
  };
}

export function buildProjectActivity(projects: GatewayProject[], runs: RunSummary[]): ProjectActivity[] {
  return projects.map((project) => {
    const projectRuns = runs.filter((run) => run.projectId === project.id);
    const sorted = [...projectRuns].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
    const active = sorted.find((run) => run.status === "running" || run.status === "paused");
    return {
      projectId: project.id,
      name: project.name,
      rootDir: project.rootDir,
      status: active?.status === "paused" ? "paused" : active ? "running" : "idle",
      activeRunId: active?.runId ?? null,
      runCount: projectRuns.length,
      lastRunAt: sorted[0]?.startedAt ?? null,
    };
  });
}

export function getOperationsSummary(projects: GatewayProject[], runs: RunSummary[]): OperationsSummary {
  return {
    projectCount: projects.length,
    runningRuns: runs.filter((run) => run.status === "running").length,
    completedRuns: runs.filter((run) => run.status === "completed").length,
    failedRuns: runs.filter((run) => run.status === "failed").length,
    host: getHostResources(),
    projects: buildProjectActivity(projects, runs),
  };
}

export function getActivityHeatmap(runs: RunSummary[]): ActivityBucket[] {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, runStarts: 0 }));
  for (const run of runs) {
    const hour = new Date(run.startedAt).getHours();
    if (buckets[hour]) buckets[hour].runStarts += 1;
  }
  return buckets;
}

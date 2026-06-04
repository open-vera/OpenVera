import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GatewayProject } from "@open-vera/gateway";

export interface TimelineEvent {
  ts?: string;
  type?: string;
  stepId?: string;
  step?: string;
  status?: string;
  goal?: string;
  costUsd?: number;
  totalUsd?: number;
  [key: string]: unknown;
}

export interface RunSummary {
  runId: string;
  projectId: string;
  projectName: string;
  status: "running" | "completed" | "failed" | "paused";
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  goal?: string;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  costUsd: number;
}

export interface StepSummary {
  stepId: string;
  status: "pending" | "running" | "done" | "failed";
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  agents: string[];
  retries: number;
  score?: number;
}

export interface RunDetail extends RunSummary {
  projectId: string;
  projectName: string;
  runDir: string;
  timeline: TimelineEvent[];
  steps: StepSummary[];
  artifactIds: string[];
}

export interface StepDetail {
  stepId: string;
  events: TimelineEvent[];
  summary?: StepSummary;
  artifacts: string[];
}

export interface FlowTemplate {
  name: string;
  dir: string;
  projectId: string;
  projectName: string;
  description?: string;
  steps: string[];
}

export interface MemoryEntry {
  id: string;
  tier: "episodic" | "semantic" | "working";
  content: string;
  tags: string[];
  createdAt: string;
  importance: number;
  source: string;
}

export interface MemoryResponse {
  snapshot: {
    episodicCount: number;
    semanticCount: number;
    workingCount: number;
  };
  entries: MemoryEntry[];
  total: number;
}

export interface CheckpointIndex {
  checkpointId: string;
  flowId: string;
  state: string;
  createdAt: string;
  activeStepId: string;
  raw: unknown;
}

export interface SubagentResponse {
  poolStatus: {
    totalSlots: number;
    activeAgents: number;
    queuedTasks: number;
  };
  callTree: unknown[];
}

export interface SpawnRunRequest {
  flowDir?: string;
  model?: string;
  provider?: string;
  skipPlanCritique?: boolean;
  maxSteps?: number;
}

export interface SpawnRunResponse {
  runId: string;
  startedAt: string;
}

export interface CostSummary {
  currency: "USD";
  totalUsd: number;
  runCount: number;
  byRun: Array<{ runId: string; costUsd: number; startedAt: string; status: RunSummary["status"] }>;
}

export async function listRuns(projects: GatewayProject[], projectId?: string): Promise<RunSummary[]> {
  const scoped = projectId ? projects.filter((project) => project.id === projectId) : projects;
  const runs = await Promise.all(scoped.map((project) => listProjectRuns(project)));
  return runs.flat().sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

export async function getRun(projects: GatewayProject[], runId: string): Promise<RunDetail | undefined> {
  for (const project of projects) {
    const detail = await readRunDetail(project, runId);
    if (detail) return detail;
  }
  return undefined;
}

export async function getTimeline(projects: GatewayProject[], runId: string): Promise<TimelineEvent[] | undefined> {
  const run = await findRunDir(projects, runId);
  if (!run) return undefined;
  const events = await readNdjson(join(run.runDir, "timeline.ndjson"));
  return events.length > 0 ? events : undefined;
}

export async function getStep(projects: GatewayProject[], runId: string, stepId: string): Promise<StepDetail | undefined> {
  const detail = await getRun(projects, runId);
  if (!detail) return undefined;
  const events = detail.timeline.filter((event) => event.stepId === stepId || event.step === stepId);
  const summary = detail.steps.find((step) => step.stepId === stepId);
  if (events.length === 0 && !summary) return undefined;
  return {
    stepId,
    events,
    summary,
    artifacts: detail.artifactIds.filter((artifactId) => artifactId.includes(stepId)),
  };
}

export async function getArtifact(projects: GatewayProject[], runId: string, artifactId: string): Promise<unknown | undefined> {
  const run = await findRunDir(projects, runId);
  if (!run) return undefined;
  const raw = await tryReadText(join(run.runDir, "artifacts", `${artifactId}.json`));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export async function getMemory(projects: GatewayProject[], runId: string, tier?: string, search?: string): Promise<MemoryResponse | undefined> {
  const run = await findRunDir(projects, runId);
  if (!run) return undefined;
  const memoryDir = join(run.runDir, "memory");
  const files = (await safeReadDir(memoryDir)).filter((file) => file.endsWith(".jsonl") || file.endsWith(".ndjson"));
  const entries: MemoryEntry[] = [];

  for (const file of files) {
    const raw = await tryReadText(join(memoryDir, file));
    if (!raw) continue;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Partial<MemoryEntry> & { type?: string };
        const entryTier = normalizeTier(parsed.tier ?? parsed.type ?? file.replace(/\.(jsonl|ndjson)$/, ""));
        entries.push({
          id: String(parsed.id ?? `${file}:${entries.length}`),
          tier: entryTier,
          content: String(parsed.content ?? parsed.source ?? ""),
          tags: Array.isArray(parsed.tags) ? parsed.tags.filter((item): item is string => typeof item === "string") : [],
          createdAt: String(parsed.createdAt ?? parsed.source ?? new Date(0).toISOString()),
          importance: typeof parsed.importance === "number" ? parsed.importance : 0,
          source: String(parsed.source ?? file),
        });
      } catch {
        continue;
      }
    }
  }

  const query = search?.trim().toLowerCase();
  const filtered = entries.filter((entry) => {
    const matchesTier = !tier || entry.tier === tier;
    const matchesSearch = !query || entry.content.toLowerCase().includes(query) || entry.tags.some((tag) => tag.toLowerCase().includes(query));
    return matchesTier && matchesSearch;
  });

  return {
    snapshot: {
      episodicCount: entries.filter((entry) => entry.tier === "episodic").length,
      semanticCount: entries.filter((entry) => entry.tier === "semantic").length,
      workingCount: entries.filter((entry) => entry.tier === "working").length,
    },
    entries: filtered.slice(-100).reverse(),
    total: filtered.length,
  };
}

export async function getCheckpoints(projects: GatewayProject[], runId: string): Promise<CheckpointIndex[] | undefined> {
  const run = await findRunDir(projects, runId);
  if (!run) return undefined;
  const checkpoints = await readNdjson(join(run.runDir, "checkpoints.ndjson"));
  return checkpoints.map((checkpoint, index) => ({
    checkpointId: String(checkpoint.checkpointId ?? checkpoint.id ?? `checkpoint-${index}`),
    flowId: String(checkpoint.flowId ?? checkpoint.flow ?? ""),
    state: String(checkpoint.state ?? checkpoint.status ?? "unknown"),
    createdAt: String(checkpoint.createdAt ?? checkpoint.ts ?? new Date(0).toISOString()),
    activeStepId: String(checkpoint.activeStepId ?? checkpoint.stepId ?? ""),
    raw: checkpoint,
  }));
}

export async function getCheckpoint(projects: GatewayProject[], runId: string, checkpointId: string): Promise<CheckpointIndex | undefined> {
  const checkpoints = await getCheckpoints(projects, runId);
  return checkpoints?.find((checkpoint) => checkpoint.checkpointId === checkpointId);
}

export async function getSubagents(projects: GatewayProject[], runId: string): Promise<SubagentResponse | undefined> {
  const run = await findRunDir(projects, runId);
  if (!run) return undefined;
  const raw = await tryReadText(join(run.runDir, "subagents.json"));
  if (!raw) {
    return {
      poolStatus: { totalSlots: 0, activeAgents: 0, queuedTasks: 0 },
      callTree: [],
    };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SubagentResponse>;
    return {
      poolStatus: parsed.poolStatus ?? { totalSlots: 0, activeAgents: 0, queuedTasks: 0 },
      callTree: Array.isArray(parsed.callTree) ? parsed.callTree : [],
    };
  } catch {
    return undefined;
  }
}

export async function listFlows(projects: GatewayProject[], projectId?: string): Promise<FlowTemplate[]> {
  const scoped = projectId ? projects.filter((project) => project.id === projectId) : projects;
  const flows = await Promise.all(scoped.map((project) => listProjectFlows(project)));
  return flows.flat();
}

export function spawnRun(request: SpawnRunRequest, defaultRoot: string): SpawnRunResponse {
  const startedAt = new Date();
  const flowDir = resolve(request.flowDir ?? defaultRoot);
  const runId = `iter-${startedAt.toISOString().replace(/[:.]/g, "-")}`;
  const args = ["flow", "run", "--dir", flowDir];
  if (request.model) args.push("--model", request.model);
  if (request.provider) args.push("--provider", request.provider);
  if (request.skipPlanCritique) args.push("--skip-plan-critique");
  if (request.maxSteps != null) args.push("--max-steps", String(request.maxSteps));

  const localBin = resolve("node_modules/.bin/openvera");
  const cmd = existsSync(localBin) ? localBin : "openvera";
  const child = spawn(cmd, args, {
    cwd: resolve(defaultRoot),
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return { runId, startedAt: startedAt.toISOString() };
}

export async function getCostSummary(projects: GatewayProject[]): Promise<CostSummary> {
  const runs = await listRuns(projects);
  const byRun = runs.map((run) => ({
    runId: run.runId,
    costUsd: run.costUsd,
    startedAt: run.startedAt,
    status: run.status,
  }));

  return {
    currency: "USD",
    totalUsd: byRun.reduce((sum, run) => sum + run.costUsd, 0),
    runCount: byRun.length,
    byRun,
  };
}

async function listProjectRuns(project: GatewayProject): Promise<RunSummary[]> {
  const iterationsDir = join(project.flowsDir, "iterations");
  const runIds = await listDirs(iterationsDir, "iter-");
  const runs = await Promise.all(runIds.map((runId) => readRunSummary(project, iterationsDir, runId)));
  return runs.filter((run): run is RunSummary => run !== undefined);
}

async function readRunDetail(project: GatewayProject, runId: string): Promise<RunDetail | undefined> {
  const iterationsDir = join(project.flowsDir, "iterations");
  const runDir = join(iterationsDir, runId);
  const events = await readNdjson(join(runDir, "timeline.ndjson"));
  if (events.length === 0) return undefined;
  const summary = await readRunSummary(project, iterationsDir, runId);
  if (!summary) return undefined;
  return {
    ...summary,
    runDir,
    timeline: events,
    steps: aggregateSteps(events),
    artifactIds: await listArtifactIds(runDir),
  };
}

async function readRunSummary(
  project: GatewayProject,
  iterationsDir: string,
  runId: string,
): Promise<RunSummary | undefined> {
  const runDir = join(iterationsDir, runId);
  const events = await readNdjson(join(runDir, "timeline.ndjson"));
  if (events.length === 0) return undefined;

  const startedAt = events[0]?.ts ?? new Date().toISOString();
  const terminal = [...events].reverse().find((event) => event.type === "flow_completed" || event.type === "flow_failed");
  const endedAt = terminal?.ts;
  const status = inferRunStatus(events);
  const steps = new Map<string, "running" | "done" | "failed">();

  for (const event of events) {
    const stepId = typeof event.stepId === "string" ? event.stepId : typeof event.step === "string" ? event.step : undefined;
    if (!stepId) continue;
    if (event.type === "step_done") {
      steps.set(stepId, event.status === "failed" ? "failed" : "done");
    } else if (event.type === "step_dispatched" || event.type === "step_start") {
      steps.set(stepId, "running");
    }
  }

  return {
    runId,
    projectId: project.id,
    projectName: project.name,
    status,
    startedAt,
    endedAt,
    durationMs: startedAt && endedAt ? new Date(endedAt).getTime() - new Date(startedAt).getTime() : undefined,
    goal: await readGoal(runDir, events),
    totalSteps: steps.size,
    completedSteps: Array.from(steps.values()).filter((step) => step === "done").length,
    failedSteps: Array.from(steps.values()).filter((step) => step === "failed").length,
    costUsd: collectCost(events),
  };
}

function aggregateSteps(events: TimelineEvent[]): StepSummary[] {
  const steps = new Map<string, StepSummary>();
  for (const event of events) {
    const stepId = typeof event.stepId === "string" ? event.stepId : typeof event.step === "string" ? event.step : undefined;
    if (!stepId) continue;
    const existing = steps.get(stepId) ?? {
      stepId,
      status: "pending" as const,
      agents: [],
      retries: 0,
    };

    if (event.type === "step_dispatched" || event.type === "step_start") {
      existing.status = "running";
      existing.startedAt = String(event.ts ?? existing.startedAt ?? "");
      existing.retries += existing.startedAt ? 1 : 0;
    }
    if (event.type === "agent_call" && typeof event.agent === "string" && !existing.agents.includes(event.agent)) {
      existing.agents.push(event.agent);
    }
    if (event.type === "step_done") {
      existing.status = event.status === "failed" ? "failed" : "done";
      existing.endedAt = String(event.ts ?? "");
      if (existing.startedAt && existing.endedAt) {
        existing.durationMs = new Date(existing.endedAt).getTime() - new Date(existing.startedAt).getTime();
      }
      if (typeof event.score === "number") existing.score = event.score;
    }
    steps.set(stepId, existing);
  }
  return Array.from(steps.values());
}

async function listProjectFlows(project: GatewayProject): Promise<FlowTemplate[]> {
  const flowRoot = join(project.flowsDir, "flow");
  const flowNames = await listDirs(flowRoot);
  const flows: FlowTemplate[] = [];

  for (const flowName of flowNames) {
    const mainPath = join(flowRoot, flowName, "main.md");
    const raw = await tryReadText(mainPath);
    if (!raw) continue;
    const configuredName = raw.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const steps = [...raw.matchAll(/^\s+stage:\s*(.+)$/gm)].map((match) => match[1]!.trim());
    flows.push({
      name: configuredName ?? flowName,
      dir: project.rootDir,
      projectId: project.id,
      projectName: project.name,
      description: raw.match(/^description:\s*(.+)$/m)?.[1]?.trim(),
      steps,
    });
  }

  return flows;
}

export async function resolveRunTimelinePath(
  projects: GatewayProject[],
  runId: string,
): Promise<{ timelinePath: string; status: RunSummary["status"] } | undefined> {
  const located = await findRunDir(projects, runId);
  if (!located) return undefined;
  const iterationsDir = join(located.project.flowsDir, "iterations");
  const summary = await readRunSummary(located.project, iterationsDir, runId);
  return {
    timelinePath: join(located.runDir, "timeline.ndjson"),
    status: summary?.status ?? "running",
  };
}

async function findRunDir(projects: GatewayProject[], runId: string): Promise<{ project: GatewayProject; runDir: string } | undefined> {
  for (const project of projects) {
    const runDir = join(project.flowsDir, "iterations", runId);
    if ((await readNdjson(join(runDir, "timeline.ndjson"))).length > 0 || existsSync(runDir)) {
      return { project, runDir };
    }
  }
  return undefined;
}

async function listArtifactIds(runDir: string): Promise<string[]> {
  const files = await safeReadDir(join(runDir, "artifacts"));
  return files.filter((file) => file.endsWith(".json")).map((file) => file.replace(/\.json$/, "")).sort();
}

function normalizeTier(value: string): MemoryEntry["tier"] {
  if (value === "semantic" || value === "working") return value;
  return "episodic";
}

function inferRunStatus(events: TimelineEvent[]): RunSummary["status"] {
  if (events.some((event) => event.type === "flow_failed")) return "failed";
  if (events.some((event) => event.type === "flow_completed")) return "completed";
  if (events.some((event) => event.type === "approval_requested")) return "paused";
  return "running";
}

async function readGoal(runDir: string, events: TimelineEvent[]): Promise<string | undefined> {
  const eventGoal = events.find((event) => typeof event.goal === "string")?.goal;
  if (typeof eventGoal === "string") return eventGoal;

  const artifactsDir = join(runDir, "artifacts");
  const files = await safeReadDir(artifactsDir);
  for (const file of files) {
    if (!file.startsWith("plan-") || !file.endsWith(".json")) continue;
    const raw = await tryReadText(join(artifactsDir, file));
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { goal?: unknown };
      if (typeof parsed.goal === "string") return parsed.goal;
    } catch {
      continue;
    }
  }
  return undefined;
}

function collectCost(events: TimelineEvent[]): number {
  let total = 0;
  for (const event of events) {
    if (typeof event.costUsd === "number") total += event.costUsd;
    if (typeof event.totalUsd === "number") total = Math.max(total, event.totalUsd);
  }
  return Number(total.toFixed(6));
}

async function readNdjson(path: string): Promise<TimelineEvent[]> {
  const raw = await tryReadText(path);
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TimelineEvent];
      } catch {
        return [];
      }
    });
}

async function listDirs(path: string, prefix = ""): Promise<string[]> {
  if (!existsSync(path)) return [];
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function safeReadDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function tryReadText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

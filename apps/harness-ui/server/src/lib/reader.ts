import { readNdjson, tryReadJson, tryReadText, listDirs, join } from "./fs.js";
import type {
  RunSummary,
  RunStatus,
  StepSummary,
  StepDetail,
  AgentInteraction,
  TimelineEvent,
} from "../types.js";

// ── Timeline aggregation ──────────────────────────────────────────────────────

function getStepId(event: TimelineEvent): string | undefined {
  // new harness: stepId; old harness: step
  return (event.stepId ?? event.step) as string | undefined;
}

export function aggregateTimeline(
  runId: string,
  flowDir: string,
  events: TimelineEvent[]
): Omit<RunSummary, "goal" | "artifactIds"> {
  const steps = new Map<string, StepSummary>();
  let status: RunStatus = "running";
  const startedAt = events[0]?.ts ?? new Date().toISOString();
  let endedAt: string | undefined;

  for (const ev of events) {
    switch (ev.type) {
      // ── new harness ──
      case "flow_started": {
        break;
      }
      case "step_dispatched": {
        const stepId = getStepId(ev)!;
        const agentId = (ev.agentId as string) ?? "agent";
        const existing = steps.get(stepId);
        if (!existing) {
          steps.set(stepId, {
            stepId,
            status: "running",
            retries: 0,
            agents: [agentId],
            startedAt: ev.ts,
          });
        } else {
          existing.retries += 1;
          existing.status = "running";
          existing.startedAt = ev.ts;
          existing.endedAt = undefined;
          if (!existing.agents.includes(agentId)) existing.agents.push(agentId);
        }
        break;
      }
      case "critique_completed": {
        const detail = (ev.detail as string) ?? "";
        const confidence = ev.confidence as number;
        // detail == "plan" → plan-level critique; "replan:..." → replan; else step name
        if (detail && detail !== "plan" && !detail.startsWith("replan:")) {
          const step = steps.get(detail);
          if (step) {
            step.score = confidence;
            step.critique = { confidence };
          }
        }
        break;
      }
      case "flow_completed": {
        status = "completed";
        endedAt = ev.ts;
        // mark all running steps as done
        for (const s of steps.values()) {
          if (s.status === "running") s.status = "done";
        }
        break;
      }
      case "flow_failed": {
        status = "failed";
        endedAt = ev.ts;
        break;
      }
      case "approval_requested": {
        // paused waiting for human
        status = "paused";
        break;
      }

      // ── old harness (demo) ──
      case "plan": {
        break;
      }
      case "step_start": {
        const stepId = getStepId(ev)!;
        const existing = steps.get(stepId);
        if (!existing) {
          steps.set(stepId, {
            stepId,
            status: "running",
            retries: 0,
            agents: [],
            startedAt: ev.ts,
          });
        } else {
          existing.retries += 1;
          existing.status = "running";
          existing.startedAt = ev.ts;
          existing.endedAt = undefined;
        }
        break;
      }
      case "agent_call": {
        const stepId = getStepId(ev)!;
        const agent = ev.agent as string;
        const adapter = ev.adapter as string | undefined;
        const step = steps.get(stepId);
        if (step && agent && !step.agents.includes(agent)) {
          step.agents.push(agent);
        }
        if (step && adapter) {
          // store adapter on last agent slot — informational
          void adapter;
        }
        break;
      }
      case "eval": {
        const stepId = getStepId(ev)!;
        const step = steps.get(stepId);
        if (step) {
          const score = ev.score as number;
          step.score = score;
          step.critique = {
            confidence: score,
            nextAction: ev.action as string | undefined,
          };
        }
        break;
      }
      case "retry": {
        const stepId = getStepId(ev)!;
        const step = steps.get(stepId);
        if (step) {
          step.critique = {
            ...step.critique,
            confidence: step.critique?.confidence ?? 0,
            rationale: ev.detail as string | undefined,
          };
        }
        break;
      }
      case "step_done": {
        const stepId = getStepId(ev)!;
        const step = steps.get(stepId);
        if (step) {
          const rawStatus = ev.status as string;
          step.status =
            rawStatus === "passed" || rawStatus === "completed"
              ? "done"
              : rawStatus === "failed"
                ? "failed"
                : "done";
          if (ev.score != null) step.score = ev.score as number;
          step.endedAt = ev.ts;
          if (step.startedAt) {
            step.durationMs =
              new Date(ev.ts).getTime() - new Date(step.startedAt).getTime();
          }
        }
        break;
      }
    }
  }

  const stepList = [...steps.values()];
  const completedSteps = stepList.filter((s) => s.status === "done").length;
  const failedSteps = stepList.filter((s) => s.status === "failed").length;

  // Infer terminal status if not explicitly set
  if (status === "running" && failedSteps > 0) {
    const lastEvent = events[events.length - 1];
    const lastTs = lastEvent?.ts ?? "";
    const anyActivityAfterFail = stepList.some(
      (s) => s.status === "running" && s.startedAt && s.startedAt > lastTs
    );
    if (!anyActivityAfterFail) {
      // if there are still running steps, keep as running; otherwise failed
      const hasRunning = stepList.some((s) => s.status === "running");
      if (!hasRunning) status = "failed";
    }
  }

  const durationMs =
    startedAt && endedAt
      ? new Date(endedAt).getTime() - new Date(startedAt).getTime()
      : undefined;

  return {
    runId,
    flowDir,
    startedAt,
    endedAt,
    durationMs,
    status,
    steps: stepList,
    totalSteps: stepList.length,
    completedSteps,
    failedSteps,
  };
}

// ── Run summary (with goal + artifacts) ──────────────────────────────────────

export async function readRunSummary(
  iterationsDir: string,
  runId: string
): Promise<RunSummary | undefined> {
  const runDir = join(iterationsDir, runId);
  const timelinePath = join(runDir, "timeline.ndjson");
  const events = (await readNdjson(timelinePath)) as TimelineEvent[];
  if (events.length === 0) return undefined;

  const base = aggregateTimeline(runId, runDir, events);

  // Try to read goal from plan artifact
  let goal: string | undefined;
  const artifactIds: string[] = [];

  try {
    const { readdir } = await import("node:fs/promises");
    const artifactsDir = join(runDir, "artifacts");
    const files = await readdir(artifactsDir).catch(() => []);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const id = f.replace(/\.json$/, "");
      artifactIds.push(id);
      if (id.startsWith("plan-") && !goal) {
        const data = (await tryReadJson(join(artifactsDir, f))) as
          | { goal?: string }
          | undefined;
        if (data?.goal) goal = data.goal;
      }
    }
  } catch {
    // artifacts dir may not exist yet for very new runs
  }

  return { ...base, goal, artifactIds };
}

// ── Step detail ───────────────────────────────────────────────────────────────

export async function readStepDetail(
  iterationsDir: string,
  runId: string,
  stepId: string
): Promise<StepDetail | undefined> {
  const stepDir = join(iterationsDir, runId, "steps", stepId);

  // Collect all agent interactions from prompt-{agent}.md + response-{agent}.md
  let files: string[] = [];
  try {
    const { readdir } = await import("node:fs/promises");
    files = await readdir(stepDir);
  } catch {
    return undefined;
  }

  // Extract agent names from prompt files
  const agentNames = files
    .filter((f) => f.startsWith("prompt-") && f.endsWith(".md"))
    .map((f) => f.slice("prompt-".length, -".md".length));

  const interactions: AgentInteraction[] = [];
  for (const agent of agentNames) {
    const prompt = await tryReadText(join(stepDir, `prompt-${agent}.md`));
    const response = await tryReadText(join(stepDir, `response-${agent}.md`));
    interactions.push({ agent, prompt, response });
  }

  // Read critique and result JSON from artifacts
  const artifactsDir = join(iterationsDir, runId, "artifacts");
  const critiqueJson = await tryReadJson(
    join(artifactsDir, `critique-step-${stepId}.json`)
  );
  const resultJson = await tryReadJson(
    join(artifactsDir, `step-result-${stepId}.json`)
  );

  return { stepId, agents: interactions, critiqueJson, resultJson };
}

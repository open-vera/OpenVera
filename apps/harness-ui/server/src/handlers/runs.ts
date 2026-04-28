import type { ServerResponse } from "node:http";
import { listDirs, join } from "../lib/fs.js";
import { readRunSummary } from "../lib/reader.js";
import { json, notFound } from "../http.js";
import type { ServerContext } from "../types.js";

/** GET /api/runs — list all iterations, newest first */
export async function handleListRuns(
  ctx: ServerContext,
  res: ServerResponse
): Promise<void> {
  const runIds = await listDirs(ctx.iterationsDir, "iter-");
  const summaries = await Promise.all(
    runIds.map((id) => readRunSummary(ctx.iterationsDir, id))
  );
  const result = summaries
    .filter(Boolean)
    .sort(
      (a, b) =>
        new Date(b!.startedAt).getTime() - new Date(a!.startedAt).getTime()
    );
  json(res, result);
}

/** GET /api/runs/:runId — single run summary */
export async function handleGetRun(
  ctx: ServerContext,
  runId: string,
  res: ServerResponse
): Promise<void> {
  const summary = await readRunSummary(ctx.iterationsDir, runId);
  if (!summary) return notFound(res, `Run "${runId}" not found`);
  json(res, summary);
}

/** GET /api/runs/:runId/timeline — full raw timeline events */
export async function handleGetTimeline(
  ctx: ServerContext,
  runId: string,
  res: ServerResponse
): Promise<void> {
  const { readNdjson } = await import("../lib/fs.js");
  const timelinePath = join(ctx.iterationsDir, runId, "timeline.ndjson");
  const events = await readNdjson(timelinePath);
  if (events.length === 0) return notFound(res, `Run "${runId}" not found`);
  json(res, events);
}

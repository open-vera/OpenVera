import type { ServerResponse } from "node:http";
import { readStepDetail } from "../lib/reader.js";
import { json, notFound } from "../http.js";
import type { ServerContext } from "../types.js";

/** GET /api/runs/:runId/steps/:stepId */
export async function handleGetStep(
  ctx: ServerContext,
  runId: string,
  stepId: string,
  res: ServerResponse
): Promise<void> {
  const detail = await readStepDetail(ctx.iterationsDir, runId, stepId);
  if (!detail) return notFound(res, `Step "${stepId}" not found in run "${runId}"`);
  json(res, detail);
}

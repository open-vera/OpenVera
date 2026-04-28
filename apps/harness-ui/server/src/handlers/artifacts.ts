import type { ServerResponse } from "node:http";
import { tryReadJson, join } from "../lib/fs.js";
import { json, notFound } from "../http.js";
import type { ServerContext } from "../types.js";

/** GET /api/runs/:runId/artifacts/:artifactId */
export async function handleGetArtifact(
  ctx: ServerContext,
  runId: string,
  artifactId: string,
  res: ServerResponse
): Promise<void> {
  const artifactPath = join(
    ctx.iterationsDir,
    runId,
    "artifacts",
    `${artifactId}.json`
  );
  const data = await tryReadJson(artifactPath);
  if (data == null) {
    return notFound(res, `Artifact "${artifactId}" not found in run "${runId}"`);
  }
  json(res, data);
}

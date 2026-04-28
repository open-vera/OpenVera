import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { readBody, json, badRequest, internalError } from "../http.js";
import type { ServerContext } from "../types.js";

interface SpawnBody {
  /** Absolute or relative path to the flow project dir (containing .flow/) */
  flowDir?: string;
  model?: string;
  provider?: string;
  skipPlanCritique?: boolean;
  maxSteps?: number;
}

/**
 * POST /api/runs
 * Spawns `vera-harness flow run` as a detached child process.
 * Returns immediately with the expected runId (iter-<timestamp>).
 * Client can then open GET /api/runs/:runId/stream for live updates.
 */
export async function handleSpawnRun(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  let body: SpawnBody = {};
  try {
    const raw = await readBody(req);
    if (raw.trim()) body = JSON.parse(raw) as SpawnBody;
  } catch {
    return badRequest(res, "Invalid JSON body");
  }

  const flowDir = body.flowDir ? resolve(body.flowDir) : ctx.flowDir;

  if (!existsSync(flowDir)) {
    return badRequest(res, `flowDir not found: ${flowDir}`);
  }

  // Build args
  const args = ["flow", "run", "--dir", flowDir];
  if (body.model) args.push("--model", body.model);
  if (body.provider) args.push("--provider", body.provider);
  if (body.skipPlanCritique) args.push("--skip-plan-critique");
  if (body.maxSteps != null) args.push("--max-steps", String(body.maxSteps));

  // Predict the runId that vera-harness will use (iter-<ISO>)
  const startedAt = new Date();
  const predictedId = `iter-${startedAt.toISOString().replace(/[:.]/g, "-")}`;

  // Resolve vera-harness binary
  const harnessbin = resolve("node_modules/.bin/vera-harness");
  const cmd = existsSync(harnessbin) ? harnessbin : "vera-harness";

  const child = spawn(cmd, args, {
    cwd: resolve("."),
    stdio: "ignore",
    detached: true,
  });
  child.unref();

  child.on("error", (err) => {
    console.error("[spawn] vera-harness error:", err.message);
  });

  json(res, { runId: predictedId, startedAt: startedAt.toISOString() }, 202);
}

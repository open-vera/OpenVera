import type { IncomingMessage, ServerResponse } from "node:http";
import { handleListRuns, handleGetRun, handleGetTimeline } from "./handlers/runs.js";
import { handleGetStep } from "./handlers/steps.js";
import { handleGetArtifact } from "./handlers/artifacts.js";
import { handleStream } from "./handlers/stream.js";
import { handleListFlows } from "./handlers/flows.js";
import { handleSpawnRun } from "./handlers/spawn.js";
import { handleGetRunMemory } from "./handlers/memory.js";
import { handleGetRunCheckpoints, handleGetRunCheckpoint } from "./handlers/checkpoints.js";
import { handleGetRunSubagents } from "./handlers/subagents.js";
import { cors, notFound, internalError } from "./http.js";
import type { ServerContext } from "./types.js";

type Route =
  | { handler: "list_runs" }
  | { handler: "get_run"; runId: string }
  | { handler: "get_timeline"; runId: string }
  | { handler: "get_step"; runId: string; stepId: string }
  | { handler: "get_artifact"; runId: string; artifactId: string }
  | { handler: "stream"; runId: string }
  | { handler: "list_flows" }
  | { handler: "spawn_run" }
  | { handler: "get_run_memory"; runId: string }
  | { handler: "get_run_checkpoints"; runId: string }
  | { handler: "get_run_checkpoint"; runId: string; checkpointId: string }
  | { handler: "get_run_subagents"; runId: string };

function matchRoute(pathname: string): Route | null {
  if (pathname === "/api/runs") return { handler: "list_runs" };
  if (pathname === "/api/flows") return { handler: "list_flows" };
  if (pathname === "/api/runs" || pathname === "/api/runs/") return { handler: "list_runs" };

  const runOnly = pathname.match(/^\/api\/runs\/(iter-[^/]+)$/);
  if (runOnly) return { handler: "get_run", runId: runOnly[1]! };

  const timeline = pathname.match(/^\/api\/runs\/(iter-[^/]+)\/timeline$/);
  if (timeline) return { handler: "get_timeline", runId: timeline[1]! };

  const stream = pathname.match(/^\/api\/runs\/(iter-[^/]+)\/stream$/);
  if (stream) return { handler: "stream", runId: stream[1]! };

  const step = pathname.match(/^\/api\/runs\/(iter-[^/]+)\/steps\/([^/]+)$/);
  if (step) return { handler: "get_step", runId: step[1]!, stepId: step[2]! };

  const artifact = pathname.match(
    /^\/api\/runs\/(iter-[^/]+)\/artifacts\/([^/]+)$/
  );
  if (artifact)
    return { handler: "get_artifact", runId: artifact[1]!, artifactId: artifact[2]! };

  // Memory routes
  const memory = pathname.match(/^\/api\/runs\/(iter-[^/]+)\/memory$/);
  if (memory) return { handler: "get_run_memory", runId: memory[1]! };

  // Checkpoint routes
  const checkpoints = pathname.match(/^\/api\/runs\/(iter-[^/]+)\/checkpoints$/);
  if (checkpoints) return { handler: "get_run_checkpoints", runId: checkpoints[1]! };

  const checkpoint = pathname.match(/^\/api\/runs\/(iter-[^/]+)\/checkpoints\/([^/]+)$/);
  if (checkpoint) return { handler: "get_run_checkpoint", runId: checkpoint[1]!, checkpointId: checkpoint[2]! };

  // Subagent routes
  const subagents = pathname.match(/^\/api\/runs\/(iter-[^/]+)\/subagents$/);
  if (subagents) return { handler: "get_run_subagents", runId: subagents[1]! };

  return null;
}

export async function handleRequest(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${ctx.port}`);
  const pathname = url.pathname;
  const method = req.method ?? "GET";

  // CORS preflight
  if (method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // POST /api/runs — spawn a new run
  if (method === "POST" && pathname === "/api/runs") {
    await handleSpawnRun(ctx, req, res);
    return;
  }

  if (method !== "GET") {
    notFound(res, "Method not allowed");
    return;
  }

  const route = matchRoute(pathname);
  if (!route) {
    notFound(res);
    return;
  }

  try {
    switch (route.handler) {
      case "list_runs":
        await handleListRuns(ctx, res);
        break;
      case "get_run":
        await handleGetRun(ctx, route.runId, res);
        break;
      case "get_timeline":
        await handleGetTimeline(ctx, route.runId, res);
        break;
      case "get_step":
        await handleGetStep(ctx, route.runId, route.stepId, res);
        break;
      case "get_artifact":
        await handleGetArtifact(ctx, route.runId, route.artifactId, res);
        break;
      case "stream":
        handleStream(ctx, route.runId, req, res);
        break;
      case "list_flows":
        await handleListFlows(ctx, res);
        break;
      case "spawn_run":
        await handleSpawnRun(ctx, req, res);
        break;
      case "get_run_memory":
        await handleGetRunMemory(ctx, route.runId, res);
        break;
      case "get_run_checkpoints":
        await handleGetRunCheckpoints(ctx, route.runId, res);
        break;
      case "get_run_checkpoint":
        await handleGetRunCheckpoint(ctx, route.runId, route.checkpointId, res);
        break;
      case "get_run_subagents":
        await handleGetRunSubagents(ctx, route.runId, res);
        break;
    }
  } catch (err) {
    console.error("[router]", err);
    internalError(res, (err as Error).message);
  }
}

#!/usr/bin/env node
import express from "express";
import cors from "cors";
import { resolve } from "node:path";
import { runExecutionAction, runManagementAction, type ExecutionAction, type ManagementAction } from "./actions.js";
import { runChatCompletion } from "./chat-runtime.js";
import {
  appendAssistantMessage,
  appendMessage,
  createConversation,
  getConversation,
  listConversations,
} from "./conversation-store.js";
import { getActivityHeatmap, getHostResources, getOperationsSummary } from "./operations-store.js";
import { listMcpServers, listMcpTools } from "./mcp-runtime.js";
import { searchProjectRag } from "./rag-runtime.js";
import { streamTimelineFile } from "./timeline-stream.js";
import {
  getArtifact,
  getCheckpoint,
  getCheckpoints,
  getCostSummary,
  getMemory,
  getRun,
  getStep,
  getSubagents,
  getTimeline,
  listFlows,
  listRuns,
  resolveRunTimelinePath,
  spawnRun,
  type SpawnRunRequest,
} from "./runtime-store.js";
import { loadGatewayState, summarizeCapabilities } from "./state.js";

interface ServerArgs {
  port: number;
  roots: string[];
}

function parseArgs(argv: string[]): ServerArgs {
  const roots: string[] = [];
  let port = Number(process.env.PORT ?? 7720);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--port" && next) {
      port = Number(next);
      i++;
    } else if (arg === "--root" && next) {
      roots.push(resolve(next));
      i++;
    }
  }

  return {
    port,
    roots: roots.length > 0 ? roots : [process.cwd()],
  };
}

function printHelp(): void {
  console.log("Usage: vera-gateway-serve [options]");
  console.log("");
  console.log("Options:");
  console.log("  --port <n>       Port to listen on (default: 7720)");
  console.log("  --root <path>    Project or workspace root to discover (repeatable)");
  console.log("");
}

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  printHelp();
  process.exit(0);
}

const args = parseArgs(rawArgs);
const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/gateway/overview", (_req, res) => {
  const state = loadGatewayState(args.roots);
  res.json({
    generatedAt: state.doctor.generatedAt,
    roots: args.roots,
    projectCount: state.projects.length,
    capabilityCount: state.capabilities.length,
    capabilitySummary: summarizeCapabilities(state.capabilities),
    doctorStatus: state.doctor.status,
  });
});

app.get("/api/projects", (_req, res) => {
  res.json(loadGatewayState(args.roots).projects);
});

app.get("/api/capabilities", (req, res) => {
  const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
  const capabilities = loadGatewayState(args.roots).capabilities;
  res.json(kind ? capabilities.filter((capability) => capability.kind === kind) : capabilities);
});

app.get("/api/projects/:projectId/capabilities", (req, res) => {
  const state = loadGatewayState(args.roots);
  const project = state.projects.find((item) => item.id === req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json(state.capabilities.filter((capability) => capability.projectId === project.id));
});

app.get("/api/gateway/doctor", (_req, res) => {
  res.json(loadGatewayState(args.roots).doctor);
});

app.get("/api/runs", (req, res) => {
  const state = loadGatewayState(args.roots);
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  void listRuns(state.projects, projectId).then((runs) => res.json(runs)).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : "Failed to list runs";
    res.status(500).json({ error: message });
  });
});

app.post("/api/runs", (req, res) => {
  const state = loadGatewayState(args.roots);
  const body = (req.body ?? {}) as SpawnRunRequest & { projectId?: string };
  const project = body.projectId
    ? state.projects.find((item) => item.id === body.projectId)
    : state.projects[0];
  const root = project?.rootDir ?? args.roots[0] ?? process.cwd();
  const spawnBody: SpawnRunRequest = {
    ...body,
    flowDir: body.flowDir ?? root,
  };
  res.status(202).json(spawnRun(spawnBody, root));
});

app.get("/api/runs/:runId", (req, res) => {
  const state = loadGatewayState(args.roots);
  void getRun(state.projects, req.params.runId).then((run) => {
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json(run);
  });
});

app.get("/api/runs/:runId/timeline", (req, res) => {
  const state = loadGatewayState(args.roots);
  void getTimeline(state.projects, req.params.runId).then((timeline) => {
    if (!timeline) {
      res.status(404).json({ error: "Timeline not found" });
      return;
    }
    res.json(timeline);
  });
});

app.get("/api/runs/:runId/stream", (req, res) => {
  const state = loadGatewayState(args.roots);
  const live = req.query.live === "1" || req.query.live === "true";
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  void resolveRunTimelinePath(state.projects, req.params.runId)
    .then((located) => {
      if (!located) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: "Timeline not found" })}\n\n`);
        res.end();
        return;
      }
      const shouldLive = live || located.status === "running";
      return streamTimelineFile(located.timelinePath, res, { live: shouldLive });
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "Stream failed";
      if (!res.headersSent) {
        res.status(500).json({ error: message });
        return;
      }
      res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
      res.end();
    });
});

app.get("/api/runs/:runId/steps/:stepId", (req, res) => {
  const state = loadGatewayState(args.roots);
  void getStep(state.projects, req.params.runId, req.params.stepId).then((step) => {
    if (!step) {
      res.status(404).json({ error: "Step not found" });
      return;
    }
    res.json(step);
  });
});

app.get("/api/runs/:runId/artifacts/:artifactId", (req, res) => {
  const state = loadGatewayState(args.roots);
  void getArtifact(state.projects, req.params.runId, req.params.artifactId).then((artifact) => {
    if (artifact === undefined) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }
    res.json(artifact);
  });
});

app.get("/api/runs/:runId/memory", (req, res) => {
  const state = loadGatewayState(args.roots);
  const tier = typeof req.query.tier === "string" ? req.query.tier : undefined;
  const search = typeof req.query.search === "string" ? req.query.search : undefined;
  void getMemory(state.projects, req.params.runId, tier, search).then((memory) => {
    if (!memory) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.json(memory);
  });
});

app.get("/api/runs/:runId/checkpoints", (req, res) => {
  const state = loadGatewayState(args.roots);
  void getCheckpoints(state.projects, req.params.runId).then((checkpoints) => {
    if (!checkpoints) {
      res.status(404).json({ error: "Checkpoints not found" });
      return;
    }
    res.json(checkpoints);
  });
});

app.get("/api/runs/:runId/checkpoints/:checkpointId", (req, res) => {
  const state = loadGatewayState(args.roots);
  void getCheckpoint(state.projects, req.params.runId, req.params.checkpointId).then((checkpoint) => {
    if (!checkpoint) {
      res.status(404).json({ error: "Checkpoint not found" });
      return;
    }
    res.json(checkpoint);
  });
});

app.get("/api/runs/:runId/subagents", (req, res) => {
  const state = loadGatewayState(args.roots);
  void getSubagents(state.projects, req.params.runId).then((subagents) => {
    if (!subagents) {
      res.status(404).json({ error: "Subagents not found" });
      return;
    }
    res.json(subagents);
  });
});

app.get("/api/flows", (req, res) => {
  const state = loadGatewayState(args.roots);
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  void listFlows(state.projects, projectId).then((flows) => res.json(flows)).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : "Failed to list flows";
    res.status(500).json({ error: message });
  });
});

app.get("/api/cost", (_req, res) => {
  const state = loadGatewayState(args.roots);
  void getCostSummary(state.projects).then((cost) => res.json(cost)).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : "Failed to summarize cost";
    res.status(500).json({ error: message });
  });
});

app.get("/api/gateway/operations/summary", (_req, res) => {
  const state = loadGatewayState(args.roots);
  void listRuns(state.projects)
    .then((runs) => res.json(getOperationsSummary(state.projects, runs)))
    .catch((err: unknown) => {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to load operations summary" });
    });
});

app.get("/api/gateway/operations/resources", (_req, res) => {
  res.json(getHostResources());
});

app.get("/api/gateway/operations/activity", (_req, res) => {
  const state = loadGatewayState(args.roots);
  void listRuns(state.projects)
    .then((runs) => res.json(getActivityHeatmap(runs)))
    .catch((err: unknown) => {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to load activity heatmap" });
    });
});

app.get("/api/projects/:projectId/runs", (req, res) => {
  const state = loadGatewayState(args.roots);
  const project = state.projects.find((item) => item.id === req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  void listRuns(state.projects, project.id).then((runs) => res.json(runs)).catch((err: unknown) => {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to list project runs" });
  });
});

app.get("/api/projects/:projectId/flows", (req, res) => {
  const state = loadGatewayState(args.roots);
  const project = state.projects.find((item) => item.id === req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  void listFlows(state.projects, project.id).then((flows) => res.json(flows)).catch((err: unknown) => {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to list project flows" });
  });
});

app.get("/api/conversations", (req, res) => {
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  res.json(listConversations(projectId));
});

app.post("/api/conversations", (req, res) => {
  const body = (req.body ?? {}) as { projectId?: string; title?: string };
  if (!body.projectId) {
    res.status(400).json({ error: "projectId is required" });
    return;
  }
  const state = loadGatewayState(args.roots);
  if (!state.projects.some((project) => project.id === body.projectId)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.status(201).json(createConversation(body.projectId, body.title));
});

app.get("/api/conversations/:conversationId", (req, res) => {
  const conversation = getConversation(req.params.conversationId);
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  res.json(conversation);
});

app.post("/api/conversations/:conversationId/messages", (req, res) => {
  const body = (req.body ?? {}) as { role?: string; content?: string };
  const role = body.role === "system" ? "system" : body.role === "assistant" ? "assistant" : "user";
  const content = typeof body.content === "string" ? body.content : "";
  if (!content.trim()) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  const conversationId = req.params.conversationId;
  const existing = getConversation(conversationId);
  if (!existing) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  const state = loadGatewayState(args.roots);
  const project = state.projects.find((item) => item.id === existing.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found for conversation" });
    return;
  }

  void (async () => {
    const message = appendMessage(conversationId, role, content);
    if (!message) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    if (role === "user") {
      const prior = getConversation(conversationId)?.messages.slice(0, -1) ?? [];
      const completion = await runChatCompletion(project.rootDir, content, prior);
      appendAssistantMessage(conversationId, completion.text);
    }

    const conversation = getConversation(conversationId);
    res.status(201).json({ message, conversation, projectId: project.id });
  })().catch((err: unknown) => {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to send message" });
  });
});

app.get("/api/projects/:projectId/rag/search", (req, res) => {
  const state = loadGatewayState(args.roots);
  const project = state.projects.find((item) => item.id === req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const query = typeof req.query.q === "string" ? req.query.q : "";
  void searchProjectRag(project.rootDir, query).then((result) => res.json(result));
});

app.get("/api/projects/:projectId/mcp/servers", (req, res) => {
  const state = loadGatewayState(args.roots);
  const project = state.projects.find((item) => item.id === req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json(listMcpServers(project.rootDir));
});

app.get("/api/projects/:projectId/mcp/tools", (req, res) => {
  const state = loadGatewayState(args.roots);
  const project = state.projects.find((item) => item.id === req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json(listMcpTools(project.rootDir));
});

app.get("/api/projects/:projectId", (req, res) => {
  const state = loadGatewayState(args.roots);
  const project = state.projects.find((item) => item.id === req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  void listRuns(state.projects).then((runs) => {
    const activity = getOperationsSummary(state.projects, runs).projects.find(
      (item) => item.projectId === project.id,
    );
    res.json({
      ...project,
      capabilities: state.capabilities.filter((capability) => capability.projectId === project.id),
      activity,
    });
  });
});

app.post("/api/manage/:action", (req, res) => {
  res.status(202).json(runManagementAction(req.params.action as ManagementAction, req.body ?? {}));
});

app.post("/api/execute/:action", (req, res) => {
  const state = loadGatewayState(args.roots);
  void runExecutionAction(req.params.action as ExecutionAction, req.body ?? {}, { projects: state.projects })
    .then((result) => res.status(202).json(result))
    .catch((err: unknown) => {
      res.status(500).json({ error: err instanceof Error ? err.message : "Execution failed" });
    });
});

app.listen(args.port, () => {
  console.log(`vera-gateway-serve http://localhost:${args.port}`);
  console.log(`  roots: ${args.roots.join(", ")}`);
  console.log("");
  console.log("API:");
  console.log("  GET /api/gateway/overview");
  console.log("  GET /api/gateway/doctor");
  console.log("  GET /api/projects");
  console.log("  GET /api/capabilities");
  console.log("  GET /api/projects/:projectId/capabilities");
  console.log("  GET /api/runs");
  console.log("  GET /api/runs/:runId");
  console.log("  POST /api/runs");
  console.log("  GET /api/flows");
  console.log("  GET /api/cost");
  console.log("  GET /api/gateway/operations/summary");
  console.log("  GET /api/gateway/operations/resources");
  console.log("  GET /api/gateway/operations/activity");
  console.log("  GET /api/projects/:projectId");
  console.log("  GET /api/projects/:projectId/runs");
  console.log("  GET /api/projects/:projectId/flows");
  console.log("  GET /api/conversations");
  console.log("  POST /api/conversations");
  console.log("  POST /api/conversations/:id/messages");
  console.log("  POST /api/manage/:action");
  console.log("  POST /api/execute/:action");
});

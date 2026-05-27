import type { ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { subagentHandlerLogger as logger } from "../lib/logger.js";
import type { SubagentPoolStatus, SubagentCallTreeNode } from "../types.js";

export async function handleGetRunSubagents(
  ctx: { flowDir: string },
  runId: string,
  res: ServerResponse
): Promise<void> {
  try {
    const iterationsDir = path.join(ctx.flowDir, ".flow", "iterations", runId);
    const subagentsPath = path.join(iterationsDir, "subagents.json");

    // Check if subagents file exists
    try {
      await fs.access(subagentsPath);
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Subagent data not found" }));
      return;
    }

    // Read and parse subagents data
    const content = await fs.readFile(subagentsPath, "utf8");
    const data = JSON.parse(content);

    // Return results
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      poolStatus: data.poolStatus || { totalSlots: 0, activeAgents: 0, queuedTasks: 0 },
      callTree: data.callTree || []
    }));
  } catch (error) {
    logger.error("Failed to handle subagents request:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to fetch subagent data" }));
  }
}

export async function handleGetSubagentPoolStatus(
  ctx: { flowDir: string },
  res: ServerResponse
): Promise<void> {
  try {
    // Get all runs and their subagent status
    const iterationsDir = path.join(ctx.flowDir, ".flow", "iterations");
    const runs = await fs.readdir(iterationsDir);

    let totalSlots = 0;
    let activeAgents = 0;
    let queuedTasks = 0;

    for (const runId of runs) {
      const subagentsPath = path.join(iterationsDir, runId, "subagents.json");
      try {
        const content = await fs.readFile(subagentsPath, "utf8");
        const data = JSON.parse(content);
        if (data.poolStatus) {
          totalSlots += data.poolStatus.totalSlots || 0;
          activeAgents += data.poolStatus.activeAgents || 0;
          queuedTasks += data.poolStatus.queuedTasks || 0;
        }
      } catch {
        // Skip runs without subagents data
        continue;
      }
    }

    const status: SubagentPoolStatus = {
      totalSlots,
      activeAgents,
      queuedTasks,
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
  } catch (error) {
    logger.error("Failed to handle subagent pool status request:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to fetch subagent pool status" }));
  }
}

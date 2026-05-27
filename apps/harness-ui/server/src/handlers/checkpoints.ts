import type { ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { checkpointHandlerLogger as logger } from "../lib/logger.js";
import type { CheckpointIndex } from "../types.js";

export async function handleGetRunCheckpoints(
  ctx: { flowDir: string },
  runId: string,
  res: ServerResponse
): Promise<void> {
  try {
    const iterationsDir = path.join(ctx.flowDir, ".flow", "iterations", runId);
    const checkpointsPath = path.join(iterationsDir, "checkpoints.ndjson");

    // Check if checkpoints file exists
    try {
      await fs.access(checkpointsPath);
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Checkpoints not found" }));
      return;
    }

    // Read and parse checkpoints
    const content = await fs.readFile(checkpointsPath, "utf8");
    const lines = content.split("\n").filter(line => line.trim());
    const checkpoints: CheckpointIndex[] = [];

    for (const line of lines) {
      try {
        const checkpoint = JSON.parse(line);
        checkpoints.push(checkpoint);
      } catch (error) {
        logger.warn(`Failed to parse checkpoint entry:`, error);
      }
    }

    // Sort checkpoints by createdAt (newest first)
    checkpoints.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Return results
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(checkpoints));
  } catch (error) {
    logger.error("Failed to handle checkpoints request:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to fetch checkpoints" }));
  }
}

export async function handleGetRunCheckpoint(
  ctx: { flowDir: string },
  runId: string,
  checkpointId: string,
  res: ServerResponse
): Promise<void> {
  try {
    const iterationsDir = path.join(ctx.flowDir, ".flow", "iterations", runId);
    const checkpointsPath = path.join(iterationsDir, "checkpoints.ndjson");

    // Check if checkpoints file exists
    try {
      await fs.access(checkpointsPath);
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Checkpoints not found" }));
      return;
    }

    // Read and parse checkpoints
    const content = await fs.readFile(checkpointsPath, "utf8");
    const lines = content.split("\n").filter(line => line.trim());

    // Find the specific checkpoint
    for (const line of lines) {
      try {
        const checkpoint = JSON.parse(line);
        if (checkpoint.checkpointId === checkpointId) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(checkpoint));
          return;
        }
      } catch (error) {
        logger.warn(`Failed to parse checkpoint entry:`, error);
      }
    }

    // If not found
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Checkpoint not found" }));
  } catch (error) {
    logger.error("Failed to handle checkpoint request:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to fetch checkpoint" }));
  }
}

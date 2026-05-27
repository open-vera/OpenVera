import type { ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { memoryHandlerLogger as logger } from "../lib/logger.js";
import type { MemorySnapshot, MemoryEntryItem } from "../types.js";

export async function handleGetRunMemory(
  ctx: { flowDir: string },
  runId: string,
  res: ServerResponse,
  query?: { tier?: string; search?: string }
): Promise<void> {
  try {
    const iterationsDir = path.join(ctx.flowDir, ".flow", "iterations", runId, "memory");

    // Check if memory directory exists
    try {
      await fs.access(iterationsDir);
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Memory directory not found" }));
      return;
    }

    // Get snapshot
    const snapshotPath = path.join(iterationsDir, "snapshot.json");
    let snapshot: MemorySnapshot = { episodicCount: 0, semanticCount: 0, workingCount: 0 };

    try {
      const snapshotContent = await fs.readFile(snapshotPath, "utf8");
      snapshot = JSON.parse(snapshotContent);
    } catch (error) {
      logger.warn("Failed to read memory snapshot:", error);
    }

    // Get memory entries
    const entries: MemoryEntryItem[] = [];
    const tierFilter = query?.tier;
    const searchQuery = query?.search?.toLowerCase();

    // Read all memory files
    const files = await fs.readdir(iterationsDir);
    const memoryFiles = files.filter(f => f.endsWith(".jsonl") || f.endsWith(".ndjson"));

    for (const file of memoryFiles) {
      const tier = path.basename(file, path.extname(file)) as MemoryEntryItem["tier"];

      // Apply tier filter
      if (tierFilter && tier !== tierFilter) continue;

      const filePath = path.join(iterationsDir, file);
      const content = await fs.readFile(filePath, "utf8");
      const lines = content.split("\n").filter(line => line.trim());

      for (const line of lines) {
        try {
          const entry: MemoryEntryItem = JSON.parse(line);

          // Apply search filter
          if (searchQuery && !entry.content.toLowerCase().includes(searchQuery) && !entry.tags.some(tag => tag.toLowerCase().includes(searchQuery))) {
            continue;
          }

          entries.push(entry);
        } catch (error) {
          logger.warn(`Failed to parse memory entry in ${file}:`, error);
        }
      }
    }

    // Sort entries by createdAt (newest first)
    entries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Return results
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      snapshot,
      entries: entries.slice(0, 50), // Limit to 50 most recent entries
      total: entries.length
    }));
  } catch (error) {
    logger.error("Failed to handle memory request:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to fetch memory data" }));
  }
}

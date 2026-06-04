import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Response } from "express";
import type { TimelineEvent } from "./runtime-store.js";

const TERMINAL_TYPES = new Set(["flow_completed", "flow_failed"]);

function parseNdjsonChunk(raw: string): TimelineEvent[] {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TimelineEvent];
      } catch {
        return [];
      }
    });
}

export async function streamTimelineFile(
  timelinePath: string,
  res: Response,
  options: { live: boolean },
): Promise<void> {
  if (!existsSync(timelinePath)) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: "Timeline not found" })}\n\n`);
    res.end();
    return;
  }

  let offset = 0;
  let finished = false;

  const pushNewEvents = async (): Promise<boolean> => {
    const raw = await readFile(timelinePath, "utf8");
    if (raw.length <= offset) return false;
    const chunk = raw.slice(offset);
    offset = raw.length;
    const events = parseNdjsonChunk(chunk);
    for (const event of events) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (TERMINAL_TYPES.has(String(event.type ?? ""))) {
        finished = true;
      }
    }
    return events.length > 0;
  };

  await pushNewEvents();
  if (finished || !options.live) {
    res.write("event: done\ndata: {}\n\n");
    res.end();
    return;
  }

  const timer = setInterval(() => {
    void pushNewEvents()
      .then(() => {
        if (finished) {
          clearInterval(timer);
          res.write("event: done\ndata: {}\n\n");
          res.end();
        }
      })
      .catch((err: unknown) => {
        clearInterval(timer);
        const message = err instanceof Error ? err.message : "Stream read failed";
        res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
        res.end();
      });
  }, 1000);

  res.on("close", () => {
    clearInterval(timer);
  });
}

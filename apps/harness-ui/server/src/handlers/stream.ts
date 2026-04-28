import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFromOffset, join } from "../lib/fs.js";
import { cors } from "../http.js";
import type { ServerContext } from "../types.js";

const POLL_INTERVAL_MS = 800;
const IDLE_CLOSE_AFTER_MS = 30_000; // close SSE if no new data for 30s after flow ends

/**
 * GET /api/runs/:runId/stream
 * Server-Sent Events — streams new timeline.ndjson lines in real time.
 * Sends `data: <json>\n\n` for each new event.
 * Sends `event: done\ndata: {}\n\n` when the flow has ended.
 */
export function handleStream(
  ctx: ServerContext,
  runId: string,
  _req: IncomingMessage,
  res: ServerResponse
): void {
  const timelinePath = join(ctx.iterationsDir, runId, "timeline.ndjson");

  cors(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  let offset = 0;
  let idleSince: number | undefined;
  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    res.end();
  }

  res.on("close", close);

  const timer = setInterval(async () => {
    if (closed) return;

    if (!existsSync(timelinePath)) return;

    const { text, nextOffset } = await readFromOffset(timelinePath, offset);
    if (nextOffset > offset) {
      offset = nextOffset;
      idleSince = undefined;

      const lines = text.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as { type: string };
          res.write(`data: ${JSON.stringify(event)}\n\n`);

          // Detect terminal events
          if (
            event.type === "flow_completed" ||
            event.type === "flow_failed"
          ) {
            res.write("event: done\ndata: {}\n\n");
            // give client a moment to process, then close
            setTimeout(close, 2000);
            return;
          }
        } catch {
          // skip malformed lines
        }
      }
    } else {
      // No new data — check idle timeout
      if (idleSince === undefined) idleSince = Date.now();
      else if (Date.now() - idleSince > IDLE_CLOSE_AFTER_MS) {
        res.write("event: done\ndata: {}\n\n");
        close();
      }
    }
  }, POLL_INTERVAL_MS);
}

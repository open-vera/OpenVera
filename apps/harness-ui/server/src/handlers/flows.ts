import type { ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tryReadText, join } from "../lib/fs.js";
import { json } from "../http.js";
import type { FlowTemplate, ServerContext } from "../types.js";

/**
 * GET /api/flows
 * Scans ctx.examplesDir (or ctx.flowDir parent) for .flow/flow.md files
 * and returns them as available templates.
 */
export async function handleListFlows(
  ctx: ServerContext,
  res: ServerResponse
): Promise<void> {
  const scanDir = ctx.examplesDir;
  const templates: FlowTemplate[] = [];

  if (scanDir && existsSync(scanDir)) {
    let entries: string[] = [];
    try {
      const dirents = await readdir(scanDir, { withFileTypes: true });
      entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      // ignore
    }

    for (const entry of entries) {
      const flowMdPath = join(scanDir, entry, ".flow", "flow.md");
      const raw = await tryReadText(flowMdPath);
      if (!raw) continue;

      const nameMatch = raw.match(/^name:\s*(.+)$/m);
      const name = nameMatch?.[1]?.trim() ?? entry;
      const steps = [...raw.matchAll(/^## \d+\.\s+(.+?)\s*→/gm)].map(
        (m) => m[1]!.trim()
      );

      templates.push({
        name,
        dir: join(scanDir, entry),
        steps,
      });
    }
  }

  // Also include the current ctx.flowDir itself if it has a flow.md
  const currentFlowMd = join(ctx.flowDir, ".flow", "flow.md");
  const currentRaw = await tryReadText(currentFlowMd);
  if (currentRaw) {
    const nameMatch = currentRaw.match(/^name:\s*(.+)$/m);
    const name = nameMatch?.[1]?.trim() ?? "current";
    const steps = [...currentRaw.matchAll(/^## \d+\.\s+(.+?)\s*→/gm)].map(
      (m) => m[1]!.trim()
    );
    if (!templates.some((t) => t.dir === ctx.flowDir)) {
      templates.unshift({ name, dir: ctx.flowDir, steps });
    }
  }

  json(res, templates);
}

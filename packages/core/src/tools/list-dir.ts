// list_dir — 列出目录内容

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";
import { safePath } from "./utils/path.js";

interface ListDirArgs {
  path?: string;
}

export const listDirTool: ToolDef<ListDirArgs> = {
  name: "list_dir",
  description:
    "List the contents of a directory. Shows files and subdirectories with basic metadata.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path (relative to cwd, defaults to cwd)" },
    },
    required: [],
  },
  options: { timeoutMs: 10_000, riskLevel: "low", idempotent: true },

  async execute(args: ListDirArgs, ctx: ToolContext): Promise<ToolResult> {
    const target = args.path ?? ".";
    const check = safePath(target, ctx.cwd, ctx.allowedPaths);
    if ("error" in check) return errorResult("PATH_OUTSIDE_CWD", check.error);
    const { resolved } = check;

    let entries: string[];
    try {
      entries = readdirSync(resolved);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("ENOENT")) return errorResult("NOT_FOUND", `Directory not found: ${target}`);
      if (msg.includes("ENOTDIR")) return errorResult("UNKNOWN", `Not a directory: ${target}`);
      if (msg.includes("EACCES")) return errorResult("PERMISSION_DENIED", `Permission denied: ${target}`);
      return errorResult("UNKNOWN", msg);
    }

    entries.sort();
    const lines: string[] = [];

    for (const entry of entries) {
      const fullPath = join(resolved, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          const children = readdirSync(fullPath).length;
          lines.push(`📁 ${entry}/      (${children} ${children === 1 ? "item" : "items"})`);
        } else {
          const size = formatSize(stat.size);
          lines.push(`📄 ${entry}    ${size}`);
        }
      } catch {
        lines.push(`   ${entry}    (inaccessible)`);
      }
    }

    if (lines.length === 0) lines.push("(empty directory)");

    return {
      ok: true,
      content: `${target}\n${"─".repeat(30)}\n${lines.join("\n")}`,
      metadata: { renderHint: { type: "file-list" } },
    };
  },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

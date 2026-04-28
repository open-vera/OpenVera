// write_file — 写入/覆盖文件

import { writeFileSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";
import { safePath } from "./utils/path.js";
import { getPatchFromContents } from "../utils/diff.js";
import { checkStaleness, setFileState } from "./fileStateCache.js";

interface WriteFileArgs {
  path: string;
  content: string;
}

export const writeFileTool: ToolDef<WriteFileArgs> = {
  name: "write_file",
  description:
    "Write content to a file, creating it (and parent directories) if it does not exist. " +
    "Overwrites existing content.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file (relative to cwd)" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["path", "content"],
  },
  options: { timeoutMs: 10_000, riskLevel: "medium" },

  async execute(args: WriteFileArgs, ctx: ToolContext): Promise<ToolResult> {
    const check = safePath(args.path, ctx.cwd);
    if ("error" in check) return errorResult("PATH_OUTSIDE_CWD", check.error);
    const { resolved } = check;

    // Read existing content before overwriting (for diff + staleness tracking)
    let oldContent = "";
    try {
      oldContent = readFileSync(resolved, "utf8");
    } catch {
      // File doesn't exist yet — diff will show all lines as added
    }

    // Staleness check — reject if file was modified externally since last read
    const staleness = checkStaleness(resolved);
    if (staleness === "stale") {
      return errorResult(
        "UNKNOWN",
        `File ${args.path} was modified externally since it was last read. ` +
        `Please read it again with read_file before writing.`
      );
    }
    if (staleness === "not_read" && oldContent !== "") {
      return errorResult(
        "UNKNOWN",
        `File ${args.path} exists but has not been read in this session. ` +
        `Please read it first with read_file to confirm you have the latest content.`
      );
    }

    // Atomic write: temp file → rename
    const tmpPath = `${resolved}.vera.tmp`;
    try {
      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(tmpPath, args.content, "utf8");
      renameSync(tmpPath, resolved);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      try { unlinkSync(tmpPath); } catch { /* ignore cleanup */ }
      if (msg.includes("EACCES")) return errorResult("PERMISSION_DENIED", `Permission denied: ${args.path}`);
      return errorResult("UNKNOWN", msg);
    }

    // Update cache so follow-up edits in same session don't get false "not_read"
    setFileState(resolved, args.content);

    const hunks = getPatchFromContents({
      filePath: args.path,
      oldContent,
      newContent: args.content,
    });
    const lines = args.content.split("\n").length;

    return {
      ok: true,
      content: `Wrote ${lines} lines to ${args.path}`,
      metadata: {
        linesChanged: lines,
        renderHint: { type: "diff" },
        diff: { filePath: args.path, hunks },
      },
    };
  },
};

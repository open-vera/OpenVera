// edit_file — 精确字符串替换，输出 unified diff

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";
import { safePath } from "./utils/path.js";
import { getPatchFromContents } from "../utils/diff.js";
import { checkStaleness, setFileState } from "./fileStateCache.js";

interface EditFileArgs {
  path: string;
  old_string: string;
  new_string: string;
}

export const editFileTool: ToolDef<EditFileArgs> = {
  name: "edit_file",
  description:
    "Replace an exact string in a file with new content. " +
    "old_string must match exactly (including whitespace and indentation). " +
    "Fails if old_string is not found or appears multiple times.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file (relative to cwd)" },
      old_string: { type: "string", description: "Exact string to find and replace" },
      new_string: { type: "string", description: "Replacement string" },
    },
    required: ["path", "old_string", "new_string"],
  },
  options: { timeoutMs: 10_000, riskLevel: "medium" },

  async execute(args: EditFileArgs, ctx: ToolContext): Promise<ToolResult> {
    const check = safePath(args.path, ctx.cwd);
    if ("error" in check) return errorResult("PATH_OUTSIDE_CWD", check.error);
    const { resolved } = check;

    let original: string;
    try {
      original = readFileSync(resolved, "utf8");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("ENOENT")) return errorResult("NOT_FOUND", `File not found: ${args.path}`);
      if (msg.includes("EACCES")) return errorResult("PERMISSION_DENIED", `Permission denied: ${args.path}`);
      return errorResult("UNKNOWN", msg);
    }

    // Staleness check — reject if file was modified externally since last read
    const staleness = checkStaleness(resolved);
    if (staleness === "stale") {
      return errorResult(
        "UNKNOWN",
        `File ${args.path} was modified externally since it was last read. ` +
        `Please read it again with read_file before editing.`
      );
    }
    if (staleness === "not_read") {
      return errorResult(
        "UNKNOWN",
        `File ${args.path} has not been read in this session. ` +
        `Please read it first with read_file to confirm you have the latest content.`
      );
    }

    const occurrences = countOccurrences(original, args.old_string);
    if (occurrences === 0) {
      return errorResult("UNKNOWN", `old_string not found in ${args.path}`);
    }
    if (occurrences > 1) {
      return errorResult(
        "UNKNOWN",
        `old_string appears ${occurrences} times in ${args.path}. Provide more context to make it unique.`
      );
    }

    const updated = original.replace(args.old_string, args.new_string);

    // Atomic write: temp file → rename
    const tmpPath = `${resolved}.vera.tmp`;
    try {
      writeFileSync(tmpPath, updated, "utf8");
      renameSync(tmpPath, resolved);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult("UNKNOWN", msg);
    }

    // Update cache so follow-up edits in same session don't get false "not_read"
    setFileState(resolved, updated);

    const hunks = getPatchFromContents({
      filePath: args.path,
      oldContent: original,
      newContent: updated,
    });
    const linesChanged = Math.abs(
      args.new_string.split("\n").length - args.old_string.split("\n").length
    );

    return {
      ok: true,
      content: `Edited ${args.path}`,
      metadata: {
        linesChanged,
        renderHint: { type: "diff" },
        diff: { filePath: args.path, hunks },
      },
    };
  },
};

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(search, pos)) !== -1) {
    count++;
    pos += search.length;
  }
  return count;
}

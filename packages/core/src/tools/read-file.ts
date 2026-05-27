// read_file — 读取文件内容，支持 offset/limit

import { readFileSync, statSync } from "node:fs";
import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";
import { safePath } from "./utils/path.js";
import { truncateLines } from "./utils/truncate.js";
import { isBinaryPath, hasBinaryContent } from "./utils/binary.js";
import { setFileState } from "./fileStateCache.js";

interface ReadFileArgs {
  path: string;
  offset?: number;  // 1-based start line
  limit?: number;   // max lines to read
}

export const readFileTool: ToolDef<ReadFileArgs> = {
  name: "read_file",
  description:
    "Read the contents of a file. Use offset and limit to read a specific range of lines. " +
    "Returns file content with line numbers.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file (relative to cwd)" },
      offset: { type: "number", description: "1-based line number to start reading from" },
      limit: { type: "number", description: "Maximum number of lines to read" },
    },
    required: ["path"],
  },
  options: { timeoutMs: 10_000, riskLevel: "low", idempotent: true },

  async execute(args: ReadFileArgs, ctx: ToolContext): Promise<ToolResult> {
    const check = safePath(args.path, ctx.cwd, ctx.allowedPaths);
    if ("error" in check) {
      return errorResult("PATH_OUTSIDE_CWD", check.error);
    }
    const { resolved } = check;

    let stat;
    try {
      stat = statSync(resolved);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("ENOENT")) return errorResult("NOT_FOUND", `File not found: ${args.path}`);
      if (msg.includes("EACCES")) return errorResult("PERMISSION_DENIED", `Permission denied: ${args.path}`);
      return errorResult("UNKNOWN", msg);
    }

    if (stat.isDirectory()) {
      return errorResult(
        "UNKNOWN",
        `${args.path} is a directory. Use list_dir to inspect directory contents.`
      );
    }

    // Binary check
    if (isBinaryPath(resolved)) {
      try {
        const buf = readFileSync(resolved);
        if (hasBinaryContent(buf)) {
          return errorResult(
            "UNKNOWN",
            `File appears to be binary: ${args.path} (${buf.length} bytes)`
          );
        }
      } catch (e) {
        return errorResult("NOT_FOUND", `Cannot read file: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    let raw: string;
    try {
      raw = readFileSync(resolved, "utf8");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("ENOENT")) return errorResult("NOT_FOUND", `File not found: ${args.path}`);
      if (msg.includes("EACCES")) return errorResult("PERMISSION_DENIED", `Permission denied: ${args.path}`);
      return errorResult("UNKNOWN", msg);
    }

    const allLines = raw.split("\n");
    const totalLines = allLines.length;

    const start = Math.max(0, (args.offset ?? 1) - 1);
    const end = args.limit !== undefined ? start + args.limit : allLines.length;
    const slice = allLines.slice(start, end);

    // Add line numbers
    const numbered = slice
      .map((line, i) => {
        const lineNum = String(start + i + 1).padStart(4, " ");
        return `${lineNum}\t${line}`;
      })
      .join("\n");

    const { content, truncated } = truncateLines(numbered, 2000);
    const isPartialRead = !!(args.offset || args.limit) || truncated;
    setFileState(resolved, raw, isPartialRead);

    const rangeDesc =
      args.offset || args.limit
        ? ` (lines ${start + 1}–${Math.min(end, totalLines)} of ${totalLines})`
        : ` (${totalLines} lines)`;

    return {
      ok: true,
      content: `${args.path}${rangeDesc}\n${content}`,
      metadata: {
        bytesRead: Buffer.byteLength(raw),
        linesRead: slice.length,
        truncated,
        renderHint: { type: "code", lang: langFromPath(resolved) },
      },
    };
  },
};

function langFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    c: "c", cpp: "cpp", h: "c", cs: "csharp", php: "php",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    md: "markdown", sh: "bash", bash: "bash", zsh: "bash",
    css: "css", html: "html", xml: "xml", sql: "sql",
  };
  return map[ext] ?? "text";
}

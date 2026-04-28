// grep — 在文件中搜索

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";
import { isBinaryPath } from "./utils/binary.js";

interface GrepArgs {
  pattern: string;
  path?: string;   // file or directory (defaults to cwd)
  glob?: string;   // filter by glob pattern (e.g. "*.ts")
  case_insensitive?: boolean;
  context?: number; // lines of context around each match
}

const MAX_MATCHES = 200;

export const grepTool: ToolDef<GrepArgs> = {
  name: "grep",
  description:
    "Search for a regex pattern in files. Returns matching lines with file path and line number. " +
    "Searches recursively in directories.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression pattern to search for" },
      path: { type: "string", description: "File or directory to search (defaults to cwd)" },
      glob: { type: "string", description: "Only search files matching this glob pattern (e.g. '*.ts')" },
      case_insensitive: { type: "boolean", description: "Case-insensitive search" },
      context: { type: "number", description: "Number of context lines around each match" },
    },
    required: ["pattern"],
  },
  options: { timeoutMs: 30_000, riskLevel: "low", idempotent: true },

  async execute(args: GrepArgs, ctx: ToolContext): Promise<ToolResult> {
    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern, args.case_insensitive ? "i" : undefined);
    } catch (e) {
      return errorResult("UNKNOWN", `Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
    }

    const searchPath = args.path ? join(ctx.cwd, args.path) : ctx.cwd;
    const globPattern = args.glob;

    // Collect files to search
    let files: string[];
    try {
      const stat = statSync(searchPath);
      if (stat.isFile()) {
        files = [searchPath];
      } else {
        files = walkDir(searchPath);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("ENOENT")) return errorResult("NOT_FOUND", `Not found: ${args.path}`);
      return errorResult("UNKNOWN", msg);
    }

    // Filter by glob if given
    if (globPattern) {
      const re = globToRegex(globPattern);
      files = files.filter((f) => re.test(relative(ctx.cwd, f)));
    }

    const matches: string[] = [];
    let totalMatches = 0;
    let truncated = false;

    for (const file of files) {
      if (isBinaryPath(file)) continue;
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      const contextLines = args.context ?? 0;

      for (let i = 0; i < lines.length; i++) {
        if (!regex.test(lines[i]!)) continue;

        if (totalMatches >= MAX_MATCHES) { truncated = true; break; }

        const relPath = relative(ctx.cwd, file);
        const lineNum = i + 1;

        if (contextLines > 0) {
          const before = lines.slice(Math.max(0, i - contextLines), i).map((l, j) => `${relPath}:${lineNum - (contextLines - j)}-  ${l}`);
          const after  = lines.slice(i + 1, i + 1 + contextLines).map((l, j) => `${relPath}:${lineNum + j + 1}-  ${l}`);
          matches.push(...before, `${relPath}:${lineNum}:  ${lines[i]}`, ...after, "---");
        } else {
          matches.push(`${relPath}:${lineNum}:  ${lines[i]}`);
        }
        totalMatches++;
      }
      if (truncated) break;
    }

    if (matches.length === 0) {
      return { ok: true, content: `No matches for: ${args.pattern}` };
    }

    const suffix = truncated ? `\n[... more matches — narrow your search]` : "";
    return {
      ok: true,
      content: `${totalMatches} match(es) for "${args.pattern}":\n${matches.join("\n")}${suffix}`,
    };
  },
};

const SKIP_DIRS = new Set(["node_modules", ".git", ".vera", "dist", "build", ".next", ".turbo"]);

function walkDir(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) results.push(...walkDir(full));
        else results.push(full);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return results;
}

function globToRegex(pattern: string): RegExp {
  let re = "^";
  for (const c of pattern) {
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (".+^${}()|[]\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(re + "$");
}

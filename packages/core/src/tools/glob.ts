// glob — 文件路径匹配

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";

interface GlobArgs {
  pattern: string;
  path?: string;  // base directory (defaults to cwd)
}

export const globTool: ToolDef<GlobArgs> = {
  name: "glob",
  description:
    "Find files matching a glob pattern. Supports * (any in segment), ** (any depth), ? (single char). " +
    "Returns matching paths relative to cwd.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. '**/*.ts' or 'src/**/*.test.js'" },
      path: { type: "string", description: "Base directory to search from (defaults to cwd)" },
    },
    required: ["pattern"],
  },
  options: { timeoutMs: 15_000, riskLevel: "low", idempotent: true },

  async execute(args: GlobArgs, ctx: ToolContext): Promise<ToolResult> {
    const base = args.path ? join(ctx.cwd, args.path) : ctx.cwd;
    const pattern = args.pattern;

    let matches: string[];
    try {
      const all = walkDir(base);
      matches = all
        .filter((p) => matchGlob(pattern, relative(base, p)))
        .map((p) => relative(ctx.cwd, p))
        .sort();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("ENOENT")) return errorResult("NOT_FOUND", `Directory not found: ${args.path}`);
      return errorResult("UNKNOWN", msg);
    }

    if (matches.length === 0) {
      return { ok: true, content: `No files matching: ${pattern}`, metadata: { renderHint: { type: "file-list" } } };
    }

    const content = matches.join("\n");
    return {
      ok: true,
      content: `${matches.length} file(s) matching ${pattern}:\n${content}`,
      metadata: { renderHint: { type: "file-list" } },
    };
  },
};

// ── Simple glob matcher ───────────────────────────────────────────────────────

function matchGlob(pattern: string, path: string): boolean {
  // Normalize separators
  const p = pattern.replace(/\\/g, "/");
  const s = path.replace(/\\/g, "/");
  return globRegex(p).test(s);
}

function globRegex(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      // ** — match any path segment including /
      re += "(?:.*/?)?";
      i += 2;
      if (pattern[i] === "/") i++; // skip trailing slash
    } else if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

// ── Directory walker ──────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", ".git", ".vera", "dist", "build", ".next", ".turbo"]);

function walkDir(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...walkDir(full));
      } else {
        results.push(full);
      }
    } catch {
      // skip inaccessible
    }
  }
  return results;
}

import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export interface PathCandidateOptions {
  cwd: string;
  maxDepth?: number;
  maxEntries?: number;
  ignoredNames?: ReadonlySet<string>;
}

const DEFAULT_IGNORED_NAMES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "coverage",
  "dist",
  "build",
  "node_modules",
]);

export function scanPathCandidates(options: PathCandidateOptions): string[] {
  const cwd = resolve(options.cwd);
  const maxDepth = options.maxDepth ?? 3;
  const maxEntries = options.maxEntries ?? 800;
  const ignoredNames = options.ignoredNames ?? DEFAULT_IGNORED_NAMES;
  const candidates = new Set<string>();

  const visit = (dir: string, depth: number) => {
    if (candidates.size >= maxEntries || depth > maxDepth) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (candidates.size >= maxEntries) return;
      if (ignoredNames.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".env") continue;

      const abs = join(dir, entry.name);
      const isDirectory = entry.isDirectory() || isDirectoryByStat(abs);
      const rel = normalizePath(relative(cwd, abs));
      if (!rel || rel.startsWith("..")) continue;

      const suffix = isDirectory ? "/" : "";
      candidates.add(`./${rel}${suffix}`);
      candidates.add(`${rel}${suffix}`);
      candidates.add(`${normalizePath(abs)}${suffix}`);

      if (isDirectory && depth < maxDepth) {
        visit(abs, depth + 1);
      }
    }
  };

  visit(cwd, 1);
  return [...candidates].sort();
}

export interface PathCandidateRefreshHandle {
  cancel: () => void;
}

export function schedulePathCandidateRefresh(options: {
  cwd: string;
  scan?: typeof scanPathCandidates;
  setCandidates: (candidates: string[]) => void;
  schedule?: (fn: () => void) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (handle: ReturnType<typeof setTimeout>) => void;
}): PathCandidateRefreshHandle {
  let cancelled = false;
  const schedule = options.schedule ?? ((fn) => setTimeout(fn, 0));
  const cancelSchedule = options.cancelSchedule ?? ((handle) => clearTimeout(handle));
  const handle = schedule(() => {
    const candidates = (options.scan ?? scanPathCandidates)({ cwd: options.cwd });
    if (!cancelled) options.setCandidates(candidates);
  });
  return {
    cancel: () => {
      cancelled = true;
      cancelSchedule(handle);
    },
  };
}

function normalizePath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function isDirectoryByStat(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { StructuredPatchHunk } from "diff";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 5000;
const MAX_FILES = 50;
const MAX_DIFF_SIZE_BYTES = 1_000_000; // 1 MB
const MAX_LINES_PER_FILE = 400;
const MAX_FILES_FOR_DETAILS = 500;

export type GitDiffStats = {
  filesCount: number;
  linesAdded: number;
  linesRemoved: number;
};

export type PerFileStats = {
  added: number;
  removed: number;
  isBinary: boolean;
  isUntracked?: boolean;
};

export type GitDiffResult = {
  stats: GitDiffStats;
  perFileStats: Map<string, PerFileStats>;
  hunks: Map<string, StructuredPatchHunk[]>;
};

// ── helpers ───────────────────────────────────────────────────────────────────

async function run(
  args: string[],
  cwd: string
): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_DIFF_SIZE_BYTES * 2,
    });
    return { stdout, code: 0 };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string };
    return { stdout: e.stdout ?? "", code: e.code ?? 1 };
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const { code } = await run(
    ["rev-parse", "--is-inside-work-tree"],
    cwd
  );
  return code === 0;
}

async function getGitDir(cwd: string): Promise<string | null> {
  const { stdout, code } = await run(["rev-parse", "--git-dir"], cwd);
  if (code !== 0) return null;
  const rel = stdout.trim();
  return rel.startsWith("/") ? rel : join(cwd, rel);
}

async function isInTransientGitState(cwd: string): Promise<boolean> {
  const gitDir = await getGitDir(cwd);
  if (!gitDir) return false;
  const transientFiles = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"];
  const results = await Promise.all(
    transientFiles.map((f) =>
      access(join(gitDir, f))
        .then(() => true)
        .catch(() => false)
    )
  );
  return results.some(Boolean);
}

// ── parse functions ───────────────────────────────────────────────────────────

export type NumstatResult = {
  stats: GitDiffStats;
  perFileStats: Map<string, PerFileStats>;
};

/** Parse `git diff --numstat` output. */
export function parseGitNumstat(stdout: string): NumstatResult {
  const lines = stdout.trim().split("\n").filter(Boolean);
  let added = 0;
  let removed = 0;
  let validFileCount = 0;
  const perFileStats = new Map<string, PerFileStats>();

  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    validFileCount++;
    const addStr = parts[0];
    const remStr = parts[1];
    const filePath = parts.slice(2).join("\t");
    const isBinary = addStr === "-" || remStr === "-";
    const fileAdded = isBinary ? 0 : parseInt(addStr ?? "0", 10) || 0;
    const fileRemoved = isBinary ? 0 : parseInt(remStr ?? "0", 10) || 0;

    added += fileAdded;
    removed += fileRemoved;

    if (perFileStats.size < MAX_FILES) {
      perFileStats.set(filePath, { added: fileAdded, removed: fileRemoved, isBinary });
    }
  }

  return {
    stats: { filesCount: validFileCount, linesAdded: added, linesRemoved: removed },
    perFileStats,
  };
}

/** Parse `git diff --shortstat` output. */
export function parseShortstat(stdout: string): GitDiffStats | null {
  const match = stdout.match(
    /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/
  );
  if (!match) return null;
  return {
    filesCount: parseInt(match[1] ?? "0", 10),
    linesAdded: parseInt(match[2] ?? "0", 10),
    linesRemoved: parseInt(match[3] ?? "0", 10),
  };
}

/**
 * Parse unified diff output (`git diff HEAD`) into per-file hunks.
 * Mirrors claude-code-source's parseGitDiff with the same limits.
 */
export function parseGitDiff(stdout: string): Map<string, StructuredPatchHunk[]> {
  const result = new Map<string, StructuredPatchHunk[]>();
  if (!stdout.trim()) return result;

  const fileDiffs = stdout.split(/^diff --git /m).filter(Boolean);

  for (const fileDiff of fileDiffs) {
    if (result.size >= MAX_FILES) break;
    if (fileDiff.length > MAX_DIFF_SIZE_BYTES) continue;

    const lines = fileDiff.split("\n");
    const headerMatch = lines[0]?.match(/^a\/(.+?) b\/(.+)$/);
    if (!headerMatch) continue;
    const filePath = headerMatch[2] ?? headerMatch[1] ?? "";

    const fileHunks: StructuredPatchHunk[] = [];
    let currentHunk: StructuredPatchHunk | null = null;
    let lineCount = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] ?? "";

      const hunkMatch = line.match(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
      );
      if (hunkMatch) {
        if (currentHunk) fileHunks.push(currentHunk);
        currentHunk = {
          oldStart: parseInt(hunkMatch[1] ?? "0", 10),
          oldLines: parseInt(hunkMatch[2] ?? "1", 10),
          newStart: parseInt(hunkMatch[3] ?? "0", 10),
          newLines: parseInt(hunkMatch[4] ?? "1", 10),
          lines: [],
        };
        continue;
      }

      if (
        line.startsWith("index ") ||
        line.startsWith("---") ||
        line.startsWith("+++") ||
        line.startsWith("new file") ||
        line.startsWith("deleted file") ||
        line.startsWith("old mode") ||
        line.startsWith("new mode") ||
        line.startsWith("Binary files")
      ) {
        continue;
      }

      if (
        currentHunk &&
        (line.startsWith("+") ||
          line.startsWith("-") ||
          line.startsWith(" ") ||
          line === "")
      ) {
        if (lineCount < MAX_LINES_PER_FILE) {
          // Force flat string to avoid V8 sliced-string memory retention
          currentHunk.lines.push("" + line);
          lineCount++;
        }
      }
    }

    if (currentHunk) fileHunks.push(currentHunk);
    if (fileHunks.length > 0) result.set(filePath, fileHunks);
  }

  return result;
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Fetch git diff stats for the working tree vs HEAD.
 * Returns null if not in a git repo or in a transient state.
 * Hunks are empty — call fetchGitDiffHunks() separately when needed.
 */
export async function fetchGitDiff(cwd: string): Promise<GitDiffResult | null> {
  if (!(await isGitRepo(cwd))) return null;
  if (await isInTransientGitState(cwd)) return null;

  // Quick probe to bail early on massive diffs
  const { stdout: shortstatOut, code: shortstatCode } = await run(
    ["--no-optional-locks", "diff", "HEAD", "--shortstat"],
    cwd
  );
  if (shortstatCode === 0) {
    const quickStats = parseShortstat(shortstatOut);
    if (quickStats && quickStats.filesCount > MAX_FILES_FOR_DETAILS) {
      return { stats: quickStats, perFileStats: new Map(), hunks: new Map() };
    }
  }

  const { stdout: numstatOut, code: numstatCode } = await run(
    ["--no-optional-locks", "diff", "HEAD", "--numstat"],
    cwd
  );
  if (numstatCode !== 0) return null;

  const { stats, perFileStats } = parseGitNumstat(numstatOut);

  // Untracked files
  const remainingSlots = MAX_FILES - perFileStats.size;
  if (remainingSlots > 0) {
    const { stdout: untrackedOut, code: untrackedCode } = await run(
      ["--no-optional-locks", "ls-files", "--others", "--exclude-standard"],
      cwd
    );
    if (untrackedCode === 0 && untrackedOut.trim()) {
      const paths = untrackedOut.trim().split("\n").filter(Boolean);
      for (const p of paths.slice(0, remainingSlots)) {
        perFileStats.set(p, { added: 0, removed: 0, isBinary: false, isUntracked: true });
        stats.filesCount++;
      }
    }
  }

  return { stats, perFileStats, hunks: new Map() };
}

/**
 * Fetch diff hunks on-demand (expensive — don't call on every poll).
 */
export async function fetchGitDiffHunks(
  cwd: string
): Promise<Map<string, StructuredPatchHunk[]>> {
  if (!(await isGitRepo(cwd))) return new Map();
  if (await isInTransientGitState(cwd)) return new Map();

  const { stdout, code } = await run(
    ["--no-optional-locks", "diff", "HEAD"],
    cwd
  );
  if (code !== 0) return new Map();
  return parseGitDiff(stdout);
}

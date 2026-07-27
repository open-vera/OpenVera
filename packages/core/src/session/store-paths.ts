/**
 * Session store path helpers.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { globalDataPath } from "../config/paths.js";

// ── Path helpers ──────────────────────────────────────────────────────────────

// djb2 hash — fast, no native dependency
function hashPath(p: string): string {
  let h = 5381;
  for (let i = 0; i < p.length; i++) {
    h = ((h << 5) + h + p.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

const MAX_DIR_LEN = 80;

/**
 * Sanitize a filesystem path component for the session directory name.
 * Strategy: replace non-alnum with `-`, do NOT collapse runs (to avoid
 * collisions like /a__b and /a_b mapping to the same name).  For paths
 * that exceed MAX_DIR_LEN, append a hash suffix so uniqueness is guaranteed.
 */
export function projectSlug(p: string): string {
  const sanitized = p.replace(/[^A-Za-z0-9]/g, "-");
  if (sanitized.length <= MAX_DIR_LEN) {
    return sanitized;
  }
  // Truncate + hash suffix for long paths
  return `${sanitized.slice(0, MAX_DIR_LEN)}-${hashPath(p)}`;
}

export function projectDir(cwd: string): string {
  return join(projectsDir(), projectSlug(canonicalizePath(cwd)));
}
export function projectDirExact(cwd: string): string {
  return join(projectsDir(), projectSlug(cwd));
}
function canonicalizePath(p: string): string {
  try {
    return normalize(realpathSync(p)).normalize("NFC");
  } catch {
    return normalize(p).normalize("NFC");
  }
}

export function projectsDir(): string {
  return globalDataPath("projects");
}

export function sessionFilePath(sessionId: string, cwd: string): string {
  return join(projectDir(cwd), `${sessionId}.jsonl`);
}

export function listProjectDirs(): string[] {
  try {
    return readdirSync(projectsDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(projectsDir(), entry.name));
  } catch {
    return [];
  }
}

function gitWorktreePaths(cwd: string): string[] {
  try {
    const raw = execFileSync("git", ["-C", cwd, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return raw
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function sessionDirsFor(cwd?: string, includeWorktrees = true): string[] {
  if (!cwd) return listProjectDirs();
  const candidates = includeWorktrees ? [cwd, ...gitWorktreePaths(cwd)] : [cwd];
  return [...new Set(candidates.flatMap((candidate) => [
    projectDir(candidate),
    projectDirExact(candidate),
  ]))];
}

export function resolveSessionFilePath(sessionId: string, cwd?: string): string {
  const fileName = `${sessionId}.jsonl`;
  for (const dir of sessionDirsFor(cwd)) {
    const candidate = join(dir, fileName);
    try {
      if (statSync(candidate).size > 0) return candidate;
    } catch {
      // keep searching
    }
  }
  return cwd ? sessionFilePath(sessionId, cwd) : join(projectsDir(), fileName);
}

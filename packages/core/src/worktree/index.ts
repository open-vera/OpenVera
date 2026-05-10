import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { GitError, ValidationError } from "../errors.js";

const VALID_WORKTREE_SEGMENT = /^[a-zA-Z0-9._-]+$/;
const MAX_WORKTREE_SLUG_LENGTH = 64;

export interface BranchWorktree {
  worktreePath: string;
  worktreeBranch: string;
  baseCommit: string;
  gitRoot: string;
}

export function validateWorktreeSlug(slug: string): void {
  if (slug.length === 0 || slug.length > MAX_WORKTREE_SLUG_LENGTH) {
    throw new ValidationError(`Invalid worktree name: must be 1-${MAX_WORKTREE_SLUG_LENGTH} characters`);
  }
  for (const segment of slug.split("/")) {
    if (segment === "." || segment === ".." || !VALID_WORKTREE_SEGMENT.test(segment)) {
      throw new ValidationError(
        `Invalid worktree name "${slug}": use letters, digits, dots, underscores, dashes, and safe "/" nesting`
      );
    }
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function flattenSlug(slug: string): string {
  return slug.replaceAll("/", "+");
}

export function worktreeBranchName(slug: string): string {
  return `vera-try-${flattenSlug(slug)}`;
}

function worktreePathFor(gitRoot: string, slug: string): string {
  return join(gitRoot, ".vera", "worktrees", flattenSlug(slug));
}

export function findGitRoot(cwd: string): string | null {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]) || null;
  } catch {
    return null;
  }
}

export function createBranchWorktree(cwd: string, slug: string): BranchWorktree {
  validateWorktreeSlug(slug);
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) {
    throw new GitError("Cannot create a try worktree outside a git repository");
  }

  const baseCommit = git(gitRoot, ["rev-parse", "HEAD"]);
  const worktreePath = worktreePathFor(gitRoot, slug);
  const worktreeBranch = worktreeBranchName(slug);

  mkdirSync(join(gitRoot, ".vera", "worktrees"), { recursive: true });
  execFileSync("git", ["worktree", "add", "-B", worktreeBranch, worktreePath, "HEAD"], {
    cwd: gitRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return { worktreePath, worktreeBranch, baseCommit, gitRoot };
}

export function hasWorktreeChanges(worktreePath: string, baseCommit: string): boolean {
  try {
    const status = git(worktreePath, ["status", "--porcelain"]);
    if (status.length > 0) return true;
    const commits = git(worktreePath, ["rev-list", "--count", `${baseCommit}..HEAD`]);
    return Number.parseInt(commits || "0", 10) > 0;
  } catch {
    return true;
  }
}

export function hasGitChanges(cwd: string): boolean {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) {
    throw new GitError("Cannot inspect changes outside a git repository");
  }
  return git(gitRoot, ["status", "--porcelain", "--", ".", ":(exclude).vera/worktrees"]).length > 0;
}

export function collectWorktreeDiff(worktreePath: string, baseCommit: string): string {
  // Include untracked files in the diff without staging their content.
  execFileSync("git", ["add", "-N", "."], {
    cwd: worktreePath,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return execFileSync("git", ["diff", "--binary", baseCommit], {
    cwd: worktreePath,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function applyWorktreeDiff(targetCwd: string, diff: string): void {
  if (diff.trim().length === 0) return;
  const gitRoot = findGitRoot(targetCwd);
  if (!gitRoot) {
    throw new GitError("Cannot merge a try branch outside a git repository");
  }
  execFileSync("git", ["apply", "--3way", "--binary", "--whitespace=nowarn", "-"], {
    cwd: gitRoot,
    input: diff,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function checkWorktreeDiff(targetCwd: string, diff: string): void {
  if (diff.trim().length === 0) return;
  const gitRoot = findGitRoot(targetCwd);
  if (!gitRoot) {
    throw new GitError("Cannot merge a try branch outside a git repository");
  }
  execFileSync("git", ["apply", "--check", "--3way", "--binary", "--whitespace=nowarn", "-"], {
    cwd: gitRoot,
    input: diff,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function mergeWorktreeChanges(p: {
  worktreePath: string;
  baseCommit: string;
  targetCwd: string;
  checkOnly?: boolean;
  requireCleanTarget?: boolean;
}): { changed: boolean } {
  if (p.requireCleanTarget && hasGitChanges(p.targetCwd)) {
    throw new GitError("Target workspace has uncommitted changes; commit, stash, or clean them before merging");
  }
  const diff = collectWorktreeDiff(p.worktreePath, p.baseCommit);
  if (p.checkOnly) {
    checkWorktreeDiff(p.targetCwd, diff);
  } else {
    applyWorktreeDiff(p.targetCwd, diff);
  }
  return { changed: diff.trim().length > 0 };
}

export function removeBranchWorktree(
  gitRoot: string,
  worktreePath: string,
  worktreeBranch?: string
): void {
  execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: gitRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (worktreeBranch) {
    try {
      execFileSync("git", ["branch", "-D", worktreeBranch], {
        cwd: gitRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // The worktree branch may already be gone; removing the worktree is the important part.
    }
  }
}

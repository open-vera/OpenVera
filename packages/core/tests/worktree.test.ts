import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBranchWorktree,
  hasWorktreeChanges,
  mergeWorktreeChanges,
  removeBranchWorktree,
  worktreeBranchName,
} from "../src/worktree/index.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("worktree helpers", () => {
  let repo: string;

  beforeEach(() => {
    repo = join(tmpdir(), `vera-worktree-test-${crypto.randomUUID()}`);
    mkdirSync(repo, { recursive: true });
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test User"]);
    writeFileSync(join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "initial"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("creates, detects, merges, and removes a try worktree", () => {
    const worktree = createBranchWorktree(repo, "example");

    expect(worktree.worktreeBranch).toBe(worktreeBranchName("example"));
    expect(existsSync(worktree.worktreePath)).toBe(true);
    expect(hasWorktreeChanges(worktree.worktreePath, worktree.baseCommit)).toBe(false);

    writeFileSync(join(worktree.worktreePath, "README.md"), "hello from try\n");
    writeFileSync(join(worktree.worktreePath, "NEW.md"), "new file\n");

    expect(hasWorktreeChanges(worktree.worktreePath, worktree.baseCommit)).toBe(true);
    const result = mergeWorktreeChanges({
      worktreePath: worktree.worktreePath,
      baseCommit: worktree.baseCommit,
      targetCwd: repo,
    });

    expect(result.changed).toBe(true);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("hello from try\n");
    expect(readFileSync(join(repo, "NEW.md"), "utf8")).toBe("new file\n");

    removeBranchWorktree(repo, worktree.worktreePath, worktree.worktreeBranch);
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });

  it("checks mergeability without applying changes", () => {
    const worktree = createBranchWorktree(repo, "check-only");
    writeFileSync(join(worktree.worktreePath, "README.md"), "checked only\n");

    const result = mergeWorktreeChanges({
      worktreePath: worktree.worktreePath,
      baseCommit: worktree.baseCommit,
      targetCwd: repo,
      checkOnly: true,
      requireCleanTarget: true,
    });

    expect(result.changed).toBe(true);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("hello\n");

    removeBranchWorktree(repo, worktree.worktreePath, worktree.worktreeBranch);
  });

  it("refuses to merge into a dirty target workspace", () => {
    const worktree = createBranchWorktree(repo, "dirty-target");
    writeFileSync(join(worktree.worktreePath, "README.md"), "try change\n");
    writeFileSync(join(repo, "LOCAL.md"), "local change\n");

    expect(() =>
      mergeWorktreeChanges({
        worktreePath: worktree.worktreePath,
        baseCommit: worktree.baseCommit,
        targetCwd: repo,
        requireCleanTarget: true,
      })
    ).toThrow(/uncommitted changes/);

    rmSync(join(repo, "LOCAL.md"), { force: true });
    removeBranchWorktree(repo, worktree.worktreePath, worktree.worktreeBranch);
  });
});

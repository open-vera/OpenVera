import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeCommand } from "../src/repl/commands/merge.js";
import type { ReplContext } from "../src/repl/context.js";
import { SessionStore } from "../src/session/store.js";
import { createBranchWorktree, removeBranchWorktree } from "../src/worktree/index.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("/merge command", () => {
  let tempHome: string;
  let repo: string;
  const originalVeraHome = process.env.VERA_HOME;

  beforeEach(() => {
    tempHome = join(tmpdir(), `vera-merge-command-home-${crypto.randomUUID()}`);
    repo = join(tmpdir(), `vera-merge-command-repo-${crypto.randomUUID()}`);
    mkdirSync(tempHome, { recursive: true });
    mkdirSync(repo, { recursive: true });
    process.env.VERA_HOME = tempHome;

    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test User"]);
    writeFileSync(join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "initial"]);
  });

  afterEach(() => {
    process.env.VERA_HOME = originalVeraHome;
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createTryBranch(slug: string): { branchId: string; worktreePath: string; worktreeBranch: string } {
    const parent = new SessionStore({ cwd: repo });
    parent.writeStart("gpt-4", "openai");
    parent.writeUser("Try a route");

    const worktree = createBranchWorktree(repo, slug);
    const branch = SessionStore.forkSession({
      fromSessionId: parent.sessionId,
      cwd: repo,
      title: slug,
      worktreePath: worktree.worktreePath,
      worktreeBranch: worktree.worktreeBranch,
      baseCommit: worktree.baseCommit,
    });

    return {
      branchId: branch.sessionId,
      worktreePath: worktree.worktreePath,
      worktreeBranch: worktree.worktreeBranch,
    };
  }

  function ctxFor(branchId: string): ReplContext {
    return {
      cwd: repo,
      sessionStore: new SessionStore({ sessionId: branchId, cwd: repo }),
    } as unknown as ReplContext;
  }

  it("applies the active try branch and marks it merged", async () => {
    const branch = createTryBranch("command-merge");
    writeFileSync(join(branch.worktreePath, "README.md"), "merged\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await mergeCommand([], ctxFor(branch.branchId));

    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("merged\n");
    const summary = SessionStore.listSessions(repo).find((session) => session.sessionId === branch.branchId);
    expect(summary?.branch?.status).toBe("merged");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Merged try branch"));

    removeBranchWorktree(repo, branch.worktreePath, branch.worktreeBranch);
  });

  it("checks the active try branch without applying or marking it merged", async () => {
    const branch = createTryBranch("command-check");
    writeFileSync(join(branch.worktreePath, "README.md"), "checked\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await mergeCommand(["--check"], ctxFor(branch.branchId));

    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("hello\n");
    const summary = SessionStore.listSessions(repo).find((session) => session.sessionId === branch.branchId);
    expect(summary?.branch?.status).toBe("active");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("can be merged cleanly"));

    removeBranchWorktree(repo, branch.worktreePath, branch.worktreeBranch);
  });
});

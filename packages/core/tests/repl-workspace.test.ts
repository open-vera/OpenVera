import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveResumeWorkspace } from "../src/repl/workspace.js";
import { SessionStore } from "../src/session/store.js";

describe("resolveResumeWorkspace", () => {
  let tempHome: string;
  const originalVeraHome = process.env.VERA_HOME;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "vera-repl-workspace-test-"));
    process.env.VERA_HOME = tempHome;
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    process.env.VERA_HOME = originalVeraHome;
  });

  function makeBranch(worktreePath: string): { cwd: string; branchId: string } {
    const cwd = mkdtempSync(join(tempHome, "project-"));
    const parent = new SessionStore({ cwd });
    parent.writeStart("gpt-4", "openai");
    parent.writeUser("Try one path");
    const branch = SessionStore.forkSession({
      fromSessionId: parent.sessionId,
      cwd,
      title: "try",
      worktreePath,
      worktreeBranch: "vera-try-test",
      baseCommit: "abc123",
    });
    return { cwd, branchId: branch.sessionId };
  }

  it("resumes a try branch in its worktree when the worktree exists", () => {
    const worktreePath = mkdtempSync(join(tempHome, "worktree-"));
    const branch = makeBranch(worktreePath);
    const loaded = SessionStore.loadSession(branch.branchId, branch.cwd);

    const workspace = resolveResumeWorkspace(loaded, branch.cwd);

    expect(workspace.cwd).toBe(worktreePath);
    expect(workspace.warning).toBeUndefined();
  });

  it("falls back to the original cwd when the try worktree is missing", () => {
    const worktreePath = join(tempHome, "missing-worktree");
    const branch = makeBranch(worktreePath);
    const loaded = SessionStore.loadSession(branch.branchId, branch.cwd);

    const workspace = resolveResumeWorkspace(loaded, branch.cwd);

    expect(workspace.cwd).toBe(branch.cwd);
    expect(workspace.warning).toContain("Try branch worktree is missing");
  });

  it("keeps a normal resumed session in its recorded cwd", () => {
    const cwd = mkdtempSync(join(tempHome, "project-"));
    const store = new SessionStore({ cwd });
    store.writeStart("gpt-4", "openai");
    store.writeUser("Normal session");
    const loaded = SessionStore.loadSession(store.sessionId, cwd);

    const workspace = resolveResumeWorkspace(loaded, mkdtempSync(join(tempHome, "other-")));

    expect(workspace.cwd).toBe(cwd);
    expect(workspace.warning).toBeUndefined();
  });
});

// /try [name] — fork the current session into an isolated git worktree

import { randomUUID } from "node:crypto";
import { SessionStore } from "../../session/index.js";
import { createBranchWorktree } from "../../worktree/index.js";
import type { ReplContext } from "../context.js";

function slugify(input: string | undefined): string {
  const base = input
    ?.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return `try-${base || "experiment"}-${randomUUID().slice(0, 8)}`;
}

export async function tryCommand(
  args: string[],
  ctx: ReplContext
): Promise<void> {
  if (!ctx.onResume) {
    console.log("Try branches are not available in this context.");
    return;
  }

  const title = args.join(" ").trim() || undefined;

  try {
    const worktree = createBranchWorktree(ctx.cwd, slugify(title));
    const branch = SessionStore.forkSession({
      fromSessionId: ctx.sessionStore.sessionId,
      cwd: ctx.sessionStore.cwd,
      title: title ?? "try",
      worktreePath: worktree.worktreePath,
      worktreeBranch: worktree.worktreeBranch,
      baseCommit: worktree.baseCommit,
    });
    const loaded = SessionStore.loadSession(branch.sessionId, ctx.sessionStore.cwd);
    ctx.onResume(loaded);

    console.log(
      [
        `Started try branch ${branch.sessionId.slice(0, 8)} in an isolated worktree.`,
        `Worktree: ${worktree.worktreePath}`,
        `Git branch: ${worktree.worktreeBranch}`,
      ].join("\n")
    );
  } catch (err) {
    console.log(`Failed to start try branch: ${err instanceof Error ? err.message : String(err)}`);
  }
}

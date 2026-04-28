// /drop <branch-id-prefix> — logically discard a branch

import { SessionStore } from "../../session/index.js";
import {
  findGitRoot,
  hasWorktreeChanges,
  removeBranchWorktree,
} from "../../worktree/index.js";
import type { ReplContext } from "../context.js";

export async function dropCommand(
  args: string[],
  ctx: ReplContext
): Promise<void> {
  const prefix = args[0];
  if (!prefix) {
    console.log("Usage: /drop <branch-id-prefix>");
    return;
  }

  const matches = SessionStore.listSessions(ctx.cwd).filter(
    (session) =>
      session.branch?.status !== "discarded" &&
      session.branch !== undefined &&
      session.sessionId.startsWith(prefix)
  );

  if (matches.length === 0) {
    console.log(`No branch found with prefix "${prefix}".`);
    return;
  }
  if (matches.length > 1) {
    console.log(`Ambiguous prefix "${prefix}" — ${matches.length} branches match:`);
    matches.forEach((session) => console.log(`  ${session.sessionId.slice(0, 8)}`));
    return;
  }

  const target = matches[0]!;
  if (target.sessionId === ctx.sessionStore.sessionId) {
    console.log("Cannot drop the active session. Switch away from it first.");
    return;
  }

  try {
    SessionStore.discardBranch(target.sessionId, ctx.cwd);
    const branch = target.branch;
    if (branch?.worktreePath && branch.baseCommit) {
      const hasChanges = hasWorktreeChanges(branch.worktreePath, branch.baseCommit);
      if (!hasChanges) {
        const gitRoot = findGitRoot(ctx.cwd);
        if (gitRoot) {
          removeBranchWorktree(gitRoot, branch.worktreePath, branch.worktreeBranch);
          console.log(`Dropped branch ${target.sessionId.slice(0, 8)} and removed its clean worktree.`);
          return;
        }
      }
      console.log(
        `Dropped branch ${target.sessionId.slice(0, 8)}. Worktree kept because it has changes: ${branch.worktreePath}`
      );
      return;
    }
    console.log(`Dropped branch ${target.sessionId.slice(0, 8)}.`);
  } catch (err) {
    console.log(`Failed to drop branch: ${err instanceof Error ? err.message : String(err)}`);
  }
}

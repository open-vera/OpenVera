// /merge [branch-id-prefix] — apply a try branch's worktree diff to the original workspace

import { SessionStore } from "../../session/index.js";
import {
  findGitRoot,
  mergeWorktreeChanges,
  removeBranchWorktree,
} from "../../worktree/index.js";
import type { ReplContext } from "../context.js";

function parseMergeArgs(args: string[]): {
  prefix?: string;
  checkOnly: boolean;
  dropAfterMerge: boolean;
  error?: string;
} {
  let prefix: string | undefined;
  let checkOnly = false;
  let dropAfterMerge = false;

  for (const arg of args) {
    if (arg === "--check") {
      checkOnly = true;
    } else if (arg === "--drop") {
      dropAfterMerge = true;
    } else if (arg.startsWith("--")) {
      return { checkOnly, dropAfterMerge, error: `Unknown option: ${arg}` };
    } else if (!prefix) {
      prefix = arg;
    } else {
      return { checkOnly, dropAfterMerge, error: "Usage: /merge [--check] [--drop] [branch-id-prefix]" };
    }
  }

  return { prefix, checkOnly, dropAfterMerge };
}

export async function mergeCommand(
  args: string[],
  ctx: ReplContext
): Promise<void> {
  const parsed = parseMergeArgs(args);
  if (parsed.error) {
    console.log(parsed.error);
    return;
  }

  const { prefix, checkOnly, dropAfterMerge } = parsed;
  const sessions = SessionStore.listSessions(ctx.sessionStore.cwd);
  const matches = sessions.filter((session) => {
    if (!session.branch?.worktreePath || session.branch.status === "discarded") return false;
    if (!prefix) return session.sessionId === ctx.sessionStore.sessionId;
    return session.sessionId.startsWith(prefix);
  });

  if (matches.length === 0) {
    console.log(prefix ? `No try branch found with prefix "${prefix}".` : "Current session is not a try branch.");
    return;
  }
  if (matches.length > 1) {
    console.log(`Ambiguous prefix "${prefix}" — ${matches.length} try branches match:`);
    matches.forEach((session) => console.log(`  ${session.sessionId.slice(0, 8)}`));
    return;
  }

  const target = matches[0]!;
  const branch = target.branch!;
  if (branch.status === "merged" && !checkOnly) {
    console.log(`Try branch ${target.sessionId.slice(0, 8)} has already been merged.`);
    return;
  }
  if (!branch.baseCommit) {
    console.log(`Try branch ${target.sessionId.slice(0, 8)} has no base commit metadata.`);
    return;
  }

  try {
    const result = mergeWorktreeChanges({
      worktreePath: branch.worktreePath!,
      baseCommit: branch.baseCommit,
      targetCwd: ctx.sessionStore.cwd,
      checkOnly,
      requireCleanTarget: true,
    });

    if (checkOnly) {
      console.log(
        result.changed
          ? `Try branch ${target.sessionId.slice(0, 8)} can be merged cleanly.`
          : `Try branch ${target.sessionId.slice(0, 8)} has no file changes to merge.`
      );
      return;
    }

    SessionStore.markBranchMerged(target.sessionId, ctx.sessionStore.cwd);

    if (dropAfterMerge) {
      const gitRoot = findGitRoot(ctx.sessionStore.cwd);
      if (gitRoot) {
        removeBranchWorktree(gitRoot, branch.worktreePath!, branch.worktreeBranch);
      }
    }

    console.log(
      result.changed
        ? `Merged try branch ${target.sessionId.slice(0, 8)} into ${ctx.sessionStore.cwd}. Changes are left uncommitted.${dropAfterMerge ? " Worktree removed." : ""}`
        : `Try branch ${target.sessionId.slice(0, 8)} has no file changes to merge.`
    );
  } catch (err) {
    console.log(`Failed to merge try branch: ${err instanceof Error ? err.message : String(err)}`);
  }
}

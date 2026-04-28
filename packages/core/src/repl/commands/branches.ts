// /branches — list branches forked from the active session

import { SessionStore } from "../../session/index.js";
import type { ReplContext } from "../context.js";

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 3))}...`;
}

export async function branchesCommand(
  _args: string[],
  ctx: ReplContext
): Promise<void> {
  const current = SessionStore.listSessions(ctx.cwd).find(
    (session) => session.sessionId === ctx.sessionStore.sessionId
  );
  const parentSessionId = current?.branch?.parentSessionId ?? ctx.sessionStore.sessionId;
  const branches = SessionStore.listBranches(parentSessionId, ctx.cwd);

  if (branches.length === 0) {
    console.log("No branches found for the current session.");
    return;
  }

  console.log(`Branches for ${parentSessionId.slice(0, 8)}:`);
  branches.forEach((branch, index) => {
    const title = branch.branch?.title ?? branch.title ?? branch.summary;
    const status = branch.branch?.status ?? "active";
    const marker = branch.branch?.worktreePath ? " worktree" : "";
    console.log(
      `  ${index + 1}. ${branch.sessionId.slice(0, 8)}  ${formatDate(branch.startedAt)}  ` +
        `${status.padEnd(9)}  ${branch.turnCount} turns${marker}  ${truncate(title, 48)}`
    );
  });
  console.log("\nUse /merge <branch-id-prefix> to apply a try branch, or /switch to inspect it.");
}

// /branch [name] — fork the current session and continue in the branch

import { SessionStore } from "../../session/index.js";
import type { ReplContext } from "../context.js";

export async function branchCommand(
  args: string[],
  ctx: ReplContext
): Promise<void> {
  if (!ctx.onResume) {
    console.log("Branching is not available in this context.");
    return;
  }

  const title = args.join(" ").trim() || undefined;

  try {
    const branch = SessionStore.forkSession({
      fromSessionId: ctx.sessionStore.sessionId,
      cwd: ctx.cwd,
      title,
    });
    const loaded = SessionStore.loadSession(branch.sessionId, ctx.cwd);
    ctx.onResume(loaded);

    console.log(
      `Branched to ${branch.sessionId.slice(0, 8)} from ${branch.parentSessionId.slice(0, 8)}.` +
        (title ? ` Title: ${title}` : "")
    );
  } catch (err) {
    console.log(`Failed to branch session: ${err instanceof Error ? err.message : String(err)}`);
  }
}

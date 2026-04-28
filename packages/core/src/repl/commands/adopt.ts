// /adopt <branch-id-prefix> — mark a branch as adopted and continue in it

import { SessionStore } from "../../session/index.js";
import type { ReplContext } from "../context.js";

export async function adoptCommand(
  args: string[],
  ctx: ReplContext
): Promise<void> {
  const prefix = args[0];
  if (!prefix) {
    console.log("Usage: /adopt <branch-id-prefix>");
    return;
  }
  if (!ctx.onResume) {
    console.log("Adopting branches is not available in this context.");
    return;
  }

  const matches = SessionStore.listSessions(ctx.cwd).filter(
    (session) =>
      session.branch !== undefined &&
      session.branch.status !== "discarded" &&
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
  try {
    SessionStore.adoptBranch(target.sessionId, ctx.cwd);
    const loaded = SessionStore.loadSession(target.sessionId, ctx.cwd);
    ctx.onResume(loaded);
    console.log(
      `Adopted branch ${target.sessionId.slice(0, 8)} — continuing from this route.`
    );
  } catch (err) {
    console.log(`Failed to adopt branch: ${err instanceof Error ? err.message : String(err)}`);
  }
}

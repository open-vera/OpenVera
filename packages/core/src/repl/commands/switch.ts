// /switch <session-id-prefix> — switch the active REPL session

import { SessionStore } from "../../session/index.js";
import type { ReplContext } from "../context.js";

export async function switchCommand(
  args: string[],
  ctx: ReplContext
): Promise<void> {
  const prefix = args[0];
  if (!prefix) {
    console.log("Usage: /switch <session-id-prefix>");
    return;
  }
  if (!ctx.onResume) {
    console.log("Switching sessions is not available in this context.");
    return;
  }

  const matches = SessionStore.listSessions(ctx.cwd).filter((session) =>
    session.sessionId.startsWith(prefix)
  );

  if (matches.length === 0) {
    console.log(`No session found with prefix "${prefix}".`);
    return;
  }
  if (matches.length > 1) {
    console.log(`Ambiguous prefix "${prefix}" — ${matches.length} sessions match:`);
    matches.forEach((session) => console.log(`  ${session.sessionId.slice(0, 8)}  ${session.model}`));
    return;
  }

  const target = matches[0]!;
  try {
    const loaded = SessionStore.loadSession(target.sessionId, ctx.cwd);
    ctx.onResume(loaded);
    console.log(
      `Switched to session ${target.sessionId.slice(0, 8)} — ` +
        `${loaded.turnCount} turns, $${loaded.totalCostUsd.toFixed(4)} spent.`
    );
  } catch (err) {
    console.log(`Failed to switch session: ${err instanceof Error ? err.message : String(err)}`);
  }
}

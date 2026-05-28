// /resume [id-prefix] — 在当前 session 内恢复历史对话

import { SessionStore } from "../../session/index.js";
import type { ReplContext } from "../context.js";
import { debugLog } from "../debugLog.js";

export async function resumeCommand(
  args: string[],
  ctx: ReplContext
): Promise<void> {
  const prefix = args[0];
  debugLog(`[resumeCommand] args=${JSON.stringify(args)} prefix=${prefix ?? "(none)"} onShowSessionPicker=${!!ctx.onShowSessionPicker} onResume=${!!ctx.onResume}`);
  if (!prefix) {
    // No prefix: open interactive session picker if available
    if (ctx.onShowSessionPicker) {
      debugLog("[resumeCommand] → calling onShowSessionPicker (will dispatch overlay open)");
      ctx.onShowSessionPicker();
      debugLog("[resumeCommand] ← onShowSessionPicker returned, returning null output");
      return;
    }
    // Fallback: list sessions as hint
    const sessions = SessionStore.listSessions(ctx.cwd);
    if (sessions.length === 0) {
      console.log("No sessions found. Nothing to resume.");
      return;
    }
    console.log("Usage: /resume <session-id-prefix>");
    console.log("\nAvailable sessions:");
    sessions.slice(0, 10).forEach((s, i) => {
      const date = s.startedAt.toISOString().slice(0, 10);
      console.log(`  ${i + 1}. ${s.sessionId.slice(0, 8)}  ${date}  ${s.model}  (${s.turnCount} turns)`);
    });
    return;
  }

  const sessions = SessionStore.listSessions(ctx.cwd);
  const matches = sessions.filter((s) => s.sessionId.startsWith(prefix));

  if (matches.length === 0) {
    console.log(`No session found with prefix "${prefix}".`);
    return;
  }
  if (matches.length > 1) {
    console.log(`Ambiguous prefix "${prefix}" — ${matches.length} sessions match:`);
    matches.forEach((s) => console.log(`  ${s.sessionId.slice(0, 8)}  ${s.model}`));
    return;
  }

  const target = matches[0]!;
  try {
    debugLog(`[resumeCommand] loading session ${target.sessionId} from disk`);
    const loaded = SessionStore.loadSession(target.sessionId, ctx.cwd);
    debugLog(`[resumeCommand] loaded: turns=${loaded.turnCount} history=${loaded.history.length} cost=${loaded.totalCostUsd.toFixed(4)}`);
    if (!ctx.onResume) {
      console.log("Resume is not available in this context.");
      return;
    }
    debugLog("[resumeCommand] → calling onResume");
    ctx.onResume(loaded);
    debugLog("[resumeCommand] ← onResume returned");
    console.log(
      `Resumed session ${target.sessionId.slice(0, 8)} — ` +
      `${loaded.turnCount} turns, $${loaded.totalCostUsd.toFixed(4)} spent.`
    );
  } catch (err) {
    console.log(`Failed to load session: ${err instanceof Error ? err.message : String(err)}`);
  }
}

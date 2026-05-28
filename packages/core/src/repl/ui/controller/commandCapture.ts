import { handleCommand } from "../../commands/index.js";
import type { ReplContext } from "../../context.js";
import { debugLog } from "../../debugLog.js";

/**
 * Run a REPL command and capture its console output.
 *
 * Returns the captured text, or `null` when the command produced no output
 * (e.g. it opened an interactive overlay like the session picker).
 */
export async function captureCommandOutput(
  cmd: string,
  args: string[],
  ctx: ReplContext,
  handleCommandImpl = handleCommand,
): Promise<string | null> {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  const t0 = Date.now();
  debugLog(`[captureCommandOutput] /${cmd} — intercepting console, calling handleCommand`);
  try {
    await handleCommandImpl(cmd, args, ctx);
    debugLog(`[captureCommandOutput] /${cmd} — handleCommand returned (${Date.now() - t0}ms), captured ${lines.length} line(s)`);
  } catch (err) {
    debugLog(`[captureCommandOutput] /${cmd} — handleCommand threw: ${err}`);
    throw err;
  } finally {
    console.log = origLog;
    console.error = origErr;
    debugLog(`[captureCommandOutput] /${cmd} — console restored`);
  }
  const output = lines.join("\n");
  if (output) {
    debugLog(`[captureCommandOutput] /${cmd} → returning ${output.length} chars of captured output`);
  } else {
    debugLog(`[captureCommandOutput] /${cmd} → returning null (no output, overlay likely opened)`);
  }
  return output || null;
}

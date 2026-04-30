import { handleCommand } from "../../commands/index.js";
import type { ReplContext } from "../../context.js";

export async function captureCommandOutput(
  cmd: string,
  args: string[],
  ctx: ReplContext,
  handleCommandImpl = handleCommand,
): Promise<string> {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    await handleCommandImpl(cmd, args, ctx);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return lines.join("\n") || `Unknown command: /${cmd}`;
}

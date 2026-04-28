// /title <name> — 给当前 session 设置标题

import type { ReplContext } from "../context.js";

export async function titleCommand(
  args: string[],
  ctx: ReplContext
): Promise<void> {
  const title = args.join(" ").trim();
  if (!title) {
    console.log("Usage: /title <session title>");
    return;
  }
  ctx.sessionStore.writeTitle(title);
  console.log(`Session title set: ${title}`);
}

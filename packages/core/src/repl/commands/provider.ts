import type { ReplContext } from "../context.js";

export async function providerCommand(
  _args: string[],
  ctx: ReplContext
): Promise<void> {
  const providers = ctx.config.providers ?? {};
  const names = Object.keys(providers);
  if (names.length === 0) {
    console.log("No providers configured.");
    return;
  }
  console.log();
  for (const name of names) {
    const p = providers[name];
    const active = name === ctx.config.default_provider ? " ◀ default" : "";
    const url = p.base_url ? `  ${p.base_url}` : "";
    console.log(`  ${name}  [${p.adapter}]${url}${active}`);
  }
  console.log();
}

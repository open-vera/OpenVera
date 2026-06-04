import type { ReplContext } from "../context.js";
import { writeConfig } from "../../config/loader.js";
import { resolveDefaultModelAliasForProvider, resolveDefaultTarget } from "../../config/model-tiers.js";

export async function providerCommand(
  args: string[],
  ctx: ReplContext
): Promise<void> {
  const providers = ctx.config.providers ?? {};
  const names = Object.keys(providers);

  if (args.length === 0) {
    // No-args is intercepted by commandSubmission to show interactive overlay.
    // This fallback is for programmatic use.
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
    return;
  }

  const name = args[0]!;
  if (!providers[name]) {
    console.log(`Unknown provider: ${name}`);
    console.log(`Available: ${names.join(", ")}`);
    return;
  }

  ctx.config.default_provider = name;
  if (!ctx.config.routing?.enabled) {
    const alias = resolveDefaultModelAliasForProvider(ctx.config, name);
    if (alias) ctx.config.default_model = alias;
  }
  const target = resolveDefaultTarget(ctx.config);
  ctx.model = target.model;
  ctx.adapter = ctx.buildAdapter(name, ctx.model);

  try {
    writeConfig(ctx.config, undefined, ctx.cwd);
  } catch {
    // Non-fatal: config persists in memory for the session even if file write fails
  }

  if (ctx.onSwitchProvider) {
    ctx.onSwitchProvider(name, ctx.model);
  }

  console.log(`Switched to ${name} [${providers[name].adapter}]  model: ${ctx.model}`);
}

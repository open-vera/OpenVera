import { AdapterError } from "../../errors.js";
import type { ReplContext } from "../context.js";

export async function modelCommand(
  args: string[],
  ctx: ReplContext
): Promise<void> {
  const providerNames =
    args.length > 0 ? args : Object.keys(ctx.config.providers ?? {});

  if (providerNames.length === 0) {
    console.log("No providers configured in settings.json.");
    return;
  }

  const results = await Promise.allSettled(
    providerNames.map(async (name) => {
      const adapter = ctx.buildAdapter(name);
      if (!adapter.listModels) {
        throw new AdapterError("ADAPTER_NO_LISTMODELS", "listModels not supported for this adapter");
      }
      const models = await adapter.listModels();
      return { name, models };
    })
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const name = providerNames[i];
    console.log(`\n── ${name} ──`);
    if (result.status === "rejected") {
      console.log(`  error: ${(result.reason as Error).message}`);
      continue;
    }
    const { models } = result.value;
    if (models.length === 0) {
      console.log("  (no models returned)");
      continue;
    }
    for (const m of models) {
      const label =
        m.display_name && m.display_name !== m.id ? ` (${m.display_name})` : "";
      const ctx_str = m.context_window
        ? `  [${Math.round(m.context_window / 1000)}K ctx]`
        : "";
      console.log(`  ${m.id}${label}${ctx_str}`);
    }
  }
  console.log();
}

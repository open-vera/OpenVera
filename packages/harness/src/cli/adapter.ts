import { loadConfig, resolveDefaultTarget, resolveProviderModelConfig } from "@open-vera/core/config";
import { envVarFor, LlmService, resolveEnvKey } from "@open-vera/core/adapters";
import type { LLMAdapter } from "@open-vera/core/adapters";

export function buildCliAdapter(
  providerArg?: string,
  apiKeyArg?: string,
  cwd?: string,
): { adapter: LLMAdapter; model: string } {
  const config = loadConfig(undefined, cwd);
  const defaultTarget = resolveDefaultTarget(config);
  const target = providerArg
    ? { provider: providerArg, model: defaultTarget.model }
    : defaultTarget;
  const providerName = target.provider;
  const pc = resolveProviderModelConfig(config, target);
  const apiKey = apiKeyArg ?? pc.api_key ?? resolveEnvKey(pc.adapter, providerName);

  if (!apiKey) {
    const configured = Object.entries(config.providers ?? {})
      .filter(([, p]) => p.api_key)
      .map(([n]) => n);
    const hint =
      configured.length > 0
        ? `\n  Providers with keys configured: ${configured.join(", ")}\n` +
          `  Use  /provider  in the REPL to switch, or edit .vera/settings.json\n` +
          `  and change "default_provider" to one of: ${configured.join(", ")}\n`
        : `\n  To configure, either:\n` +
          `    1. Run  openvera init\n` +
          `    2. Set  ${envVarFor(pc.adapter)}=<key>  environment variable\n` +
          `    3. Add  "api_key": "<key>"  to .vera/settings.json\n`;
    console.error(
      `Error: No API key for provider "${providerName}".\n` + hint
    );
    process.exit(1);
  }

  const service = new LlmService({ config, apiKeyOverride: apiKey });
  const selected = service.selectAdapter({ provider: providerName, model: target.model, purpose: "chat" });
  return {
    adapter: service.buildAdapter(selected.provider, selected.model),
    model: selected.model,
  };
}

import { loadConfig } from "@open-vera/core/config";
import { AnthropicAdapter, OpenAIAdapter, GeminiAdapter } from "@open-vera/core/adapters";
import type { LLMAdapter } from "@open-vera/core/adapters";

function resolveEnvKey(adapter: string, name: string): string | undefined {
  switch (adapter) {
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "gemini":
      return process.env.GEMINI_API_KEY;
    default:
      return process.env.ANTHROPIC_API_KEY ?? process.env[`${name.toUpperCase()}_API_KEY`];
  }
}

function envVarFor(adapter: string): string {
  switch (adapter) {
    case "openai": return "OPENAI_API_KEY";
    case "gemini": return "GEMINI_API_KEY";
    default: return "ANTHROPIC_API_KEY";
  }
}

export function buildCliAdapter(
  providerArg?: string,
  apiKeyArg?: string
): { adapter: LLMAdapter; model: string } {
  const config = loadConfig();
  const providerName = providerArg ?? config.default_provider ?? "anthropic";
  const pc = config.providers?.[providerName] ?? { adapter: "anthropic" as const };
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
          `    1. Run  openvera  again (first-time setup wizard)\n` +
          `    2. Set  ${envVarFor(pc.adapter)}=<key>  environment variable\n` +
          `    3. Add  "api_key": "<key>"  to .vera/settings.json\n`;
    console.error(
      `Error: No API key for provider "${providerName}".\n` + hint
    );
    process.exit(1);
  }

  let adapter: LLMAdapter;
  switch (pc.adapter) {
    case "openai":
      adapter = new OpenAIAdapter(apiKey, pc.base_url);
      break;
    case "gemini":
      adapter = new GeminiAdapter(apiKey);
      break;
    default:
      adapter = new AnthropicAdapter(apiKey, pc.base_url);
  }

  const model = config.default_model ?? "claude-opus-4-6";
  return { adapter, model };
}

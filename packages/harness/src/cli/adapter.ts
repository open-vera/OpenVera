import { loadConfig } from "@vera/core/config";
import { AnthropicAdapter, OpenAIAdapter, GeminiAdapter } from "@vera/core/adapters";
import type { LLMAdapter } from "@vera/core/adapters";

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
    console.error(
      `Error: No API key for provider "${providerName}".\n` +
      `  Set ${envVarFor(pc.adapter)}=<key>  or add to .vera/settings.json`
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

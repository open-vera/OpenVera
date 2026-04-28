import { loadConfig } from "./config/index.js";
import { AnthropicAdapter } from "./adapters/anthropic.js";
import { OpenAIAdapter } from "./adapters/openai.js";
import { GeminiAdapter } from "./adapters/gemini.js";
import type { LLMAdapter } from "./adapters/base.js";
import type { ProviderConfig } from "./config/types.js";
import { resolveModel } from "./intent/classifier.js";
import { startRepl } from "./repl/index.js";
import { SessionStore } from "./session/index.js";
import { createToolRegistry } from "./tools/index.js";
import { PromptStore, loadTemplates } from "./prompt/index.js";
export { MemoryTracker } from "./memory/index.js";
export type {
  MemoryFile,
  MemoryType,
  MemoryHitStats,
  UsageDetectionResult,
} from "./memory/index.js";
import type { Tool } from "./types/index.js";

const config = loadConfig();

export function buildAdapter(providerName?: string): LLMAdapter {
  const name = providerName ?? config.default_provider ?? "anthropic";
  const pc: ProviderConfig = config.providers?.[name] ?? { adapter: "anthropic" };
  const apiKey = pc.api_key || resolveEnvKey(pc.adapter, name);

  // No early exit — let the adapter fail naturally on first API call so the
  // Ink UI can display the error in context rather than crashing at startup.
  switch (pc.adapter) {
    case "openai":
      return new OpenAIAdapter(apiKey, pc.base_url);
    case "gemini":
      return new GeminiAdapter(apiKey);
    case "anthropic":
    default:
      return new AnthropicAdapter(apiKey, pc.base_url);
  }
}

function resolveEnvKey(adapter: string, name: string): string | undefined {
  switch (adapter) {
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "gemini":
      return process.env.GEMINI_API_KEY;
    default:
      return (
        process.env.ANTHROPIC_API_KEY ??
        process.env[`${name.toUpperCase()}_API_KEY`]
      );
  }
}

function envVarForAdapter(adapter: string, _name: string): string {
  switch (adapter) {
    case "openai":
      return "OPENAI_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
    default:
      return "ANTHROPIC_API_KEY";
  }
}

const tools: Tool[] = [];

const defaultProvider = config.default_provider ?? "anthropic";
const defaultModel = config.default_model ?? "claude-opus-4-6";

let adapter = buildAdapter(defaultProvider);
let model = defaultModel;

// Prompt management
const promptStore = new PromptStore();
const promptsDir = process.env.VERA_CONFIG_DIR
  ? `${process.env.VERA_CONFIG_DIR}/prompts`
  : undefined;
if (promptsDir) {
  const loaded = loadTemplates(promptStore, promptsDir);
  if (loaded > 0) {
    console.error(`[prompt] loaded ${loaded} templates/profiles from ${promptsDir}`);
  }
}

// Intent routing: classify first message if enabled (REPL will re-route per turn later)
if (config.routing?.enabled) {
  const classifierTarget = config.routing.classifier;
  const classifierAdapter = classifierTarget
    ? buildAdapter(classifierTarget.provider)
    : adapter;
  const classifierModel = classifierTarget?.model ?? "claude-haiku-4-5";

  // For REPL mode we skip pre-classification at startup; routing happens per turn
  // Single-shot mode (argv[2]) still benefits from routing
  const singleShot = process.argv[2];
  if (singleShot) {
    const {
      model: routed,
      intent,
      provider: routedProvider,
    } = await resolveModel(
      singleShot,
      classifierAdapter,
      classifierModel,
      config.routing,
      defaultProvider,
      defaultModel
    );
    if (routedProvider) adapter = buildAdapter(routedProvider);
    model = routed;
    if (intent) {
      console.error(
        `[intent] L${intent.level} | domain=${intent.domain} | provider=${routedProvider} | model=${model}`
      );
    }
  }
}

// Single-shot mode when argument is provided
if (process.argv[2]) {
  const { streamAgent } = await import("./agent/loop.js");
  const cwd = process.cwd();
  const sessionStore = new SessionStore({ cwd });
  const { registry } = createToolRegistry({ cwd, sessionStore });
  const resolved = promptStore.resolve({ domain: "chat", level: 0, needs_tools: true });
  const system = resolved?.system ?? "You are Vera, a helpful assistant.";
  const answer = await streamAgent(
    process.argv[2],
    {
      adapter,
      model,
      tools: registry.getSchemas(),
      system,
      onToolCall: (name, args) =>
        registry.execute(name, args as Record<string, unknown>, { cwd, sessionId: sessionStore.sessionId })
          .then((r) => r.content),
    },
    (delta) => process.stdout.write(delta)
  );
  process.stdout.write("\n");
  console.error(`\n[done] ${answer.length} chars | profile=${resolved?.profileId ?? "none"}`);
} else {
  // REPL mode
  // Parse --resume <sessionId> flag
  const resumeIdx = process.argv.indexOf("--resume");
  const resumeSessionId = resumeIdx !== -1 ? process.argv[resumeIdx + 1] : undefined;

  const cwd = process.cwd();
  const sessionStore = new SessionStore({ cwd });
  const { registry } = createToolRegistry({ cwd, sessionStore });
  await startRepl({ config, adapter, model, tools: registry.getSchemas(), buildAdapter, sessionStore, registry, promptStore }, resumeSessionId);
}

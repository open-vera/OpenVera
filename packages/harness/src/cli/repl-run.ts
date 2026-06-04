import { resolve, join } from "node:path";
import { execSync } from "node:child_process";
import { startRepl } from "@open-vera/core/repl";
import { SessionStore } from "@open-vera/core/session";
import { createToolRegistry } from "@open-vera/core/tools";
import { PromptStore } from "@open-vera/core/prompt";
import { AnthropicAdapter, OpenAIAdapter, GeminiAdapter } from "@open-vera/core/adapters";
import type { LLMAdapter } from "@open-vera/core/adapters";
import { globalVeraDir, loadConfig, isConfigEmpty, projectResourcePath, runSetupWizard } from "@open-vera/core/config";
import type { ProviderConfig } from "@open-vera/core/config";
import { createSkillResolver, RegistryToolProvider } from "../skill/index.js";
import { buildCliAdapter } from "./adapter.js";
import { createHarnessPlanExecutor } from "./repl-plan-executor.js";

export interface ReplRunArgs {
  dir?: string;
  model?: string;
  provider?: string;
  apiKey?: string;
  resume?: string;
}

function findGitRoot(): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

export async function runReplCommand(args: ReplRunArgs): Promise<void> {
  const cwd = resolve(args.dir ?? findGitRoot() ?? ".");

  let config = loadConfig(undefined, cwd);

  // ── First-run setup wizard ─────────────────────────────────────────────
  // When config is empty (no API key) and stdin is a TTY, launch the
  // interactive setup wizard so the user can get started without manually
  // editing config files.
  if (isConfigEmpty(config) && process.stdin.isTTY) {
    const selectedProvider = await runSetupWizard(cwd);
    if (selectedProvider) {
      config = loadConfig(undefined, cwd); // Reload the freshly-written config
    } else {
      process.exit(1);
    }
  }

  const { adapter, model: defaultModel } = buildCliAdapter(
    args.provider ?? config.default_provider,
    args.apiKey,
    cwd,
  );
  const model = args.model ?? defaultModel;

  const sessionStore = new SessionStore({ cwd });
  const { registry: toolRegistry, security } = createToolRegistry({ cwd });
  const toolProvider = new RegistryToolProvider(toolRegistry, cwd, sessionStore.sessionId);
  const promptStore = new PromptStore();

  const userSkillsDir = join(globalVeraDir(), "skills");
  const projectSkillsDir = projectResourcePath(cwd, "skills");
  const skillResolver = createSkillResolver(toolProvider, userSkillsDir, projectSkillsDir);

  function buildAdapter(providerName: string): LLMAdapter {
    const pc: ProviderConfig = config.providers?.[providerName] ?? { adapter: "anthropic" };
    const apiKey = pc.api_key ??
      (pc.adapter === "openai" ? process.env.OPENAI_API_KEY :
       pc.adapter === "gemini" ? process.env.GEMINI_API_KEY :
       process.env.ANTHROPIC_API_KEY);
    switch (pc.adapter) {
      case "openai": return new OpenAIAdapter(apiKey, pc.base_url);
      case "gemini": return new GeminiAdapter(apiKey);
      default: return new AnthropicAdapter(apiKey, pc.base_url);
    }
  }

  await startRepl(
    {
      cwd,
      config,
      adapter,
      model,
      tools: toolRegistry.getSchemas(),
      buildAdapter,
      sessionStore,
      registry: toolRegistry,
      promptStore,
      security,
      resolveSkillBundle: (intent) => {
        const resolved = promptStore.resolve({
          domain: intent.domain as import("../skill/types.js").IntentDomain,
          level: intent.level as 0 | 1 | 2 | 3,
          needs_tools: intent.needs_tools,
        });
        const baseSystem = resolved?.system ?? "You are Vera, a helpful assistant.";
        return skillResolver.resolve(
          { domain: intent.domain as import("../skill/types.js").IntentDomain, level: intent.level as 0|1|2|3, needs_tools: intent.needs_tools },
          baseSystem
        );
      },
      planExecutor: createHarnessPlanExecutor(adapter, model),
    },
    args.resume
  );
  process.exit(0);
}

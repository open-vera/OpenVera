import { loadConfig } from "./config/index.js";
import { isConfigEmpty, runSetupWizard } from "./config/setup.js";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
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
import { getModelContextLimit } from "./context/index.js";
import { loadNestedProjectContext, loadProjectContext } from "./project-context/index.js";
import {
  SUBAGENT_TOOL_NAME,
  buildSubagentToolSchema,
  loadAgentDefinitions,
  runSubagentTool,
} from "./agent/subagent.js";
export { MemoryTracker } from "./memory/index.js";
export * from "./project-context/index.js";
export type {
  MemoryFile,
  MemoryType,
  MemoryHitStats,
  UsageDetectionResult,
} from "./memory/index.js";
export { PlannerError } from "./errors.js";
export * from "./storage/index.js";
export * from "./rag/index.js";
export * from "./channel/index.js";
export * from "./sandbox/index.js";
export * from "./skill-evolution/index.js";

let config = loadConfig();

// ── First-run setup wizard ───────────────────────────────────────────────────
// When config is empty (no API key) and stdin is a TTY, launch the interactive
// setup wizard so the user can get started without manually editing config files.
if (isConfigEmpty(config) && process.stdin.isTTY) {
  const selectedProvider = await runSetupWizard(process.cwd());
  if (selectedProvider) {
    config = loadConfig(); // Reload the freshly-written config
  }
}

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
  const { registry, security } = createToolRegistry({ cwd, sessionStore });
  const agentDefinitions = loadAgentDefinitions({ cwd });

  const promptCliConfirm = async (message: string): Promise<boolean> => {
    if (!process.stdin.isTTY) return false;
    process.stderr.write(`\n⚠ ${message}\nAllow? [y/N] `);
    return new Promise<boolean>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      rl.question("", (answer) => { rl.close(); resolve(answer.trim().toLowerCase() === "y"); });
    });
  };

  const executeToolWithConfirm = async (name: string, args: Record<string, unknown>) => {
    const result = await registry.execute(name, args, { cwd, sessionId: sessionStore.sessionId });
    if (result.needsConfirm) {
      const approved = await promptCliConfirm(result.needsConfirm.message);
      if (approved) {
        security.allowPath(result.needsConfirm.allowDir);
        return registry.execute(result.needsConfirm.retry.name, result.needsConfirm.retry.args, { cwd, sessionId: sessionStore.sessionId });
      }
    }
    return result;
  };
  const tools = [...registry.getSchemas(), buildSubagentToolSchema(agentDefinitions)];
  const resolved = promptStore.resolve({ domain: "chat", level: 0, needs_tools: true });
  const projectContext = loadProjectContext({ cwd });
  const loadedVeraContextPaths = new Set(projectContext.files.map((file) => file.path));
  const system = [resolved?.system ?? "You are Vera, a helpful assistant.", projectContext.system]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
  const runDir = dirname(sessionStore.filePath);
  const modelContextLimit = getModelContextLimit(model);
  const answer = await streamAgent(
    process.argv[2],
    {
      adapter,
      model,
      tools,
      system,
      runDir,
      compressionOptions: {
        enabled: true,
        triggerTokens: Math.floor(modelContextLimit * 0.78),
        keepRecentTurns: 6,
        model,
      },
      microCompactOptions: {
        enabled: true,
        gapThresholdMinutes: 60,
        keepRecent: 5,
      },
      onToolCall: async (name, args) => {
        const parsedArgs = args as Record<string, unknown>;
        if (name === SUBAGENT_TOOL_NAME) {
          const result = await runSubagentTool({
            args: parsedArgs,
            adapter,
            model,
            tools,
            system,
            runDir,
            cwd,
            parentSessionId: sessionStore.sessionId,
            onToolCall: async (childName, childArgs) => {
              const childResult = await executeToolWithConfirm(childName, childArgs as Record<string, unknown>);
              return childResult.content;
            },
            definitions: agentDefinitions,
          });
          return result.content;
        }
        const result = await executeToolWithConfirm(name, parsedArgs);
        if (result.ok && name === "read_file" && typeof parsedArgs.path === "string") {
          const nested = loadNestedProjectContext({
            cwd,
            targetPath: parsedArgs.path,
            loadedPaths: loadedVeraContextPaths,
          });
          if (nested.system) {
            for (const file of nested.files) loadedVeraContextPaths.add(file.path);
            return [
              result.content,
              `<nested-vera-context>\n${nested.system}\n</nested-vera-context>`,
            ].join("\n\n");
          }
        }
        return result.content;
      },
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
  const { registry } = createToolRegistry({ cwd });
  await startRepl({
    cwd,
    config,
    adapter,
    model,
    tools: registry.getSchemas(),
    buildAdapter,
    sessionStore,
    registry,
    promptStore,
    createToolRegistry,
  }, resumeSessionId);
}

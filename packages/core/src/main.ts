#!/usr/bin/env node
// Executable entry for the core dev CLI (`tsx src/main.ts`).
//
// IMPORTANT: This file has top-level side effects (config load, setup wizard,
// intent routing, single-shot agent run, REPL launch). It must NOT be imported
// as a library. The library entry is `index.ts`, which is side-effect free.
import { loadConfig, syncExternalResources } from "./config/index.js";
import {
  resolveClassifierTarget,
  resolveDefaultTarget,
  resolveRoutingConfig,
} from "./config/model-tiers.js";
import { isConfigEmpty, runSetupWizard } from "./config/setup.js";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { LLMAdapter } from "./adapters/base.js";
import { LlmService, type LlmPurpose } from "./adapters/llm-service.js";
import { resolveModel } from "./intent/classifier.js";
import { startRepl } from "./repl/index.js";
import { SessionStore } from "./session/index.js";
import { createToolRegistry } from "./tools/index.js";
import { PromptStore, loadTemplates } from "./prompt/index.js";
import { ContextComposer, PromptComposer } from "./composer/index.js";
import { getModelContextLimit } from "./context/index.js";
import { loadNestedProjectContext } from "./project-context/index.js";
import {
  SUBAGENT_TOOL_NAME,
  buildSubagentToolSchema,
  loadAgentDefinitions,
  runSubagentTool,
} from "./agent/subagent.js";
import { createLogger } from "@open-vera/logger";

const log = createLogger("core");

// Crash prevention: log unhandled errors with full context
process.on("uncaughtException", (err) => {
  log.error("uncaughtException — crashing", { error: err.message, stack: err.stack, name: err.name });
  process.stderr.write(`\nFATAL: ${err.message}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", { reason: String(reason) });
  process.stderr.write(`\nFATAL: Unhandled rejection: ${String(reason)}\n`);
  process.exit(1);
});

let config = loadConfig();
let llmService = new LlmService({ config });

// ── First-run setup wizard ───────────────────────────────────────────────────
// When config is empty (no API key) and stdin is a TTY, launch the interactive
// setup wizard so the user can get started without manually editing config files.
if (isConfigEmpty(config) && process.stdin.isTTY) {
  syncExternalResources();
  const selectedProvider = await runSetupWizard(process.cwd());
  if (selectedProvider) {
    config = loadConfig(); // Reload the freshly-written config
    llmService = new LlmService({ config });
  }
}

function buildAdapter(providerName?: string, modelName?: string, purpose: LlmPurpose = "chat"): LLMAdapter {
  return llmService.buildAdapter(providerName, modelName, { purpose });
}

const defaultTarget = resolveDefaultTarget(config);
const defaultProvider = defaultTarget.provider;
const defaultModel = defaultTarget.model;

let adapter = buildAdapter(defaultProvider, defaultModel);
let model = defaultModel;

// Prompt management
const promptStore = new PromptStore();
const promptsDir = process.env.VERA_CONFIG_DIR
  ? `${process.env.VERA_CONFIG_DIR}/prompts`
  : undefined;
if (promptsDir) {
  const loaded = loadTemplates(promptStore, promptsDir);
  if (loaded > 0) {
    log.info(`[prompt] loaded ${loaded} templates/profiles from ${promptsDir}`);
  }
}

// Intent routing: classify first message if enabled (REPL will re-route per turn later)
const routingConfig = resolveRoutingConfig(config);
if (routingConfig?.enabled) {
  try {
    const classifierTarget = resolveClassifierTarget(config, defaultTarget);
    const classifierAdapter = buildAdapter(classifierTarget.provider, classifierTarget.model, "routing");
    const classifierModel = classifierTarget.model;

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
        routingConfig,
        defaultProvider,
        defaultModel
      );
      if (routedProvider) adapter = buildAdapter(routedProvider, routed, "chat");
      model = routed;
      if (intent) {
        log.info(
          `[intent] L${intent.level} | domain=${intent.domain} | provider=${routedProvider} | model=${model}`
        );
      }
    }
  } catch (err) {
    log.warn(`[intent] routing failed: ${err instanceof Error ? err.message : String(err)} — using default`);
  }
}

// Single-shot mode when argument is provided
if (process.argv[2]) {
  try {
    const { streamAgent } = await import("./agent/loop.js");
  const cwd = process.cwd();
  const sessionStore = new SessionStore({ cwd });
  const { toolHost, security, loadPlugins } = createToolRegistry({
    cwd,
    sessionStore,
    llmService,
    defaultModel: model,
  });
  const pluginTools = await loadPlugins();
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
    const result = await toolHost.execute(name, args, { cwd, sessionId: sessionStore.sessionId });
    if (result.needsConfirm) {
      const approved = await promptCliConfirm(result.needsConfirm.message);
      if (approved) {
        security.allowPath(result.needsConfirm.allowDir);
        return toolHost.execute(result.needsConfirm.retry.name, result.needsConfirm.retry.args, { cwd, sessionId: sessionStore.sessionId });
      }
    }
    return result;
  };
  const tools = [...toolHost.getSchemas(), buildSubagentToolSchema(agentDefinitions)];
  const promptComposer = new PromptComposer({
    promptStore,
    eventBus: toolHost.eventBus,
    capabilities: pluginTools.pluginHost.capabilities,
  });
  const contextComposer = new ContextComposer({
    eventBus: toolHost.eventBus,
    capabilities: pluginTools.pluginHost.capabilities,
  });
  const composedPrompt = await promptComposer.compose({
    intent: { domain: "chat", level: 0, needs_tools: true },
    sessionId: sessionStore.sessionId,
  });
  const composedContext = await contextComposer.compose({
    cwd,
    sessionId: sessionStore.sessionId,
  });
  const loadedVeraContextPaths = new Set(composedContext.projectContext?.files.map((file) => file.path) ?? []);
  const system = [composedPrompt.system, composedContext.system]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
  const runDir = dirname(sessionStore.filePath);
  const modelContextLimit = getModelContextLimit(model);
  const compactConfig = config.session?.compact;
  const answer = await streamAgent(
    process.argv[2],
    {
      adapter,
      model,
      eventBus: toolHost.eventBus,
      sessionId: sessionStore.sessionId,
      llmService,
      compressionProvider: compactConfig?.provider,
      tools,
      system,
      runDir,
      compressionOptions: {
        enabled: compactConfig?.enabled !== false,
        triggerTokens: Math.floor(modelContextLimit * 0.78),
        keepRecentTurns: 6,
        model: compactConfig?.model ?? model,
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
            eventBus: toolHost.eventBus,
            llmService,
            traceId: `subagent:${String(parsedArgs.subagent_type ?? parsedArgs.subagentType ?? "general-purpose")}`,
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
  log.info(`[done] ${answer.length} chars | profile=${composedPrompt.rendered?.profileId ?? "none"}`);
  } catch (err) {
    log.error("single-shot execution failed", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    process.stderr.write(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
} else {
  // REPL mode
  // Parse --resume <sessionId> flag
  const resumeIdx = process.argv.indexOf("--resume");
  const resumeSessionId = resumeIdx !== -1 ? process.argv[resumeIdx + 1] : undefined;

  const cwd = process.cwd();
  const sessionStore = new SessionStore({ cwd });
  const { registry, toolHost, loadPlugins } = createToolRegistry({
    cwd,
    llmService,
    defaultModel: model,
  });
  await loadPlugins();
  await startRepl({
    cwd,
    config,
    adapter,
    llmService,
    model,
    tools: toolHost.getSchemas(),
    buildAdapter: (providerName, modelName, options) => buildAdapter(providerName, modelName, options?.purpose ?? "chat"),
    sessionStore,
    registry,
    toolHost,
    promptStore,
    createToolRegistry: (opts) => createToolRegistry({
      ...opts,
      llmService,
      defaultModel: model,
    }),
  }, resumeSessionId);
}

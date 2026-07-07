import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  envVarFor,
  LlmService,
  resolveEnvKey,
  type LLMAdapter,
} from "@open-vera/core/adapters";
import { loadConfig, resolveConfigLocation } from "@open-vera/core/config";
import {
  resolveClassifierTarget,
  resolveDefaultTarget,
  resolveProviderModelConfig,
  resolveRoutingConfig,
} from "@open-vera/core/config";
import type { VeraConfig } from "@open-vera/core/config";
import type { PlanEvent } from "@open-vera/core/plan";
import type { Message, Usage } from "@open-vera/core/types";
import { createToolRegistry, type ToolHost, type ToolResult } from "@open-vera/core/tools";
import { runInteractiveTurn } from "@open-vera/openvera";
import type { AgentRunParams, PartnerLlmConfig, StreamEvent } from "./protocol.js";
import { writeEvent } from "./protocol.js";

const SYSTEM_PROMPT =
  "You are Partner, a helpful AI assistant running on the user's desktop. " +
  "Answer in the user's language. Use tools when they help complete the task.";

type ToolBridge = (
  callId: string,
  name: string,
  args: Record<string, unknown>,
) => Promise<string>;

interface LlmEnvironment {
  adapter: LLMAdapter;
  model: string;
  service: LlmService;
  provider: string;
}

interface PartnerToolRuntime {
  toolHost: ToolHost;
  tools: import("@open-vera/core/types").Tool[];
}

interface SessionState {
  abortController: AbortController | null;
}

interface RuntimeConfigSummary {
  source: "partner-settings" | "vera-config";
  provider: string;
  adapter: string;
  model: string;
  apiBaseUrl: string;
  apiKeySource: "partner-settings" | "vera-config" | "environment" | "missing";
  configPath?: string;
}

const sessions = new Map<string, SessionState>();

function appendRunLog(
  projectRoot: string,
  record: Record<string, unknown>,
): void {
  try {
    const dir = join(projectRoot, ".vera", "partner-runs");
    mkdirSync(dir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    appendFileSync(
      join(dir, `${date}.jsonl`),
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`,
      "utf-8",
    );
  } catch (error) {
    process.stderr.write(`[partner-sidecar] failed to write run log: ${String(error)}\n`);
  }
}

function previewText(value: unknown, limit = 500): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function buildAdapter(
  projectRoot: string,
  llmConfig?: PartnerLlmConfig,
): LlmEnvironment | undefined {
  if (llmConfig?.apiKey && llmConfig.model) {
    const adapter = adapterTypeForProtocol(llmConfig.protocol);
    const provider = llmConfig.provider || "partner";
    const config: VeraConfig = {
      providers: {
        [provider]: {
          adapter,
          api_key: llmConfig.apiKey,
          ...(llmConfig.apiBaseUrl ? { base_url: llmConfig.apiBaseUrl } : {}),
        },
      },
      models: {
        [llmConfig.model]: {
          provider,
          model: llmConfig.model,
        },
      },
      default_provider: provider,
      default_model: llmConfig.model,
    };
    const service = new LlmService({ config, apiKeyOverride: llmConfig.apiKey });
    return {
      adapter: service.buildAdapter(provider, llmConfig.model),
      model: llmConfig.model,
      service,
      provider,
    };
  }

  const config = loadConfig(undefined, projectRoot);
  const service = new LlmService({ config });
  const selected = service.selectAdapter({ purpose: "chat" });
  const providerConfig = config.providers?.[selected.provider];
  const apiKey =
    providerConfig?.api_key ?? resolveEnvKey(selected.adapterType, selected.provider);
  if (!apiKey) return undefined;
  return {
    adapter: service.buildAdapter(selected.provider, selected.model),
    model: selected.model,
    service,
    provider: selected.provider,
  };
}

async function createPartnerToolRuntime(
  projectRoot: string,
  llm: LlmEnvironment,
): Promise<PartnerToolRuntime> {
  const { toolHost, loadPlugins } = createToolRegistry({
    cwd: projectRoot,
    llmService: llm.service,
    defaultModel: llm.model,
    security: {
      workdir: projectRoot,
    },
  });
  await loadPlugins();
  return {
    toolHost,
    tools: toolHost.getSchemas(),
  };
}

function formatToolResult(result: ToolResult): string {
  if (result.ok) return result.content;
  const reason = result.error?.message ?? result.content;
  return `Tool failed: ${reason}\n\n${result.content}`;
}

function resolvePartnerClassifier(
  projectRoot: string,
  llm: LlmEnvironment,
): { adapter: LLMAdapter; model: string } {
  const config = loadConfig(undefined, projectRoot);
  const routing = resolveRoutingConfig(config);
  if (routing?.enabled) {
    const classifierTarget = resolveClassifierTarget(config, resolveDefaultTarget(config));
    return {
      adapter: llm.service.buildAdapter(
        classifierTarget.provider,
        classifierTarget.model,
        { purpose: "routing" },
      ),
      model: classifierTarget.model,
    };
  }

  return { adapter: llm.adapter, model: llm.model };
}

function runtimeConfigSummary(
  projectRoot: string,
  llmConfig?: PartnerLlmConfig,
): RuntimeConfigSummary {
  if (llmConfig?.apiKey && llmConfig.model) {
    return {
      source: "partner-settings",
      provider: llmConfig.provider || "partner",
      adapter: adapterTypeForProtocol(llmConfig.protocol),
      model: llmConfig.model,
      apiBaseUrl: llmConfig.apiBaseUrl,
      apiKeySource: "partner-settings",
    };
  }

  const configLocation = resolveConfigLocation(undefined, projectRoot);
  const config = loadConfig(undefined, projectRoot);
  const target = resolveDefaultTarget(config);
  const providerConfig = resolveProviderModelConfig(config, target);
  const envKey = resolveEnvKey(providerConfig.adapter, target.provider);
  return {
    source: "vera-config",
    provider: target.provider,
    adapter: providerConfig.adapter,
    model: target.model,
    apiBaseUrl: providerConfig.base_url ?? "",
    apiKeySource: providerConfig.api_key
      ? "vera-config"
      : envKey
        ? "environment"
        : "missing",
    configPath: configLocation.path,
  };
}

function formatModelError(error: unknown, summary: RuntimeConfigSummary): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  if (
    raw.includes("403") &&
    lower.includes("api key scenario mismatch")
  ) {
    return [
      "模型服务拒绝了当前请求：API Key 与所选模型/协议场景不匹配。",
      "",
      `当前运行配置：provider=${summary.provider}, adapter=${summary.adapter}, model=${summary.model}`,
      `API Base：${summary.apiBaseUrl || "默认端点"}`,
      `API Key 来源：${summary.apiKeySource}`,
      summary.configPath ? `配置文件：${summary.configPath}` : "",
      "",
      "请在设置里确认：",
      "1. API Key 是否属于当前 provider/API Base。",
      "2. 协议是否匹配服务类型，例如 Anthropic 官方用 Anthropic，OpenAI 兼容网关用 OpenAI Compatible。",
      "3. 模型 ID 是否是这个 Key 有权限调用的模型。",
      "",
      `原始错误：${raw}`,
    ].filter(Boolean).join("\n");
  }
  if (lower.includes("cache_control") && lower.includes("maximum of 4")) {
    return [
      "模型请求参数不合法：Anthropic 最多允许 4 个 cache_control 块。",
      "",
      "Partner 已限制后续请求的缓存块数量；请重试本次消息。",
      "",
      `当前运行配置：provider=${summary.provider}, adapter=${summary.adapter}, model=${summary.model}`,
      `API Base：${summary.apiBaseUrl || "默认端点"}`,
      "",
      `原始错误：${raw}`,
    ].join("\n");
  }
  return raw;
}

export function inspectEffectiveLlmConfig(
  projectRoot: string,
  llmConfig?: PartnerLlmConfig,
  revealSecrets = false,
): Record<string, unknown> {
  const resolvedRoot = resolveAgentProjectRoot(projectRoot);
  if (llmConfig?.apiKey && llmConfig.model) {
    return {
      source: "partner-settings",
      sourceLabel: "Partner settings keychain",
      projectRoot: resolvedRoot,
      provider: llmConfig.provider,
      adapter: adapterTypeForProtocol(llmConfig.protocol),
      protocol: llmConfig.protocol,
      model: llmConfig.model,
      apiBaseUrl: llmConfig.apiBaseUrl,
      apiKeyAvailable: true,
      apiKeySource: "partner-keychain",
      apiKeySourceLabel: "Partner keychain",
      configPath: null,
      configExists: false,
      ...(revealSecrets ? { apiKeyValue: llmConfig.apiKey } : {}),
    };
  }

  const configLocation = resolveConfigLocation(undefined, resolvedRoot);
  const config = loadConfigForInspection(configLocation.path, configLocation.exists);
  const target = resolveDefaultTarget(config);
  const providerConfig = resolveProviderModelConfig(config, target);
  const configuredKey = Boolean(providerConfig.api_key);
  const envKeyName = envVarFor(providerConfig.adapter, target.provider);
  const envKeyAvailable = Boolean(resolveEnvKey(providerConfig.adapter, target.provider));

  return {
    source: configLocation.exists ? "vera-config" : envKeyAvailable ? "environment" : "missing",
    sourceLabel: configLocation.exists ? "Vera config" : envKeyAvailable ? "Environment" : "Not configured",
    projectRoot: resolvedRoot,
    provider: target.provider,
    adapter: providerConfig.adapter,
    protocol: providerConfig.adapter,
    model: target.model,
    apiBaseUrl: providerConfig.base_url ?? "",
    apiKeyAvailable: configuredKey || envKeyAvailable,
    apiKeySource: configuredKey ? "vera-config" : envKeyAvailable ? "environment" : "missing",
    apiKeySourceLabel: configuredKey ? "Vera config api_key" : envKeyAvailable ? envKeyName : "Not found",
    ...(revealSecrets && configuredKey ? { apiKeyValue: providerConfig.api_key } : {}),
    ...(revealSecrets && !configuredKey && envKeyAvailable
      ? { apiKeyValue: resolveEnvKey(providerConfig.adapter, target.provider) }
      : {}),
    envKeyName,
    configPath: configLocation.path,
    configScope: configLocation.scope,
    configExists: configLocation.exists,
  };
}

function loadConfigForInspection(path: string, exists: boolean): VeraConfig {
  if (!exists) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as VeraConfig;
}

function adapterTypeForProtocol(protocol: string): "anthropic" | "openai" | "gemini" {
  if (protocol === "openai-compatible") return "openai";
  if (protocol === "gemini") return "gemini";
  return "anthropic";
}

function resolveAgentProjectRoot(projectRoot: string): string {
  return resolve(projectRoot);
}

function hasLlmCredentials(projectRoot: string, llmConfig?: PartnerLlmConfig): boolean {
  if (llmConfig?.apiKey) return true;
  const { exists } = resolveConfigLocation(undefined, projectRoot);
  if (exists) return true;
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.GEMINI_API_KEY,
  );
}

function ensureSession(sessionId: string): SessionState {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const created: SessionState = { abortController: null };
  sessions.set(sessionId, created);
  return created;
}

export async function handleAgentRun(
  requestId: string,
  params: AgentRunParams,
  _bridgeTool: ToolBridge,
): Promise<void> {
  const { sessionId, instanceId, message, history = [], projectRoot, llmConfig } = params;
  const resolvedRoot = resolveAgentProjectRoot(projectRoot);
  const runtimeSummary = runtimeConfigSummary(resolvedRoot, llmConfig);
  appendRunLog(resolvedRoot, {
    requestId,
    sessionId,
    instanceId,
    event: "run_start",
    messagePreview: previewText(message, 240),
    historyLength: history.length,
    runtimeConfig: runtimeSummary,
  });
  if (!hasLlmCredentials(resolvedRoot, llmConfig)) {
    appendRunLog(resolvedRoot, {
      requestId,
      sessionId,
      instanceId,
      event: "missing_llm_config",
    });
    writeEvent({
      id: requestId,
      type: "error",
      data: {
        instanceId,
        message:
          "未配置 LLM：请在项目 `.vera/settings.json`、全局 `~/.vera/settings.json` 或环境变量中设置 API Key。",
      },
    });
    return;
  }

  const built = buildAdapter(resolvedRoot, llmConfig);
  if (!built) {
    appendRunLog(resolvedRoot, {
      requestId,
      sessionId,
      instanceId,
      event: "missing_api_key",
    });
    writeEvent({
      id: requestId,
      type: "error",
      data: { instanceId, message: "未找到可用 API Key，无法调用 LLM。" },
    });
    return;
  }
  appendRunLog(resolvedRoot, {
    requestId,
    sessionId,
    instanceId,
    event: "adapter_ready",
    model: built.model,
    runtimeConfig: runtimeSummary,
  });
  const toolRuntime = await createPartnerToolRuntime(resolvedRoot, built);
  appendRunLog(resolvedRoot, {
    requestId,
    sessionId,
    instanceId,
    event: "tool_runtime_ready",
    toolCount: toolRuntime.tools.length,
    tools: toolRuntime.tools.map((tool) => tool.name),
  });

  const session = ensureSession(sessionId);
  session.abortController?.abort();
  const abortController = new AbortController();
  session.abortController = abortController;

  writeEvent({ id: requestId, type: "ready", data: { instanceId } });
  appendRunLog(resolvedRoot, {
    requestId,
    sessionId,
    instanceId,
    event: "stream_ready",
  });

  let usage: Usage | undefined;
  let firstDeltaLogged = false;
  try {
    let finalText = "";
    let harnessError: string | undefined;

    const onUsage = (value: Usage) => {
      usage = value;
      appendRunLog(resolvedRoot, {
        requestId,
        sessionId,
        instanceId,
        event: "usage",
        usage: value,
      });
      writeEvent({
        id: requestId,
        type: "usage",
        data: { instanceId, usage: value },
      });
    };

    const executeToolCall = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<ToolResult> => {
      const callId = randomUUID();
      const toolInput = {
        ...args,
        projectRoot: resolvedRoot,
      };
      appendRunLog(resolvedRoot, {
        requestId,
        sessionId,
        instanceId,
        event: "tool_call",
        callId,
        toolName: name,
        input: toolInput,
      });
      writeEvent({
        id: requestId,
        type: "tool_call",
        data: {
          instanceId,
          callId,
          name,
          input: toolInput,
          handledBySidecar: true,
        },
      });
      const toolResult = await toolRuntime.toolHost.execute(name, toolInput, {
        cwd: resolvedRoot,
        sessionId,
        signal: abortController.signal,
        llmService: built.service,
        defaultModel: built.model,
      });
      const output = formatToolResult(toolResult);
      appendRunLog(resolvedRoot, {
        requestId,
        sessionId,
        instanceId,
        event: "tool_result",
        callId,
        toolName: name,
        isError: !toolResult.ok,
        outputPreview: previewText(output),
      });
      writeEvent({
        id: requestId,
        type: "tool_result",
        data: {
          instanceId,
          callId,
          output,
          isError: !toolResult.ok,
        },
      });
      return toolResult;
    };

    const onHarnessEvent = (event: PlanEvent) => {
      switch (event.type) {
        case "plan_ready":
          appendRunLog(resolvedRoot, {
            requestId,
            sessionId,
            instanceId,
            event: "harness_plan_ready",
            steps: event.steps,
          });
          break;
        case "step_start":
          appendRunLog(resolvedRoot, {
            requestId,
            sessionId,
            instanceId,
            event: "harness_step_start",
            stepIndex: event.stepIndex,
            total: event.total,
          });
          break;
        case "step_text":
          finalText += event.delta;
          if (!firstDeltaLogged) {
            firstDeltaLogged = true;
            appendRunLog(resolvedRoot, {
              requestId,
              sessionId,
              instanceId,
              event: "first_delta",
              deltaPreview: previewText(event.delta, 120),
            });
          }
          writeEvent({
            id: requestId,
            type: "delta",
            data: { instanceId, text: event.delta },
          });
          break;
        case "step_tool":
          appendRunLog(resolvedRoot, {
            requestId,
            sessionId,
            instanceId,
            event: "harness_step_tool",
            toolName: event.name,
            isError: !event.result.ok,
            outputPreview: previewText(formatToolResult(event.result)),
          });
          break;
        case "step_done":
          appendRunLog(resolvedRoot, {
            requestId,
            sessionId,
            instanceId,
            event: "harness_step_done",
            stepIndex: event.stepIndex,
            textLength: event.output.length,
          });
          break;
        case "plan_done":
          appendRunLog(resolvedRoot, {
            requestId,
            sessionId,
            instanceId,
            event: "harness_plan_done",
          });
          break;
        case "plan_error":
          harnessError = event.error;
          break;
      }
    };

    const turnResult = await runInteractiveTurn({
      message,
      adapter: built.adapter,
      model: built.model,
      history: history as Message[],
      tools: toolRuntime.tools,
      maxTurns: 12,
      system: SYSTEM_PROMPT,
      signal: abortController.signal,
      llmService: built.service,
      compressionProvider: built.provider,
      classifier: resolvePartnerClassifier(resolvedRoot, built),
      onUsage,
      onToolCall: executeToolCall,
      onPlanEvent: onHarnessEvent,
      onRouting: ({ intent, executionMode }) => {
        appendRunLog(resolvedRoot, {
          requestId,
          sessionId,
          instanceId,
          event: "intent_classified",
          intent,
          executionMode,
        });
      },
      onDelta: (delta) => {
        if (!firstDeltaLogged) {
          firstDeltaLogged = true;
          appendRunLog(resolvedRoot, {
            requestId,
            sessionId,
            instanceId,
            event: "first_delta",
            deltaPreview: previewText(delta, 120),
          });
        }
        writeEvent({
          id: requestId,
          type: "delta",
          data: { instanceId, text: delta },
        });
      },
    });

    finalText = turnResult.text;
    if (harnessError) {
      throw new Error(harnessError);
    }

    appendRunLog(resolvedRoot, {
      requestId,
      sessionId,
      instanceId,
      event: "done",
      textLength: finalText.length,
      usage,
    });
    writeEvent({
      id: requestId,
      type: "done",
      data: { instanceId, text: finalText, usage },
    });
  } catch (err) {
    if (abortController.signal.aborted) {
      appendRunLog(resolvedRoot, {
        requestId,
        sessionId,
        instanceId,
        event: "aborted",
        usage,
      });
      writeEvent({
        id: requestId,
        type: "done",
        data: { instanceId, text: "", usage },
      });
      return;
    }
    const messageText = formatModelError(err, runtimeSummary);
    appendRunLog(resolvedRoot, {
      requestId,
      sessionId,
      instanceId,
      event: "error",
      message: messageText,
    });
    writeEvent({ id: requestId, type: "error", data: { instanceId, message: messageText } });
  } finally {
    if (session.abortController === abortController) {
      session.abortController = null;
    }
  }
}

export function handleAgentAbort(params: { sessionId: string }): void {
  const session = sessions.get(params.sessionId);
  session?.abortController?.abort();
}

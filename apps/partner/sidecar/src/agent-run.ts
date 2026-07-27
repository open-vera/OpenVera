import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  envVarFor,
  LlmService,
  resolveEnvKey,
  type LLMAdapter,
} from "@open-vera/core/adapters";
import {
  globalConfigPath,
  loadConfig,
  projectConfigPath,
  resolveClassifierTarget,
  resolveConfigLocation,
  resolveDefaultTarget,
  resolveModelReference,
  resolveProviderModelConfig,
  resolveRoutingConfig,
  type VeraConfig,
} from "@open-vera/core/config";
import { getModelContextLimit } from "@open-vera/core/context";
import type { PlanEvent } from "@open-vera/core/plan";
import type { Message, Usage } from "@open-vera/core/types";
import { createToolRegistry, type SecurityPlugin, type ToolHost, type ToolResult } from "@open-vera/core/tools";
import { runInteractiveTurn } from "@open-vera/openvera";
import type { AgentRunParams, PartnerLlmConfig, StreamEvent } from "./protocol.js";
import { writeEvent } from "./protocol.js";
import { extractFileChange } from "./file-change.js";
import { appendGatewayErrorHeaders } from "./gateway-error-headers.js";
import { createRunMetricsTracker, type PartnerUsagePayload } from "./run-metrics.js";
import { appendRunLogLine } from "./run-log.js";
import { waitForToolApproval } from "./tool-approval.js";

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
  security: SecurityPlugin;
}

interface SessionState {
  abortController: AbortController | null;
  /** Last remote context-window occupancy for this Partner session. */
  lastContextUsed?: number;
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
const requestTaskIds = new Map<string, string>();

function appendRunLog(
  projectRoot: string,
  record: Record<string, unknown>,
): void {
  try {
    const taskId =
      typeof record.taskId === "string"
        ? record.taskId
        : typeof record.requestId === "string"
          ? requestTaskIds.get(record.requestId)
          : undefined;
    appendRunLogLine(projectRoot, record, taskId);
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
  const fileConfig = loadConfig(undefined, projectRoot);

  if (llmConfig?.apiKey) {
    const adapter = adapterTypeForProtocol(llmConfig.protocol);
    const provider = llmConfig.provider || "partner";
    const configuredProvider = fileConfig.providers?.[provider];
    const baseUrl = llmConfig.apiBaseUrl || configuredProvider?.base_url;
    const providers = { ...(fileConfig.providers ?? {}) };
    providers[provider] = {
      ...(configuredProvider ?? {}),
      adapter,
      api_key: llmConfig.apiKey,
      ...(baseUrl ? { base_url: baseUrl } : {}),
    };
    // Keep file routing; only overlay credentials + optional chat default model.
    const config: VeraConfig = {
      ...fileConfig,
      providers,
      ...(llmConfig.model
        ? { default_provider: provider, default_model: llmConfig.model }
        : {}),
    };
    const service = new LlmService({ config, apiKeyOverride: llmConfig.apiKey });
    const selected = llmConfig.model
      ? service.selectAdapter({
          purpose: "chat",
          provider,
          model: resolveModelReference(config, llmConfig.model).model,
        })
      : service.selectAdapter({ purpose: "chat" });
    return {
      adapter: selected.adapter,
      model: selected.model,
      service,
      provider: selected.provider,
    };
  }

  const service = new LlmService({ config: fileConfig });
  const selected = service.selectAdapter({ purpose: "chat" });
  const providerConfig = fileConfig.providers?.[selected.provider];
  const apiKey =
    providerConfig?.api_key ?? resolveEnvKey(selected.adapterType, selected.provider);
  if (!apiKey) return undefined;
  return {
    adapter: selected.adapter,
    model: selected.model,
    service,
    provider: selected.provider,
  };
}

async function createPartnerToolRuntime(
  projectRoot: string,
  llm: LlmEnvironment,
): Promise<PartnerToolRuntime> {
  const { toolHost, loadPlugins, security } = createToolRegistry({
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
    security,
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
  _llmConfig?: PartnerLlmConfig,
): { adapter: LLMAdapter; model: string } {
  // Routing always comes from Vera settings.json; Partner llmConfig only overlays credentials.
  const fileConfig = loadConfig(undefined, projectRoot);
  const routing = resolveRoutingConfig(fileConfig);
  if (routing?.enabled) {
    const classifierTarget = resolveClassifierTarget(
      fileConfig,
      resolveDefaultTarget(fileConfig),
    );
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
  let message = raw;
  if (
    raw.includes("403") &&
    lower.includes("api key scenario mismatch")
  ) {
    message = [
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
  } else if (lower.includes("cache_control") && lower.includes("maximum of 4")) {
    message = [
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
  // Surface gateway diagnostics (gw-* / x-gw-*) that SDKs keep on error.headers.
  return appendGatewayErrorHeaders(message, error);
}

export function inspectEffectiveLlmConfig(
  projectRoot: string,
  llmConfig?: PartnerLlmConfig,
  revealSecrets = false,
): Record<string, unknown> {
  const resolvedRoot = resolveAgentProjectRoot(projectRoot);
  const projectPath = projectConfigPath(resolvedRoot);
  const globalPath = globalConfigPath();

  if (llmConfig?.apiKey && llmConfig.model) {
    const configLocation = resolveConfigLocation(undefined, resolvedRoot);
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
      configScope: configLocation.scope,
      projectConfigPath: projectPath,
      globalConfigPath: globalPath,
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
  const models = listInspectModelAliases(config);
  const routing = {
    enabled: Boolean(config.routing?.enabled),
    classifier: stringifyModelRef(config.routing?.classifier),
    l0: stringifyModelRef(config.routing?.l0),
    l1: stringifyModelRef(config.routing?.l1),
    l2: stringifyModelRef(config.routing?.l2),
  };

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
    projectConfigPath: projectPath,
    globalConfigPath: globalPath,
    defaultProvider: config.default_provider,
    defaultModel: config.default_model,
    models,
    routing,
  };
}

function stringifyModelRef(
  reference: string | { provider: string; model: string } | undefined,
): string | null {
  if (!reference) return null;
  if (typeof reference === "string") return reference;
  return reference.model;
}

function listInspectModelAliases(config: VeraConfig): Array<{
  alias: string;
  provider: string;
  model?: string;
}> {
  const models = config.models;
  if (!models) return [];
  if (Array.isArray(models)) {
    const provider = config.default_provider ?? "anthropic";
    return models.map((alias) => ({ alias, provider, model: alias }));
  }
  return Object.entries(models).map(([alias, entry]) => ({
    alias,
    provider: entry.provider,
    ...(entry.model ? { model: entry.model } : {}),
  }));
}

function loadConfigForInspection(path: string, exists: boolean): VeraConfig {
  if (!exists) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as VeraConfig;
}

function adapterTypeForProtocol(
  protocol: string,
): "anthropic" | "openai" | "openai-responses" | "gemini" {
  if (protocol === "openai-compatible") return "openai";
  if (protocol === "openai-responses") return "openai-responses";
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
  const { sessionId, instanceId, message, history = [], projectRoot, llmConfig, taskId, agentMode } = params;
  if (taskId) {
    requestTaskIds.set(requestId, taskId);
  }
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

  const metrics = createRunMetricsTracker(built.model);
  const contextMax = getModelContextLimit(built.model);
  const compressionTrigger = Math.floor(contextMax * 0.78);
  let usage: PartnerUsagePayload | undefined;
  let firstDeltaLogged = false;
  try {
    let finalText = "";
    let harnessError: string | undefined;

    const onUsage = (value: Usage) => {
      usage = metrics.recordUsage(value);
      if (usage.context_used > 0) {
        session.lastContextUsed = usage.context_used;
      }
      appendRunLog(resolvedRoot, {
        requestId,
        sessionId,
        instanceId,
        event: "usage",
        usage,
      });
      writeEvent({
        id: requestId,
        type: "usage",
        data: { instanceId, usage },
      });
    };

    const executeToolCall = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<ToolResult> => {
      metrics.recordToolUse();
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

      const toolCtx = {
        cwd: resolvedRoot,
        sessionId,
        signal: abortController.signal,
        llmService: built.service,
        defaultModel: built.model,
      };

      let toolResult = await toolRuntime.toolHost.execute(name, toolInput, toolCtx);
      while (toolResult.needsConfirm) {
        const confirm = toolResult.needsConfirm;
        const approvalCallId = randomUUID();
        appendRunLog(resolvedRoot, {
          requestId,
          sessionId,
          instanceId,
          event: "tool_approval_required",
          callId: approvalCallId,
          toolCallId: callId,
          toolName: name,
          allowDir: confirm.allowDir,
          message: confirm.message,
        });
        writeEvent({
          id: requestId,
          type: "tool_approval_required",
          data: {
            instanceId,
            callId: approvalCallId,
            name,
            input: toolInput,
            reason: confirm.message,
            allowDir: confirm.allowDir,
          },
        });

        const approved = await waitForToolApproval(approvalCallId);
        if (!approved) {
          toolResult = {
            ok: false,
            content: "用户拒绝授权访问该路径",
            error: {
              code: "PERMISSION_DENIED",
              message: "用户拒绝授权访问该路径",
              retryable: false,
            },
          };
          break;
        }

        toolRuntime.security.allowPath(confirm.allowDir);
        toolResult = await toolRuntime.toolHost.execute(
          confirm.retry.name,
          confirm.retry.args,
          toolCtx,
        );
      }

      const output = formatToolResult(toolResult);
      const fileChange = extractFileChange(toolResult);
      appendRunLog(resolvedRoot, {
        requestId,
        sessionId,
        instanceId,
        event: "tool_result",
        callId,
        toolName: name,
        isError: !toolResult.ok,
        outputPreview: previewText(output),
        fileChangePath: fileChange?.path,
      });
      writeEvent({
        id: requestId,
        type: "tool_result",
        data: {
          instanceId,
          callId,
          output,
          isError: !toolResult.ok,
          ...(fileChange ? { fileChange } : {}),
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
      // Align with REPL: compress when remote window occupancy exceeds ~78%.
      compressionOptions: {
        enabled: true,
        triggerTokens: compressionTrigger,
        keepRecentTurns: 6,
        model: built.model,
      },
      compressionState: {
        segments: [],
        ...(session.lastContextUsed ? { lastContextUsed: session.lastContextUsed } : {}),
      },
      microCompactOptions: {
        enabled: true,
        gapThresholdMinutes: 60,
        keepRecent: 5,
      },
      contextOptions: {
        maxTokens: contextMax,
        targetUtilization: 0.85,
        keepRecentTurns: 6,
      },
      classifier: resolvePartnerClassifier(resolvedRoot, built, llmConfig),
      runMode: agentMode ?? "agent",
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
        writeEvent({
          id: requestId,
          type: "tool_call",
          data: {
            instanceId,
            callId: randomUUID(),
            name: "agent_intent",
            input: {
              level: intent.level,
              domain: intent.domain,
              needsTools: intent.needs_tools,
              needsPlanning: intent.needs_planning,
              reason: intent.reason,
              executionMode,
            },
            handledBySidecar: true,
          },
        });
      },
      onDelta: (delta) => {
        metrics.markFirstDelta();
        if (!firstDeltaLogged) {
          firstDeltaLogged = true;
          appendRunLog(resolvedRoot, {
            requestId,
            sessionId,
            instanceId,
            event: "first_delta",
            deltaPreview: previewText(delta, 120),
            ttftMs: metrics.snapshot().ttft_ms,
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

    usage = metrics.snapshot();
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
      usage = metrics.snapshot();
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
    requestTaskIds.delete(requestId);
  }
}

export function handleAgentAbort(params: { sessionId: string }): void {
  const session = sessions.get(params.sessionId);
  session?.abortController?.abort();
}

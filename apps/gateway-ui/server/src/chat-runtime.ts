import type { Message } from "@open-vera/core/types";
import { existsSync } from "node:fs";
import { loadConfig, resolveProviderModelConfig } from "@open-vera/core/config";
import { LlmService, resolveEnvKey, type LLMAdapter } from "@open-vera/core/adapters";
import { runAgent } from "@open-vera/core/agent";
import { EventBus, type RuntimeCapabilityRegistry } from "@open-vera/plugin-runtime";
import type { ConversationMessage } from "./conversation-store.js";

export interface ChatRuntimeResult {
  text: string;
  mode: "llm" | "placeholder";
  error?: string;
}

export interface ChatRuntimeOptions {
  capabilities?: RuntimeCapabilityRegistry;
  eventBus?: EventBus;
  sessionId?: string;
  traceId?: string;
}

function buildAdapter(
  projectRoot: string,
  providerName?: string,
  modelName?: string,
  options: ChatRuntimeOptions = {},
): { adapter: LLMAdapter; model: string } | undefined {
  const config = loadConfig(undefined, projectRoot);
  const service = new LlmService({ config, capabilities: options.capabilities, eventBus: options.eventBus });
  const selected = service.selectAdapter({ provider: providerName, model: modelName, purpose: "chat" });
  const pc = resolveProviderModelConfig(config, { provider: selected.provider, model: selected.model });
  const runtimeAdapter = options.capabilities?.get(selected.adapterType);
  if (!runtimeAdapter && !pc.api_key && !resolveEnvKey(selected.adapterType, selected.provider)) return undefined;
  return { adapter: service.buildAdapter(selected.provider, selected.model), model: selected.model };
}

function toAgentHistory(messages: ConversationMessage[]): Message[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}

export async function runChatCompletion(
  projectRoot: string,
  userMessage: string,
  priorMessages: ConversationMessage[] = [],
  options: ChatRuntimeOptions = {},
): Promise<ChatRuntimeResult> {
  const settingsPath = `${projectRoot}/.vera/settings.json`;
  if (!existsSync(settingsPath) && !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return {
      text: "未配置 LLM：请在项目 `.vera/settings.json` 或环境变量中设置 API Key。",
      mode: "placeholder",
    };
  }

  try {
    const built = buildAdapter(projectRoot, undefined, undefined, options);
    if (!built) {
      return {
        text: "未找到可用 API Key，无法调用 LLM。",
        mode: "placeholder",
      };
    }

    const history = toAgentHistory(priorMessages);
    const text = await runAgent(userMessage, {
      adapter: built.adapter,
      model: built.model,
      eventBus: options.eventBus,
      sessionId: options.sessionId,
      traceId: options.traceId,
      history,
      maxTurns: 12,
      system: "You are the Vera Gateway assistant. Answer concisely in the user's language.",
    });

    return { text, mode: "llm" };
  } catch (err) {
    return {
      text: "LLM 调用失败，已记录用户消息。",
      mode: "placeholder",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

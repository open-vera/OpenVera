import type { Message } from "@open-vera/core/types";
import { existsSync } from "node:fs";
import { loadConfig, resolveDefaultTarget, resolveProviderModelConfig } from "@open-vera/core/config";
import { AnthropicAdapter, GeminiAdapter, OpenAIAdapter, type LLMAdapter } from "@open-vera/core/adapters";
import { runAgent } from "@open-vera/core/agent";
import type { ConversationMessage } from "./conversation-store.js";

export interface ChatRuntimeResult {
  text: string;
  mode: "llm" | "placeholder";
  error?: string;
}

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

function buildAdapter(projectRoot: string, providerName?: string, modelName?: string): { adapter: LLMAdapter; model: string } | undefined {
  const config = loadConfig(undefined, projectRoot);
  const target = resolveDefaultTarget(config);
  const name = providerName ?? target.provider;
  const model = modelName ?? target.model;
  const pc = resolveProviderModelConfig(config, { provider: name, model });
  const apiKey = pc.api_key || resolveEnvKey(pc.adapter, name);
  if (!apiKey) return undefined;

  let adapter: LLMAdapter;
  switch (pc.adapter) {
    case "openai":
      adapter = new OpenAIAdapter(apiKey, pc.base_url, pc.headers);
      break;
    case "gemini":
      adapter = new GeminiAdapter(apiKey);
      break;
    case "anthropic":
    default:
      adapter = new AnthropicAdapter(apiKey, pc.base_url, pc.headers);
      break;
  }

  return { adapter, model };
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
): Promise<ChatRuntimeResult> {
  const settingsPath = `${projectRoot}/.vera/settings.json`;
  if (!existsSync(settingsPath) && !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return {
      text: "未配置 LLM：请在项目 `.vera/settings.json` 或环境变量中设置 API Key。",
      mode: "placeholder",
    };
  }

  try {
    const built = buildAdapter(projectRoot);
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

import { invoke } from "@tauri-apps/api/core";
import type { AgentRunMode, EffectiveLlmConfig, LLMRuntimeConfig, Message, TokenUsage } from "@/types";
import { onAgentDone, onAgentError } from "./events.js";

export interface AgentRunParams {
  requestId: string;
  instanceId: string;
  sessionId: string;
  message: string;
  history: Message[];
  projectRoot?: string;
  llmConfig?: LLMRuntimeConfig;
  taskId?: string;
  agentMode?: AgentRunMode;
}

export interface AgentRunResult {
  text: string;
  usage?: TokenUsage;
}

function toHistory(messages: Message[]) {
  return messages
    .filter((item) => item.role === "user" || item.role === "assistant")
    .filter((item) => item.content.trim().length > 0)
    .map((item) => ({
      role: item.role,
      content: item.agentContent ?? item.content,
    }));
}

export async function invokeAgentRun(params: AgentRunParams): Promise<void> {
  const { requestId, instanceId, sessionId, message, history, projectRoot, llmConfig, taskId, agentMode } =
    params;
  await invoke("agent_run", {
    requestId,
    instanceId,
    sessionId,
    message,
    history: toHistory(history),
    projectRoot,
    llmConfig,
    taskId,
    agentMode,
  });
}

export function waitForAgentCompletion(
  requestId: string,
  instanceId: string,
): Promise<AgentRunResult> {
  return new Promise((resolve, reject) => {
    const unlisteners: Array<() => void> = [];
    let settled = false;

    const cleanup = () => {
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };

    void Promise.all([
      onAgentDone(requestId, instanceId, (payload) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          text: payload.text ?? "",
          usage: payload.usage,
        });
      }),
      onAgentError(requestId, instanceId, (payload) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(payload.message));
      }),
    ]).then(
      (listeners) => {
        if (settled) {
          for (const unlisten of listeners) {
            unlisten();
          }
          return;
        }
        unlisteners.push(...listeners);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export async function abortAgent(sessionId: string): Promise<void> {
  await invoke("agent_abort", { sessionId });
}

export async function approveAgentTool(callId: string, approved: boolean): Promise<void> {
  await invoke("agent_tool_approval", { callId, approved });
}

export interface SidecarInfo {
  running: boolean;
  error?: string;
  needsNodeInstall?: boolean;
}

export async function getSidecarInfo(): Promise<SidecarInfo> {
  return invoke<SidecarInfo>("sidecar_status");
}

export async function getSidecarStatus(): Promise<boolean> {
  const info = await getSidecarInfo();
  return info.running;
}

export async function inspectLlmConfig(
  projectRoot?: string,
  llmConfig?: LLMRuntimeConfig | null,
  revealSecrets = false,
): Promise<EffectiveLlmConfig> {
  return invoke<EffectiveLlmConfig>("inspect_llm_config", {
    projectRoot,
    llmConfig: llmConfig ?? undefined,
    revealSecrets,
  });
}

export async function saveVeraLlmConfig(params: {
  projectRoot?: string;
  provider: string;
  protocol: string;
  apiBaseUrl: string;
  model: string;
  apiKey?: string;
}): Promise<EffectiveLlmConfig> {
  return invoke<EffectiveLlmConfig>("save_vera_llm_config", {
    projectRoot: params.projectRoot,
    provider: params.provider,
    protocol: params.protocol,
    apiBaseUrl: params.apiBaseUrl,
    model: params.model,
    apiKey: params.apiKey,
  });
}

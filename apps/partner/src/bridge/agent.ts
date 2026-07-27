import type { EffectiveLlmConfig, LLMRuntimeConfig } from "@/types";
import { hostDispatch } from "@/shell";

export async function approveAgentTool(callId: string, approved: boolean): Promise<void> {
  await hostDispatch({
    op: "host.agent.tool_approval",
    callId,
    approved,
  });
}

export interface SidecarInfo {
  running: boolean;
  error?: string;
  needsNodeInstall?: boolean;
}

export async function getSidecarInfo(): Promise<SidecarInfo> {
  const info = await hostDispatch<{
    running: boolean;
    error?: string;
    needs_node_install?: boolean;
    needsNodeInstall?: boolean;
  }>({ op: "host.sidecar.status" });
  return {
    running: info.running,
    error: info.error,
    needsNodeInstall: info.needsNodeInstall ?? info.needs_node_install,
  };
}

export async function getSidecarStatus(): Promise<boolean> {
  const info = await getSidecarInfo();
  return info.running;
}

export async function inspectLlmConfig(
  projectRoot?: string,
  _llmConfig?: LLMRuntimeConfig | null,
  _revealSecrets?: boolean,
): Promise<EffectiveLlmConfig> {
  return hostDispatch<EffectiveLlmConfig>({
    op: "host.llm.inspect",
    projectRoot,
  });
}

export async function saveVeraLlmConfig(params: {
  projectRoot?: string;
  provider: string;
  protocol: string;
  apiBaseUrl: string;
  model: string;
  apiKey?: string;
  setAsDefault?: boolean;
}): Promise<EffectiveLlmConfig> {
  return hostDispatch<EffectiveLlmConfig>({
    op: "host.llm.save",
    projectRoot: params.projectRoot,
    config: {
      provider: params.provider,
      protocol: params.protocol,
      apiBaseUrl: params.apiBaseUrl,
      model: params.model,
      apiKey: params.apiKey,
      setAsDefault: params.setAsDefault,
    },
  });
}

export async function renameVeraProvider(params: {
  projectRoot?: string;
  oldId: string;
  newId: string;
}): Promise<EffectiveLlmConfig> {
  return hostDispatch<EffectiveLlmConfig>({
    op: "host.llm.rename_provider",
    projectRoot: params.projectRoot,
    fromId: params.oldId,
    toId: params.newId,
  });
}

export async function saveVeraModelsRouting(params: {
  projectRoot?: string;
  models: unknown;
  routing: unknown;
  defaultProvider?: string;
  defaultModel?: string;
}): Promise<EffectiveLlmConfig> {
  return hostDispatch<EffectiveLlmConfig>({
    op: "host.llm.save_models_routing",
    projectRoot: params.projectRoot,
    models: params.models,
    routing: {
      ...(params.routing as Record<string, unknown>),
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
    },
  });
}

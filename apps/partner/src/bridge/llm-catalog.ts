import { invoke } from "@tauri-apps/api/core";
import type { CatalogModel, CatalogProvider, LLMProtocol } from "@/types";

export interface LlmProviderRequestOptions {
  protocol?: LLMProtocol;
}

export async function listLlmProviders(projectRoot?: string): Promise<CatalogProvider[]> {
  const result = await invoke<{ providers: CatalogProvider[] }>("list_llm_providers", {
    projectRoot,
  });
  return result.providers ?? [];
}

export async function listLlmProviderModels(
  projectRoot: string | undefined,
  providerId: string,
): Promise<CatalogModel[]> {
  const result = await invoke<{ models: CatalogModel[] }>("list_llm_provider_models", {
    projectRoot,
    providerId,
  });
  return result.models ?? [];
}

export async function refreshLlmProviderModels(
  projectRoot: string | undefined,
  providerId: string,
  options?: LlmProviderRequestOptions,
): Promise<CatalogModel[]> {
  const result = await invoke<{ models: CatalogModel[] }>("refresh_llm_provider_models", {
    projectRoot,
    providerId,
    protocol: options?.protocol,
  });
  return (result.models ?? []).map((model) => ({
    ...model,
    source: "remote" as const,
  }));
}

export interface LlmConnectionTestResult {
  ok: boolean;
  modelCount: number;
  message: string;
}

export async function testLlmConnection(
  projectRoot: string | undefined,
  providerId: string,
  options?: LlmProviderRequestOptions,
): Promise<LlmConnectionTestResult> {
  return invoke<LlmConnectionTestResult>("test_llm_connection", {
    projectRoot,
    providerId,
    protocol: options?.protocol,
  });
}

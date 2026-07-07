import { invoke } from "@tauri-apps/api/core";
import type { CatalogModel, CatalogProvider } from "@/types";

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
): Promise<CatalogModel[]> {
  const result = await invoke<{ models: CatalogModel[] }>("refresh_llm_provider_models", {
    projectRoot,
    providerId,
  });
  return (result.models ?? []).map((model) => ({
    ...model,
    source: "remote" as const,
  }));
}

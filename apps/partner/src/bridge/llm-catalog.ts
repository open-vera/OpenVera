import type { CatalogModel, CatalogProvider, LLMProtocol } from "@/types";
import { hostDispatch } from "@/shell";

export interface LlmProviderRequestOptions {
  protocol?: LLMProtocol;
}

export async function listLlmProviders(projectRoot?: string): Promise<CatalogProvider[]> {
  const result = await hostDispatch<{ providers: CatalogProvider[] }>({
    op: "host.llm.list_providers",
    projectRoot,
  });
  return result.providers ?? [];
}

export async function listLlmProviderModels(
  projectRoot: string | undefined,
  providerId: string,
): Promise<CatalogModel[]> {
  const result = await hostDispatch<{ models: CatalogModel[] }>({
    op: "host.llm.list_provider_models",
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
  const result = await hostDispatch<{ models: CatalogModel[] }>({
    op: "host.llm.refresh_provider_models",
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
  return hostDispatch<LlmConnectionTestResult>({
    op: "host.llm.test_connection",
    projectRoot,
    config: {
      providerId,
      protocol: options?.protocol,
    },
  });
}

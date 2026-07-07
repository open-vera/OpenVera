import { LlmService, resolveEnvKey } from "@open-vera/core/adapters";
import { loadConfig, normalizeModels, resolveDefaultProviderName } from "@open-vera/core/config";
import type { VeraConfig } from "@open-vera/core/config";

export interface CatalogProvider {
  id: string;
  adapter: string;
  protocol: string;
  apiBaseUrl: string;
  hasApiKey: boolean;
  isDefault: boolean;
}

export interface CatalogModel {
  id: string;
  displayName?: string;
}

function protocolForAdapter(adapter: string): string {
  if (adapter === "openai") return "openai-compatible";
  if (adapter === "gemini") return "gemini";
  return "anthropic";
}

function providerHasApiKey(
  config: VeraConfig,
  providerId: string,
  adapter: string,
): boolean {
  const provider = config.providers?.[providerId];
  const configuredKey = provider?.api_key?.trim();
  if (configuredKey) return true;
  return Boolean(resolveEnvKey(adapter, providerId));
}

export function listConfiguredProviders(projectRoot: string): CatalogProvider[] {
  const config = loadConfig(undefined, projectRoot);
  const defaultProvider = resolveDefaultProviderName(config);
  const providers = config.providers ?? {};

  return Object.entries(providers)
    .map(([id, provider]) => {
      const adapter = provider.adapter ?? "anthropic";
      return {
        id,
        adapter,
        protocol: protocolForAdapter(adapter),
        apiBaseUrl: provider.base_url ?? "",
        hasApiKey: providerHasApiKey(config, id, adapter),
        isDefault: id === defaultProvider,
      };
    })
    .filter((provider) => provider.hasApiKey)
    .sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      return left.id.localeCompare(right.id);
    });
}

function configuredModelsForProvider(
  config: VeraConfig,
  providerId: string,
): CatalogModel[] {
  return Object.entries(normalizeModels(config))
    .filter(([, model]) => model.provider === providerId)
    .map(([alias, model]) => ({
      id: model.model ?? alias,
      displayName: model.model && model.model !== alias ? alias : undefined,
    }));
}

export async function listProviderModels(
  projectRoot: string,
  providerId: string,
): Promise<CatalogModel[]> {
  const config = loadConfig(undefined, projectRoot);
  const provider = config.providers?.[providerId];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  if (!providerHasApiKey(config, providerId, provider.adapter ?? "anthropic")) {
    throw new Error(`Provider ${providerId} has no API key configured`);
  }

  const service = new LlmService({ config });
  try {
    const remote = await service.listModels(providerId);
    if (remote.length > 0) {
      return remote.map((model) => ({
        id: model.id,
        displayName: model.display_name,
      }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[partner-sidecar] listModels failed for ${providerId}: ${message}\n`,
    );
  }

  const fallback = configuredModelsForProvider(config, providerId);
  if (fallback.length > 0) return fallback;

  const targetModel = service.resolveModel({ provider: providerId }).model;
  return [{ id: targetModel }];
}

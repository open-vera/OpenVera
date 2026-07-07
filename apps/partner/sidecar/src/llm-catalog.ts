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

const TEST_CONNECTION_TIMEOUT_MS = 10_000;

function protocolForAdapter(adapter: string): string {
  if (adapter === "openai") return "openai-compatible";
  if (adapter === "openai-responses") return "openai-responses";
  if (adapter === "gemini") return "gemini";
  return "anthropic";
}

function adapterForProtocol(protocol: string): string {
  if (protocol === "openai-compatible") return "openai";
  if (protocol === "openai-responses") return "openai-responses";
  if (protocol === "gemini") return "gemini";
  return "anthropic";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function withProtocolOverride(
  config: VeraConfig,
  providerId: string,
  protocol?: string,
): VeraConfig {
  const normalized = protocol?.trim();
  if (!normalized) return config;
  const provider = config.providers?.[providerId];
  if (!provider) return config;
  return {
    ...config,
    providers: {
      ...(config.providers ?? {}),
      [providerId]: {
        ...provider,
        adapter: adapterForProtocol(normalized),
      },
    },
  };
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

function adapterNotRegisteredMessage(protocol?: string): string {
  if (protocol === "openai-responses") {
    return "当前运行环境未加载 OpenAI Responses 适配器。请重启 Partner 触发 sidecar 重建；Claude/兼容网关通常应使用「OpenAI Chat Completions」。";
  }
  return "当前运行环境未加载所选协议对应的适配器，请重启 Partner 触发 sidecar 重建。";
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
  options?: { protocol?: string },
): Promise<CatalogModel[]> {
  const baseConfig = loadConfig(undefined, projectRoot);
  const config = withProtocolOverride(baseConfig, providerId, options?.protocol);
  const provider = config.providers?.[providerId];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  if (!providerHasApiKey(config, providerId, provider.adapter ?? "anthropic")) {
    throw new Error(`Provider ${providerId} has no API key configured`);
  }

  const service = new LlmService({ config });
  try {
    const remote = await withTimeout(
      service.listModels(providerId),
      TEST_CONNECTION_TIMEOUT_MS,
      "同步远程模型超时",
    );
    if (remote.length > 0) {
      return remote.map((model) => ({
        id: model.id,
        displayName: model.display_name,
      }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("No LLM adapter registered")) {
      throw new Error(adapterNotRegisteredMessage(options?.protocol));
    }
    process.stderr.write(
      `[partner-sidecar] listModels failed for ${providerId}: ${message}\n`,
    );
  }

  const fallback = configuredModelsForProvider(config, providerId);
  if (fallback.length > 0) return fallback;

  const targetModel = service.resolveModel({ provider: providerId }).model;
  return [{ id: targetModel }];
}

export async function testProviderConnection(
  projectRoot: string,
  providerId: string,
  options?: { protocol?: string },
): Promise<{ ok: boolean; modelCount: number; message: string }> {
  try {
    const baseConfig = loadConfig(undefined, projectRoot);
    const config = withProtocolOverride(baseConfig, providerId, options?.protocol);
    const provider = config.providers?.[providerId];
    if (!provider) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    if (!providerHasApiKey(config, providerId, provider.adapter ?? "anthropic")) {
      throw new Error(`Provider ${providerId} has no API key configured`);
    }

    const service = new LlmService({ config });
    const target = service.resolveModel({ provider: providerId });
    const selection = service.selectAdapter({
      provider: providerId,
      model: target.model,
    });

    await withTimeout(
      selection.adapter.complete({
        model: target.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      TEST_CONNECTION_TIMEOUT_MS,
      "连接测试超时，请检查网络或 API Base URL",
    );

    let modelCount = configuredModelsForProvider(config, providerId).length;
    try {
      const remote = await withTimeout(
        service.listModels(providerId),
        5_000,
        "listModels timed out",
      );
      if (remote.length > 0) modelCount = remote.length;
    } catch (listError) {
      const message = listError instanceof Error ? listError.message : String(listError);
      process.stderr.write(
        `[partner-sidecar] listModels after test failed for ${providerId}: ${message}\n`,
      );
    }

    return {
      ok: true,
      modelCount,
      message: "ok",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("No LLM adapter registered")) {
      return {
        ok: false,
        modelCount: 0,
        message: adapterNotRegisteredMessage(options?.protocol),
      };
    }
    return { ok: false, modelCount: 0, message };
  }
}

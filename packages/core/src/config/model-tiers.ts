import type { ModelConfig, ModelReference, ProviderConfig, RoutingConfig, RoutingTarget, VeraConfig } from "./types.js";

const FALLBACK_ROUTING: Record<"classifier" | "l0" | "l1" | "l2", RoutingTarget> = {
  classifier: { provider: "anthropic", model: "claude-haiku-4-5" },
  l0: { provider: "anthropic", model: "claude-haiku-4-5" },
  l1: { provider: "anthropic", model: "claude-sonnet-4-6" },
  l2: { provider: "anthropic", model: "claude-opus-4-6" },
};

export function resolveDefaultProviderName(config: VeraConfig): string | undefined {
  if (config.default_provider) return config.default_provider;
  if (config.routing?.enabled && config.routing.l1) {
    const route = config.routing.l1;
    if (typeof route !== "string") return route.provider;
    const model = getConfiguredModel(config, route);
    if (model) return model.provider;
  }
  if (config.default_model) {
    const model = getConfiguredModel(config, config.default_model);
    if (model) return model.provider;
  }
  const providerNames = Object.keys(config.providers ?? {});
  if (providerNames.length === 1) return providerNames[0];
  return config.providers?.anthropic ? "anthropic" : undefined;
}

export function resolveDefaultTarget(config: VeraConfig): RoutingTarget {
  if (config.routing?.enabled && config.routing.l1) {
    return resolveModelReference(config, config.routing.l1);
  }
  if (config.default_model) {
    return resolveModelReference(config, config.default_model);
  }

  const providerName = resolveDefaultProviderName(config);
  return {
    provider: providerName ?? "anthropic",
    model: "claude-opus-4-6",
  };
}

export function resolveDefaultModelAliasForProvider(config: VeraConfig, providerName: string): string | undefined {
  const current = config.default_model ? getConfiguredModel(config, config.default_model) : undefined;
  if (current?.provider === providerName) return config.default_model;
  return Object.entries(normalizeModels(config)).find(([, model]) => model.provider === providerName)?.[0];
}

export function resolveClassifierTarget(config: VeraConfig, defaultTarget = resolveDefaultTarget(config)): RoutingTarget {
  if (config.routing?.classifier) return resolveModelReference(config, config.routing.classifier);
  return defaultTarget.provider === "anthropic" ? FALLBACK_ROUTING.classifier : {
    provider: defaultTarget.provider,
    model: FALLBACK_ROUTING.classifier.model,
  };
}

export function resolveRoutingConfig(config: VeraConfig): RoutingConfig | undefined {
  const routing = config.routing;
  if (!routing?.enabled) return routing;
  const classifier = routing.classifier
    ? resolveModelReference(config, routing.classifier)
    : FALLBACK_ROUTING.classifier;
  const l0 = routing.l0
    ? resolveModelReference(config, routing.l0)
    : FALLBACK_ROUTING.l0;
  const l1 = routing.l1
    ? resolveModelReference(config, routing.l1)
    : FALLBACK_ROUTING.l1;
  const l2 = routing.l2
    ? resolveModelReference(config, routing.l2)
    : FALLBACK_ROUTING.l2;

  return {
    enabled: routing.enabled,
    classifier,
    l0,
    l1,
    l2,
  };
}

export function resolveModelReference(config: VeraConfig, reference: ModelReference): RoutingTarget {
  if (typeof reference !== "string") return reference;

  const model = getConfiguredModel(config, reference);
  if (model) return { provider: model.provider, model: model.model ?? reference };

  const providerName = resolveDefaultProviderName(config);

  return {
    provider: providerName ?? "anthropic",
    model: reference,
  };
}

export function resolveProviderModelConfig(
  config: VeraConfig,
  target: RoutingTarget,
): ProviderConfig {
  const provider = config.providers?.[target.provider] ?? { adapter: "anthropic" };
  const model =
    Object.entries(normalizeModels(config)).find(([alias, candidate]) => (
      candidate.provider === target.provider && (candidate.model ?? alias) === target.model
    ))?.[1];
  return {
    ...provider,
    ...(model?.adapter ? { adapter: model.adapter } : {}),
    ...(model?.api_key ? { api_key: model.api_key } : {}),
    ...(model?.base_url ? { base_url: model.base_url } : {}),
    ...(model?.headers ? { headers: model.headers } : {}),
  };
}

export function normalizeModels(config: VeraConfig): Record<string, ModelConfig> {
  const models = config.models;
  if (!models) return {};
  if (!Array.isArray(models)) return models;
  const provider = resolveDefaultProviderName({ ...config, models: undefined }) ?? "anthropic";
  return Object.fromEntries(models.map((model) => [model, { provider }]));
}

function getConfiguredModel(config: VeraConfig, alias: string): ModelConfig | undefined {
  return normalizeModels(config)[alias];
}


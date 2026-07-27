/**
 * Pure transforms for Vera settings.json used by Partner settings UI/tests.
 * Keep in sync with Rust helpers in apps/partner/src-tauri/src/commands/agent.rs.
 */

export interface VeraModelAlias {
  alias: string;
  provider: string;
  /** Upstream model id; defaults to alias when omitted. */
  model?: string;
}

export interface VeraRoutingSettings {
  enabled: boolean;
  classifier?: string;
  l0?: string;
  l1?: string;
  l2?: string;
}

export interface VeraModelsRoutingSnapshot {
  models: VeraModelAlias[];
  defaultProvider?: string;
  defaultModel?: string;
  routing: VeraRoutingSettings;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return null;
}

export function normalizeProviderId(id: string): string {
  return id.trim().replace(/\s+/g, "-");
}

export function isValidProviderId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id);
}

function rewriteModelReference(
  reference: unknown,
  oldId: string,
  newId: string,
): unknown {
  if (typeof reference === "string") return reference;
  const obj = asObject(reference);
  if (!obj) return reference;
  if (obj.provider === oldId) {
    return { ...obj, provider: newId };
  }
  return reference;
}

function rewriteRoutingProviderRefs(
  routing: unknown,
  oldId: string,
  newId: string,
): unknown {
  const obj = asObject(routing);
  if (!obj) return routing;
  const next: JsonObject = { ...obj };
  for (const key of ["classifier", "l0", "l1", "l2"] as const) {
    if (key in next) {
      next[key] = rewriteModelReference(next[key], oldId, newId);
    }
  }
  return next;
}

function rewriteSessionProviderRefs(
  session: unknown,
  oldId: string,
  newId: string,
): unknown {
  const obj = asObject(session);
  if (!obj) return session;
  const next: JsonObject = { ...obj };
  for (const key of ["ai_title", "compact"] as const) {
    const block = asObject(next[key]);
    if (!block) continue;
    if (block.provider === oldId) {
      next[key] = { ...block, provider: newId };
    }
  }
  return next;
}

/** Rename providers.<oldId> → providers.<newId> and rewrite references. */
export function renameProviderInConfig(
  config: unknown,
  oldId: string,
  newIdRaw: string,
): JsonObject {
  const root = asObject(config) ? { ...(config as JsonObject) } : {};
  const oldKey = oldId.trim();
  const newId = normalizeProviderId(newIdRaw);
  if (!oldKey) throw new Error("Provider id is required");
  if (!isValidProviderId(newId)) {
    throw new Error(`Invalid provider id: ${newId}`);
  }
  if (oldKey === newId) return root;

  const providers = asObject(root.providers) ?? {};
  if (!(oldKey in providers)) {
    throw new Error(`Provider not found: ${oldKey}`);
  }
  if (newId in providers) {
    throw new Error(`Provider already exists: ${newId}`);
  }

  const nextProviders: JsonObject = {};
  for (const [key, value] of Object.entries(providers)) {
    nextProviders[key === oldKey ? newId : key] = value;
  }
  root.providers = nextProviders;

  const models = asObject(root.models);
  if (models) {
    const nextModels: JsonObject = {};
    for (const [alias, value] of Object.entries(models)) {
      const entry = asObject(value);
      if (entry && entry.provider === oldKey) {
        nextModels[alias] = { ...entry, provider: newId };
      } else {
        nextModels[alias] = value;
      }
    }
    root.models = nextModels;
  }

  if (root.default_provider === oldKey) {
    root.default_provider = newId;
  }

  if (root.routing !== undefined) {
    root.routing = rewriteRoutingProviderRefs(root.routing, oldKey, newId);
  }
  if (root.session !== undefined) {
    root.session = rewriteSessionProviderRefs(root.session, oldKey, newId);
  }

  return root;
}

export function listModelAliases(config: unknown): VeraModelAlias[] {
  const root = asObject(config);
  const models = root ? root.models : undefined;
  if (!models) return [];
  if (Array.isArray(models)) {
    const provider =
      (root?.default_provider as string | undefined) ??
      Object.keys(asObject(root?.providers) ?? {})[0] ??
      "anthropic";
    return models
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((alias) => ({ alias, provider, model: alias }));
  }
  const obj = asObject(models);
  if (!obj) return [];
  return Object.entries(obj).map(([alias, value]) => {
    const entry = asObject(value);
    const provider =
      (entry?.provider as string | undefined) ??
      (root?.default_provider as string | undefined) ??
      "anthropic";
    const model =
      typeof entry?.model === "string" && entry.model.trim()
        ? entry.model
        : undefined;
    return { alias, provider, model };
  });
}

export function readModelsRouting(config: unknown): VeraModelsRoutingSnapshot {
  const root = asObject(config) ?? {};
  const routingObj = asObject(root.routing) ?? {};
  return {
    models: listModelAliases(root),
    defaultProvider:
      typeof root.default_provider === "string" ? root.default_provider : undefined,
    defaultModel:
      typeof root.default_model === "string" ? root.default_model : undefined,
    routing: {
      enabled: routingObj.enabled === true,
      classifier:
        typeof routingObj.classifier === "string" ? routingObj.classifier : undefined,
      l0: typeof routingObj.l0 === "string" ? routingObj.l0 : undefined,
      l1: typeof routingObj.l1 === "string" ? routingObj.l1 : undefined,
      l2: typeof routingObj.l2 === "string" ? routingObj.l2 : undefined,
    },
  };
}

export function applyModelsRouting(
  config: unknown,
  snapshot: VeraModelsRoutingSnapshot,
): JsonObject {
  const root = asObject(config) ? { ...(config as JsonObject) } : {};
  const models: JsonObject = {};
  for (const item of snapshot.models) {
    const alias = item.alias.trim();
    if (!alias) continue;
    const provider = normalizeProviderId(item.provider);
    if (!provider) continue;
    const entry: JsonObject = { provider };
    const upstream = item.model?.trim();
    if (upstream && upstream !== alias) {
      entry.model = upstream;
    }
    models[alias] = entry;
  }
  root.models = models;

  if (snapshot.defaultProvider?.trim()) {
    root.default_provider = normalizeProviderId(snapshot.defaultProvider);
  }
  if (snapshot.defaultModel?.trim()) {
    root.default_model = snapshot.defaultModel.trim();
  } else {
    delete root.default_model;
  }

  const routing: JsonObject = {
    enabled: snapshot.routing.enabled,
  };
  for (const key of ["classifier", "l0", "l1", "l2"] as const) {
    const value = snapshot.routing[key]?.trim();
    if (value) routing[key] = value;
  }
  root.routing = routing;

  return root;
}

export function upsertModelAlias(
  config: unknown,
  aliasRaw: string,
  provider: string,
  upstreamModel?: string,
): JsonObject {
  const snapshot = readModelsRouting(config);
  const alias = aliasRaw.trim();
  if (!alias) throw new Error("Model alias is required");
  const next = snapshot.models.filter((item) => item.alias !== alias);
  next.push({
    alias,
    provider: normalizeProviderId(provider),
    model: upstreamModel?.trim() || undefined,
  });
  return applyModelsRouting(config, { ...snapshot, models: next });
}

export function removeModelAlias(config: unknown, aliasRaw: string): JsonObject {
  const snapshot = readModelsRouting(config);
  const alias = aliasRaw.trim();
  return applyModelsRouting(config, {
    ...snapshot,
    models: snapshot.models.filter((item) => item.alias !== alias),
    defaultModel:
      snapshot.defaultModel === alias ? undefined : snapshot.defaultModel,
    routing: {
      ...snapshot.routing,
      classifier:
        snapshot.routing.classifier === alias
          ? undefined
          : snapshot.routing.classifier,
      l0: snapshot.routing.l0 === alias ? undefined : snapshot.routing.l0,
      l1: snapshot.routing.l1 === alias ? undefined : snapshot.routing.l1,
      l2: snapshot.routing.l2 === alias ? undefined : snapshot.routing.l2,
    },
  });
}

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLogger, type Logger } from "@open-vera/logger";
import { RuntimeCapabilityRegistry, type RuntimeCapabilityInput } from "./capability-registry.js";
import type { PluginContext, PluginDefinition, PluginFileStore, PluginKvStore } from "./context.js";
import { DisposableStore } from "./disposable.js";
import { EventBus } from "./event-bus.js";
import {
  PluginLockfileStore,
  type PluginLockRecord,
} from "./lockfile.js";
import type { DiscoveredPlugin, PluginSource } from "./manifest.js";
import { PluginLoader } from "./plugin-loader.js";
import { PolicyEngine, type PluginRiskDisclosure } from "./policy-engine.js";

export type PluginRuntimeStatus = "discovered" | "enabled" | "activated" | "deactivated" | "disabled" | "error";

export interface PluginRuntimeState {
  plugin: DiscoveredPlugin;
  status: PluginRuntimeStatus;
  disclosure: PluginRiskDisclosure;
  activatedAt?: string;
  lastError?: string;
}

export interface PluginHostOptions {
  rootDir: string;
  loader?: PluginLoader;
  eventBus?: EventBus;
  capabilities?: RuntimeCapabilityRegistry;
  lockfile?: PluginLockfileStore;
  policy?: PolicyEngine;
  logger?: Logger;
}

interface ActivePlugin {
  plugin: DiscoveredPlugin;
  definition: PluginDefinition;
  context: PluginContext;
  controller: AbortController;
}

export class PluginHost {
  readonly loader: PluginLoader;
  readonly eventBus: EventBus;
  readonly capabilities: RuntimeCapabilityRegistry;
  readonly lockfile: PluginLockfileStore;
  readonly policy: PolicyEngine;

  private readonly rootDir: string;
  private readonly logger: Logger;
  private readonly plugins = new Map<string, PluginRuntimeState>();
  private readonly active = new Map<string, ActivePlugin>();

  constructor(options: PluginHostOptions) {
    this.rootDir = options.rootDir;
    this.loader = options.loader ?? new PluginLoader({ cwd: options.rootDir });
    this.eventBus = options.eventBus ?? new EventBus();
    this.capabilities = options.capabilities ?? new RuntimeCapabilityRegistry();
    this.lockfile = options.lockfile ?? new PluginLockfileStore(options.rootDir);
    this.policy = options.policy ?? new PolicyEngine();
    this.logger = options.logger ?? createLogger("plugin-host");
  }

  discover(source: PluginSource): PluginRuntimeState {
    const plugin = this.loader.discover(source);
    const disclosure = this.policy.inspect(plugin);
    const locked = this.lockfile.get(plugin.manifest.id);
    const status: PluginRuntimeStatus = locked?.enabled ? "enabled" : "discovered";
    const state: PluginRuntimeState = {
      plugin,
      status,
      disclosure,
      ...(locked?.activatedAt ? { activatedAt: locked.activatedAt } : {}),
      ...(locked?.lastError ? { lastError: locked.lastError } : {}),
    };
    this.plugins.set(plugin.manifest.id, state);
    return state;
  }

  discoverMany(sources: PluginSource[]): PluginRuntimeState[] {
    return sources.map((source) => this.discover(source));
  }

  inspect(pluginId: string): PluginRiskDisclosure | undefined {
    return this.plugins.get(pluginId)?.disclosure;
  }

  enable(pluginId: string): PluginLockRecord {
    const state = this.requireState(pluginId);
    const record = this.lockfile.upsert({
      id: state.plugin.manifest.id,
      source: state.plugin.source,
      version: state.plugin.manifest.version,
      checksum: state.plugin.checksum,
      enabled: true,
      approvedPermissions: this.policy.approvedPermissions(state.plugin),
    });
    this.plugins.set(pluginId, { ...state, status: "enabled", lastError: undefined });
    return record;
  }

  async activate(pluginId: string): Promise<PluginRuntimeState> {
    const state = this.requireState(pluginId);
    const lock = this.lockfile.get(pluginId);
    if (!lock?.enabled) {
      throw new Error(`Plugin ${pluginId} is not enabled`);
    }
    if (this.active.has(pluginId)) {
      return this.plugins.get(pluginId)!;
    }

    const controller = new AbortController();
    const disposables = new DisposableStore();
    const context = this.createContext(state.plugin, controller, disposables);

    try {
      const definition = await this.loader.load(state.plugin);
      await definition.activate(context);
      const activatedAt = new Date().toISOString();
      this.active.set(pluginId, {
        plugin: state.plugin,
        definition,
        context,
        controller,
      });
      this.lockfile.update(pluginId, { activatedAt, lastError: undefined });
      const next = { ...state, status: "activated" as const, activatedAt, lastError: undefined };
      this.plugins.set(pluginId, next);
      return next;
    } catch (error) {
      controller.abort();
      this.eventBus.removeByPlugin(pluginId);
      this.capabilities.removeByPlugin(pluginId);
      await disposeQuietly(disposables, this.logger, pluginId);
      const message = error instanceof Error ? error.message : String(error);
      this.lockfile.update(pluginId, { lastError: message });
      const next = { ...state, status: "error" as const, lastError: message };
      this.plugins.set(pluginId, next);
      return next;
    }
  }

  async deactivate(pluginId: string): Promise<PluginRuntimeState> {
    const state = this.requireState(pluginId);
    const active = this.active.get(pluginId);
    if (!active) {
      const next = { ...state, status: "deactivated" as const };
      this.plugins.set(pluginId, next);
      return next;
    }

    active.controller.abort();
    try {
      await active.definition.deactivate?.(active.context);
      await active.context.disposables.dispose();
    } finally {
      this.active.delete(pluginId);
      this.eventBus.removeByPlugin(pluginId);
      this.capabilities.removeByPlugin(pluginId);
    }

    const next = { ...state, status: "deactivated" as const };
    this.plugins.set(pluginId, next);
    return next;
  }

  async disable(pluginId: string): Promise<PluginRuntimeState> {
    await this.deactivate(pluginId);
    this.lockfile.update(pluginId, { enabled: false });
    const state = this.requireState(pluginId);
    const next = { ...state, status: "disabled" as const };
    this.plugins.set(pluginId, next);
    return next;
  }

  async reload(pluginId: string): Promise<PluginRuntimeState> {
    const state = this.requireState(pluginId);
    await this.deactivate(pluginId);
    const refreshed = this.discover(state.plugin.source);
    if (!this.lockfile.get(pluginId)?.enabled) {
      return refreshed;
    }
    return this.activate(pluginId);
  }

  list(): PluginRuntimeState[] {
    return [...this.plugins.values()];
  }

  get(pluginId: string): PluginRuntimeState | undefined {
    return this.plugins.get(pluginId);
  }

  async activateEnabledFromLockfile(): Promise<PluginRuntimeState[]> {
    const lockfile = this.lockfile.load();
    const activated: PluginRuntimeState[] = [];
    for (const record of Object.values(lockfile.plugins)) {
      if (!record.enabled) continue;
      const state = this.plugins.get(record.id) ?? this.discover(record.source);
      if (state.plugin.checksum !== record.checksum || state.plugin.manifest.version !== record.version) {
        this.lockfile.update(record.id, {
          checksum: state.plugin.checksum,
          version: state.plugin.manifest.version,
        });
      }
      activated.push(await this.activate(record.id));
    }
    return activated;
  }

  private requireState(pluginId: string): PluginRuntimeState {
    const state = this.plugins.get(pluginId);
    if (!state) throw new Error(`Plugin ${pluginId} has not been discovered`);
    return state;
  }

  private createContext(
    plugin: DiscoveredPlugin,
    controller: AbortController,
    disposables: DisposableStore,
  ): PluginContext {
    const pluginId = plugin.manifest.id;
    const logger = this.logger.child(pluginId);
    const stateDir = join(this.rootDir, ".vera", "plugins-state", sanitizePathSegment(pluginId));

    return {
      pluginId,
      scope: plugin.manifest.scope,
      manifest: plugin.manifest,
      logger,
      signal: controller.signal,
      provide: {
        register: (input: Omit<RuntimeCapabilityInput, "ownerPluginId" | "scope">) => {
          this.capabilities.register({
            ...input,
            ownerPluginId: pluginId,
            scope: capabilityScopeFromPluginScope(plugin.manifest.scope),
            source: input.source ?? `plugin:${pluginId}`,
            permissions: input.permissions ?? plugin.manifest.permissions,
          });
        },
        tool: (input) => {
          this.capabilities.register({
            id: input.name,
            kind: "tool",
            name: input.name,
            ownerPluginId: pluginId,
            scope: capabilityScopeFromPluginScope(plugin.manifest.scope),
            source: `plugin:${pluginId}`,
            status: input.status ?? "available",
            factory: input.execute,
            permissions: input.permissions ?? plugin.manifest.permissions,
            actions: input.actions ?? ["view", "test"],
            metadata: {
              ...input.metadata,
              ...(input.override ? { override: true } : {}),
              description: input.description,
              parameters: input.parameters,
              ...(input.options ? { options: input.options } : {}),
              ...(input.version !== undefined ? { version: input.version } : {}),
              ...(input.group ? { group: input.group } : {}),
            },
          });
        },
        llmAdapter: (name, factory, options = {}) => {
          this.capabilities.register({
            id: name,
            kind: "llm-adapter",
            name: options.displayName ?? name,
            ownerPluginId: pluginId,
            scope: capabilityScopeFromPluginScope(plugin.manifest.scope),
            source: `plugin:${pluginId}`,
            status: options.status ?? "available",
            factory,
            permissions: options.permissions ?? plugin.manifest.permissions,
            actions: options.actions ?? ["view", "test"],
            metadata: {
              ...options.metadata,
              supportedPurposes: options.supportedPurposes ?? [],
              supportedModalities: options.supportedModalities ?? [],
            },
          });
        },
        modelProvider: (name, provider, options = {}) => {
          this.capabilities.register({
            id: name,
            kind: "model-provider",
            name: options.displayName ?? name,
            ownerPluginId: pluginId,
            scope: capabilityScopeFromPluginScope(plugin.manifest.scope),
            source: `plugin:${pluginId}`,
            status: options.status ?? "available",
            factory: provider,
            permissions: options.permissions ?? plugin.manifest.permissions,
            actions: options.actions ?? ["view", "test"],
            metadata: {
              ...options.metadata,
              models: options.models ?? [],
              ...(options.defaultModel ? { defaultModel: options.defaultModel } : {}),
            },
          });
        },
        channelAdapter: (name, factory, options) => {
          this.capabilities.register({
            id: name,
            kind: "channel-adapter",
            name: options.displayName ?? name,
            ownerPluginId: pluginId,
            scope: capabilityScopeFromPluginScope(plugin.manifest.scope),
            source: `plugin:${pluginId}`,
            status: options.status ?? "available",
            factory,
            permissions: options.permissions ?? plugin.manifest.permissions,
            actions: options.actions ?? ["view", "test", "connect", "disconnect", "reload"],
            metadata: {
              ...options.metadata,
              channelType: options.channelType,
              description: options.description ?? options.displayName ?? name,
              version: options.version ?? plugin.manifest.version,
            },
          });
        },
        promptBlock: (input) => {
          this.capabilities.register({
            id: input.id,
            kind: "prompt",
            name: input.id,
            ownerPluginId: pluginId,
            scope: capabilityScopeFromPluginScope(plugin.manifest.scope),
            source: `plugin:${pluginId}`,
            status: input.status ?? "available",
            factory: input,
            permissions: input.permissions ?? plugin.manifest.permissions,
            actions: input.actions ?? ["view", "reload"],
            metadata: {
              ...input.metadata,
              priority: input.priority ?? 0,
              contentLength: input.content.length,
            },
          });
        },
        contextProvider: (input) => {
          this.capabilities.register({
            id: input.id,
            kind: "context",
            name: input.id,
            ownerPluginId: pluginId,
            scope: capabilityScopeFromPluginScope(plugin.manifest.scope),
            source: `plugin:${pluginId}`,
            status: input.status ?? "available",
            factory: input,
            permissions: input.permissions ?? plugin.manifest.permissions,
            actions: input.actions ?? ["view", "reload"],
            metadata: {
              ...input.metadata,
              priority: input.priority ?? 0,
              tokenEstimate: input.tokenEstimate,
              contentLength: input.content.length,
            },
          });
        },
      },
      hooks: this.eventBus.createRegistrar(pluginId, plugin.manifest.scope),
      disposables,
      config: {
        get: () => undefined,
        watch: () => ({ dispose: () => undefined }),
      },
      secrets: {
        get: async () => {
          throw new Error("Plugin secrets service is not configured");
        },
      },
      storage: {
        kv: (namespace?: string) => new MemoryKvStore(`${pluginId}:${namespace ?? "default"}`),
        files: (namespace?: string) => {
          const dir = resolve(stateDir, "files", sanitizePathSegment(namespace ?? "default"));
          mkdirSync(dir, { recursive: true });
          return {
            resolvePath: (path: string) => resolve(dir, path),
          } satisfies PluginFileStore;
        },
      },
    };
  }
}

class MemoryKvStore implements PluginKvStore {
  private static readonly stores = new Map<string, Map<string, unknown>>();
  private readonly values: Map<string, unknown>;

  constructor(namespace: string) {
    let values = MemoryKvStore.stores.get(namespace);
    if (!values) {
      values = new Map<string, unknown>();
      MemoryKvStore.stores.set(namespace, values);
    }
    this.values = values;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
}

function capabilityScopeFromPluginScope(scope: DiscoveredPlugin["manifest"]["scope"]): RuntimeCapabilityInput["scope"] {
  return scope === "project" ? "project" : "global";
}

async function disposeQuietly(store: DisposableStore, logger: Logger, pluginId: string): Promise<void> {
  try {
    await store.dispose();
  } catch (error) {
    logger.warn("plugin dispose failed after activation error", {
      pluginId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

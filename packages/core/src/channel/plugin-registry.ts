/**
 * Channel Plugin Registry — runtime dynamic loading/unloading of channel adapters.
 *
 * Allows registering adapter factories (plugins) that can be instantiated,
 * loaded into a Gateway, and unloaded at runtime without restarting.
 */

import type {
  ChannelAdapter,
  ChannelType,
} from "./types.js";
import { ChannelError } from "./types.js";

// ── Plugin Types ──────────────────────────────────────────────────────────────

/** Metadata describing a channel plugin */
export interface ChannelPluginMeta {
  /** Unique plugin name (e.g., "feishu", "telegram") */
  name: string;
  /** Human-readable description */
  description: string;
  /** The channel type this plugin provides */
  channelType: ChannelType;
  /** Plugin version (semver) */
  version: string;
  /** Optional author information */
  author?: string;
}

/** Factory function that creates a ChannelAdapter from config */
export type AdapterFactory<TConfig = Record<string, unknown>> = (
  config: TConfig,
) => ChannelAdapter | Promise<ChannelAdapter>;

/** A registered plugin entry */
export interface ChannelPlugin {
  /** Plugin metadata */
  meta: ChannelPluginMeta;
  /** Factory function to create adapter instances */
  factory: AdapterFactory;
}

/** Status of a loaded adapter instance */
export interface LoadedAdapter {
  /** The plugin name that created this adapter */
  pluginName: string;
  /** The adapter instance */
  adapter: ChannelAdapter;
  /** When this adapter was loaded */
  loadedAt: string;
  /** Adapter-specific config used during creation */
  config: Record<string, unknown>;
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class PluginAlreadyRegisteredError extends ChannelError {
  constructor(name: string) {
    super("PLUGIN_ALREADY_REGISTERED", `Plugin '${name}' is already registered`);
    this.name = "PluginAlreadyRegisteredError";
  }
}

export class PluginNotFoundError extends ChannelError {
  constructor(name: string) {
    super("PLUGIN_NOT_FOUND", `Plugin '${name}' not found`);
    this.name = "PluginNotFoundError";
  }
}

export class AdapterAlreadyLoadedError extends ChannelError {
  constructor(instanceName: string) {
    super("ADAPTER_ALREADY_LOADED", `Adapter instance '${instanceName}' is already loaded`);
    this.name = "AdapterAlreadyLoadedError";
  }
}

export class AdapterNotLoadedError extends ChannelError {
  constructor(instanceName: string) {
    super("ADAPTER_NOT_LOADED", `Adapter instance '${instanceName}' is not loaded`);
    this.name = "AdapterNotLoadedError";
  }
}

// ── Plugin Registry ───────────────────────────────────────────────────────────

export class ChannelPluginRegistry {
  private plugins = new Map<string, ChannelPlugin>();
  private loadedAdapters = new Map<string, LoadedAdapter>();

  // ── Plugin Registration ──────────────────────────────────────────────────

  /**
   * Register a channel plugin (factory + metadata).
   * Throws if a plugin with the same name already exists.
   */
  registerPlugin(plugin: ChannelPlugin): void {
    if (this.plugins.has(plugin.meta.name)) {
      throw new PluginAlreadyRegisteredError(plugin.meta.name);
    }
    this.plugins.set(plugin.meta.name, plugin);
  }

  /**
   * Unregister a plugin. Unloads any active adapters created by this plugin first.
   * Returns the number of adapters unloaded.
   */
  unregisterPlugin(name: string): number {
    if (!this.plugins.has(name)) {
      return 0;
    }
    const unloaded = this.unloadAllByPlugin(name);
    this.plugins.delete(name);
    return unloaded;
  }

  /**
   * Check if a plugin is registered.
   */
  hasPlugin(name: string): boolean {
    return this.plugins.has(name);
  }

  /**
   * Get plugin metadata by name.
   */
  getPlugin(name: string): ChannelPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * List all registered plugins.
   */
  listPlugins(): ChannelPluginMeta[] {
    return Array.from(this.plugins.values()).map((p) => p.meta);
  }

  // ── Adapter Loading ──────────────────────────────────────────────────────

  /**
   * Create an adapter from a registered plugin and load it.
   *
   * @param pluginName - The registered plugin name
   * @param instanceName - A unique name for this adapter instance
   * @param config - Configuration passed to the adapter factory
   */
  async loadAdapter(
    pluginName: string,
    instanceName: string,
    config: Record<string, unknown> = {},
  ): Promise<ChannelAdapter> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      throw new PluginNotFoundError(pluginName);
    }
    if (this.loadedAdapters.has(instanceName)) {
      throw new AdapterAlreadyLoadedError(instanceName);
    }

    const adapter = await plugin.factory(config);

    this.loadedAdapters.set(instanceName, {
      pluginName,
      adapter,
      loadedAt: new Date().toISOString(),
      config,
    });

    return adapter;
  }

  /**
   * Unload a loaded adapter instance (disconnect + remove).
   * Returns the adapter if it existed, undefined otherwise.
   */
  async unloadAdapter(instanceName: string): Promise<ChannelAdapter | undefined> {
    const entry = this.loadedAdapters.get(instanceName);
    if (!entry) {
      return undefined;
    }

    // Disconnect if connected
    if (entry.adapter.state === "connected") {
      await entry.adapter.disconnect();
    }

    this.loadedAdapters.delete(instanceName);
    return entry.adapter;
  }

  /**
   * Get a loaded adapter instance by name.
   */
  getLoadedAdapter(instanceName: string): LoadedAdapter | undefined {
    return this.loadedAdapters.get(instanceName);
  }

  /**
   * List all loaded adapter instances.
   */
  listLoadedAdapters(): Array<{ instanceName: string } & LoadedAdapter> {
    return Array.from(this.loadedAdapters.entries()).map(([instanceName, entry]) => ({
      instanceName,
      ...entry,
    }));
  }

  // ── Batch Operations ─────────────────────────────────────────────────────

  /**
   * Load multiple adapters from a plugin in one call.
   * Each entry specifies an instance name and config.
   */
  async loadBatch(
    pluginName: string,
    instances: Array<{ instanceName: string; config?: Record<string, unknown> }>,
  ): Promise<Map<string, ChannelAdapter>> {
    const results = new Map<string, ChannelAdapter>();
    for (const { instanceName, config } of instances) {
      const adapter = await this.loadAdapter(pluginName, instanceName, config);
      results.set(instanceName, adapter);
    }
    return results;
  }

  /**
   * Unload all adapters created by a specific plugin.
   * Returns the count of unloaded adapters.
   */
  unloadAllByPlugin(pluginName: string): number {
    let count = 0;
    for (const [instanceName, entry] of this.loadedAdapters) {
      if (entry.pluginName === pluginName) {
        // Synchronous remove; caller should disconnect beforehand if needed
        this.loadedAdapters.delete(instanceName);
        count++;
      }
    }
    return count;
  }

  /**
   * Unload all loaded adapters (disconnect + clear).
   */
  async unloadAll(): Promise<number> {
    let count = 0;
    for (const [instanceName, entry] of this.loadedAdapters) {
      if (entry.adapter.state === "connected") {
        await entry.adapter.disconnect();
      }
      this.loadedAdapters.delete(instanceName);
      count++;
    }
    return count;
  }

  // ── Introspection ────────────────────────────────────────────────────────

  /**
   * Get total count of registered plugins.
   */
  get pluginCount(): number {
    return this.plugins.size;
  }

  /**
   * Get total count of loaded adapters.
   */
  get adapterCount(): number {
    return this.loadedAdapters.size;
  }

  /**
   * Find plugins by channel type.
   */
  findByChannelType(channelType: ChannelType): ChannelPluginMeta[] {
    return this.listPlugins().filter((p) => p.channelType === channelType);
  }
}

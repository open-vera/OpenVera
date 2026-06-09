/**
 * Plugin registry — manages plugin lifecycle, event wiring, and hook chains.
 *
 * The registry is the single coordination point the HarnessRuntime uses to:
 * 1. Register / unregister plugins
 * 2. Emit lifecycle events (delegated to HarnessEventBus)
 * 3. Run hook chains (collecting results from all plugins in order)
 */

import { HarnessEventBus, type HarnessEvents, type EventListener } from "./event-bus.js";
import type { HarnessHooks } from "./hooks.js";
import type {
  HarnessPlugin,
  PluginContext,
  PluginLogger,
  PluginServices,
} from "./plugin.js";
import { createLogger } from "@open-vera/logger";

const log = createLogger("harness:plugin-registry");

// ---------------------------------------------------------------------------
// Registry options
// ---------------------------------------------------------------------------

export interface PluginRegistryOptions {
  /** Services exposed to plugins via PluginContext. */
  services: PluginServices;
  /** Arbitrary config forwarded to plugins. */
  config?: Record<string, unknown>;
  /** Logger factory; defaults to @open-vera/logger scoped to plugin name. */
  loggerFactory?: (pluginName: string) => PluginLogger;
}

// ---------------------------------------------------------------------------
// Internal bookkeeping
// ---------------------------------------------------------------------------

interface RegisteredPlugin {
  plugin: HarnessPlugin;
  unsubscribes: (() => void)[];
  initialized: boolean;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class PluginRegistry {
  private readonly plugins = new Map<string, RegisteredPlugin>();
  private readonly eventBus = new HarnessEventBus();
  private readonly services: PluginServices;
  private readonly config: Record<string, unknown>;
  private readonly loggerFactory: (name: string) => PluginLogger;

  constructor(options: PluginRegistryOptions) {
    this.services = options.services;
    this.config = options.config ?? {};
    this.loggerFactory =
      options.loggerFactory ??
      ((name: string) => createLogger(`harness:plugin:${name}`) as unknown as PluginLogger);
  }

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  /**
   * Register a plugin. Calls `plugin.init()` if defined, then wires up
   * event listeners and hooks.
   */
  async register(plugin: HarnessPlugin): Promise<void> {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered`);
    }

    const ctx: PluginContext = {
      pluginName: plugin.name,
      logger: this.loggerFactory(plugin.name),
      services: this.services,
      config: this.config,
    };

    // Init
    if (plugin.init) {
      await plugin.init(ctx);
    }

    const unsubscribes: (() => void)[] = [];

    // Wire event listeners
    if (plugin.events) {
      for (const [event, listener] of Object.entries(plugin.events)) {
        if (listener) {
          const unsub = this.eventBus.on(
            event as keyof HarnessEvents,
            listener as EventListener<any>,
          );
          unsubscribes.push(unsub);
        }
      }
    }

    this.plugins.set(plugin.name, {
      plugin,
      unsubscribes,
      initialized: true,
    });

    log.info("plugin registered", { name: plugin.name, version: plugin.version });
  }

  /**
   * Unregister a plugin. Calls `dispose()` and removes all event/hook wiring.
   */
  async unregister(name: string): Promise<void> {
    const entry = this.plugins.get(name);
    if (!entry) return;

    // Remove event listeners
    for (const unsub of entry.unsubscribes) {
      unsub();
    }

    // Dispose
    if (entry.plugin.dispose) {
      await entry.plugin.dispose();
    }

    this.plugins.delete(name);
    log.info("plugin unregistered", { name });
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  getPlugin(name: string): HarnessPlugin | undefined {
    return this.plugins.get(name)?.plugin;
  }

  listPlugins(): string[] {
    return Array.from(this.plugins.keys());
  }

  // -----------------------------------------------------------------------
  // Event emission
  // -----------------------------------------------------------------------

  /**
   * Emit a lifecycle event. All registered plugin listeners are invoked.
   */
  async emit<K extends keyof HarnessEvents>(
    event: K,
    payload: HarnessEvents[K],
  ): Promise<void> {
    await this.eventBus.emit(event, payload);
  }

  // -----------------------------------------------------------------------
  // Hook chains
  // -----------------------------------------------------------------------

  /**
   * Run a "before*" hook chain.
   * For `beforeStep`, returning `false` from any plugin short-circuits the chain.
   * For other hooks, the (possibly modified) value is passed to the next plugin.
   */
  async runHook<K extends keyof HarnessHooks>(
    hookName: K,
    ...args: Parameters<NonNullable<HarnessHooks[K]>>
  ): Promise<ReturnType<NonNullable<HarnessHooks[K]>> | undefined> {
    let current: any = args[0]; // For transform hooks, track the value

    for (const [, entry] of this.plugins) {
      const hookFn = entry.plugin.hooks?.[hookName] as Function | undefined;
      if (!hookFn) continue;

      if (hookName === "beforeStep") {
        // beforeStep: false means skip
        const result = await hookFn(current);
        if (result === false) return false as any;
      } else if (hookName === "beforePlan") {
        current = await hookFn(current) ?? current;
      } else if (hookName === "afterPlan") {
        current = await hookFn(current) ?? current;
      } else if (hookName === "afterStep") {
        current = await hookFn(args[0], current) ?? current;
      } else if (hookName === "beforeCritique") {
        current = await hookFn(current) ?? current;
      } else if (hookName === "resolveSkill") {
        const result = await hookFn(current);
        if (result) return result;
      } else if (hookName === "proposeAction") {
        const result = await hookFn(current);
        if (result?.length) return result;
      } else {
        // Generic fallback
        const result = await hookFn(current);
        if (result !== undefined) current = result;
      }
    }

    return current;
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /** Dispose all plugins and clear event bus. */
  async disposeAll(): Promise<void> {
    for (const [name] of this.plugins) {
      await this.unregister(name);
    }
    this.eventBus.removeAll();
  }
}

/**
 * Plugin interface and context for Harness plugins.
 *
 * A HarnessPlugin is the unit of extensibility. It can:
 * - Subscribe to lifecycle events via `events`
 * - Intercept execution via `hooks`
 * - Perform setup/teardown via `init()` / `dispose()`
 */

import type { HarnessEvents, EventListener } from "./event-bus.js";
import type { HarnessHooks } from "./hooks.js";

// ---------------------------------------------------------------------------
// Plugin context — what the runtime provides to each plugin on init
// ---------------------------------------------------------------------------

/** Minimal logger interface (compatible with @open-vera/logger). */
export interface PluginLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/** Services exposed to plugins (subset of HarnessServices). */
export interface PluginServices {
  /** Generate an ExecutionPlan from a natural-language goal. */
  plan(goal: string): Promise<import("@open-vera/core/types").ExecutionPlan>;
}

/** Context passed to `plugin.init()`. */
export interface PluginContext {
  /** Plugin's own name (for logging / diagnostics). */
  pluginName: string;
  /** Logger scoped to the plugin. */
  logger: PluginLogger;
  /** Subset of runtime services available to plugins. */
  services: PluginServices;
  /** Arbitrary key-value config (from .vera/settings.json or CLI flags). */
  config: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Plugin interface
// ---------------------------------------------------------------------------

export interface HarnessPlugin {
  /** Unique plugin name (used as registry key). */
  name: string;

  /** Semantic version string. */
  version: string;

  /**
   * Lifecycle: called once after registration, before the plugin participates.
   * Use this to warm up caches, validate config, etc.
   */
  init?(ctx: PluginContext): Promise<void>;

  /**
   * Lifecycle: called when the plugin is unregistered or the runtime shuts down.
   * Use this to release resources.
   */
  dispose?(): Promise<void>;

  /**
   * Event subscriptions.
   * Keys must match HarnessEvents; values are async or sync listeners.
   */
  events?: {
    [K in keyof HarnessEvents]?: EventListener<K>;
  };

  /**
   * Hook registrations.
   * Hooks run inline and can modify data or short-circuit execution.
   */
  hooks?: Partial<HarnessHooks>;
}

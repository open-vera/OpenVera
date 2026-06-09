/**
 * Plugin Runtime — public API.
 *
 * This module provides the complete plugin protocol:
 * - `HarnessEventBus` / `HarnessEvents` — type-safe event subscription
 * - `HarnessHooks` — interception & extension hooks
 * - `HarnessPlugin` / `PluginContext` — plugin definition interface
 * - `PluginRegistry` — lifecycle management + hook chain execution
 *
 * Note: `PlanDiff` and `FlowLoopResult` are defined in runtime/internal.ts
 * and re-exported from there. The plugin-runtime/types.ts holds internal
 * copies used by the event-bus; external consumers should use the runtime
 * exports.
 */

// Event bus
export { HarnessEventBus } from "./event-bus.js";
export type { HarnessEvents, EventListener } from "./event-bus.js";

// Hooks
export type { HarnessHooks } from "./hooks.js";

// Plugin interface
export type {
  HarnessPlugin,
  PluginContext,
  PluginLogger,
  PluginServices,
} from "./plugin.js";

// Registry
export { PluginRegistry } from "./registry.js";
export type { PluginRegistryOptions } from "./registry.js";

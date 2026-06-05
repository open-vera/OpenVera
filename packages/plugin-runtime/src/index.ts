export {
  RuntimeCapabilityRegistry,
  toDescriptor,
  toDescriptorWithHealth,
  CapabilityConflictError,
} from "./capability-registry.js";
export type {
  CapabilityConflict,
  CapabilityHealthResult,
  RuntimeCapability,
  RuntimeCapabilityInput,
  RuntimeCapabilityKind,
  RuntimeCapabilityStatus,
} from "./capability-registry.js";
export { definePlugin } from "./context.js";
export type {
  CapabilityProvider,
  PluginContextProviderContribution,
  PluginContext,
  PluginDefinition,
  PluginFileStore,
  PluginKvStore,
  PluginLlmAdapterContributionOptions,
  PluginModelProviderContributionOptions,
  PluginPromptBlockContribution,
  PluginToolContribution,
} from "./context.js";
export { DisposableStore } from "./disposable.js";
export type { Disposable, DisposableLike } from "./disposable.js";
export { EventBus, HookExecutionError } from "./event-bus.js";
export type {
  HookEvent,
  HookFailurePolicy,
  HookKind,
  HookRegistrar,
  HookRegistration,
  HookRegistrationOptions,
  HookRuntimeContext,
  InterceptHandled,
  InterceptHook,
  InterceptResult,
  ObserveHook,
  TransformHook,
} from "./event-bus.js";
export { PluginLockfileStore } from "./lockfile.js";
export type { PluginLockfile, PluginLockRecord } from "./lockfile.js";
export { PLUGIN_API_VERSION, validatePluginManifest } from "./manifest.js";
export type {
  DiscoveredPlugin,
  PluginManifest,
  PluginPermissionFs,
  PluginPermissionNetwork,
  PluginPermissions,
  PluginScope,
  PluginSource,
  PluginSourceType,
} from "./manifest.js";
export { PluginLoader } from "./plugin-loader.js";
export type { PluginLoaderOptions } from "./plugin-loader.js";
export { PluginHost } from "./plugin-host.js";
export type { PluginHostOptions, PluginRuntimeState, PluginRuntimeStatus } from "./plugin-host.js";
export { PolicyEngine } from "./policy-engine.js";
export type { PluginRiskDisclosure } from "./policy-engine.js";

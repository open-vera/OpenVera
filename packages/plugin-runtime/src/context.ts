import type { Logger } from "@open-vera/logger";
import type { CapabilityAction } from "@open-vera/shared";
import type { RuntimeCapabilityInput } from "./capability-registry.js";
import type { DisposableStore } from "./disposable.js";
import type { HookRegistrar } from "./event-bus.js";
import type { PluginPermissions } from "./manifest.js";
import type { PluginManifest, PluginScope } from "./manifest.js";

export interface PluginDefinition {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(ctx: PluginContext): void | Promise<void>;
}

export interface PluginContext {
  readonly pluginId: string;
  readonly scope: PluginScope;
  readonly manifest: PluginManifest;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly provide: CapabilityProvider;
  readonly hooks: HookRegistrar;
  readonly disposables: DisposableStore;
  readonly config: {
    get<T = unknown>(path?: string): T | undefined;
    watch<T = unknown>(path: string, fn: (value: T | undefined) => void): { dispose(): void };
  };
  readonly secrets: {
    get(name: string): Promise<string>;
  };
  readonly storage: {
    kv(namespace?: string): PluginKvStore;
    files(namespace?: string): PluginFileStore;
  };
}

export interface CapabilityProvider {
  register(input: Omit<RuntimeCapabilityInput, "ownerPluginId" | "scope">): void;
  tool(input: PluginToolContribution): void;
  llmAdapter(name: string, factory: unknown, options?: PluginLlmAdapterContributionOptions): void;
  modelProvider(name: string, provider: unknown, options?: PluginModelProviderContributionOptions): void;
  channelAdapter(name: string, factory: unknown, options: PluginChannelAdapterContributionOptions): void;
  promptBlock(input: PluginPromptBlockContribution): void;
  contextProvider(input: PluginContextProviderContribution): void;
}

export interface PluginToolContribution {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: unknown): unknown | Promise<unknown>;
  metadata?: Record<string, unknown>;
  permissions?: PluginPermissions;
  actions?: CapabilityAction[];
  status?: RuntimeCapabilityInput["status"];
  override?: boolean;
  options?: Record<string, unknown>;
  version?: unknown;
  group?: string;
}

export interface PluginLlmAdapterContributionOptions {
  displayName?: string;
  metadata?: Record<string, unknown>;
  permissions?: PluginPermissions;
  actions?: CapabilityAction[];
  status?: RuntimeCapabilityInput["status"];
  supportedPurposes?: string[];
  supportedModalities?: string[];
}

export interface PluginModelProviderContributionOptions {
  displayName?: string;
  metadata?: Record<string, unknown>;
  permissions?: PluginPermissions;
  actions?: CapabilityAction[];
  status?: RuntimeCapabilityInput["status"];
  models?: string[];
  defaultModel?: string;
}

export interface PluginChannelAdapterContributionOptions {
  channelType: string;
  displayName?: string;
  description?: string;
  version?: string;
  metadata?: Record<string, unknown>;
  permissions?: PluginPermissions;
  actions?: CapabilityAction[];
  status?: RuntimeCapabilityInput["status"];
}

export interface PluginPromptBlockContribution {
  id: string;
  content: string;
  priority?: number;
  metadata?: Record<string, unknown>;
  permissions?: PluginPermissions;
  actions?: CapabilityAction[];
  status?: RuntimeCapabilityInput["status"];
}

export interface PluginContextProviderContribution {
  id: string;
  content: string;
  priority?: number;
  tokenEstimate?: number;
  metadata?: Record<string, unknown>;
  permissions?: PluginPermissions;
  actions?: CapabilityAction[];
  status?: RuntimeCapabilityInput["status"];
}

export interface PluginKvStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface PluginFileStore {
  resolvePath(path: string): string;
}

export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition;
}

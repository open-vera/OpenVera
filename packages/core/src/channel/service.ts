import {
  EventBus,
  RuntimeCapabilityRegistry,
  type RuntimeCapability,
  type RuntimeCapabilityInput,
} from "@open-vera/plugin-runtime";
import type { CapabilityAction, CapabilityScope } from "@open-vera/shared";
import { ChannelGateway } from "./gateway.js";
import {
  ChannelPluginRegistry,
  type AdapterFactory,
  type ChannelPlugin,
  type LoadedAdapter,
} from "./plugin-registry.js";
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelType,
  GatewayEvent,
  GatewayConfig,
  SendMessageOptions,
} from "./types.js";

export interface ChannelServiceOptions {
  registry?: ChannelPluginRegistry;
  gateway?: ChannelGateway;
  eventBus?: EventBus;
  capabilities?: RuntimeCapabilityRegistry;
  gatewayConfig?: GatewayConfig;
  ownerPluginId?: string;
  source?: string;
}

export interface ChannelAdapterCapabilityInput {
  id: string;
  name?: string;
  description?: string;
  channelType: ChannelType;
  version?: string;
  factory: AdapterFactory;
  ownerPluginId?: string;
  scope?: CapabilityScope;
  source?: string;
  status?: RuntimeCapabilityInput["status"];
  metadata?: Record<string, unknown>;
  actions?: CapabilityAction[];
}

export interface ChannelInstanceRecord {
  instanceName: string;
  pluginName: string;
  adapter: ChannelAdapter;
  loadedAt: string;
  config: Record<string, unknown>;
}

export class ChannelService {
  readonly registry: ChannelPluginRegistry;
  readonly gateway: ChannelGateway;
  readonly eventBus: EventBus;
  readonly capabilities: RuntimeCapabilityRegistry;

  private readonly defaultOwnerPluginId: string;
  private readonly defaultSource: string;

  constructor(options: ChannelServiceOptions = {}) {
    this.registry = options.registry ?? new ChannelPluginRegistry();
    this.gateway = options.gateway ?? new ChannelGateway(options.gatewayConfig);
    this.eventBus = options.eventBus ?? new EventBus();
    this.capabilities = options.capabilities ?? new RuntimeCapabilityRegistry();
    this.defaultOwnerPluginId = options.ownerPluginId ?? "builtin-channel";
    this.defaultSource = options.source ?? "builtin:channel";
    this.gateway.onEvent((event) => {
      void this.forwardGatewayEvent(event);
    });
  }

  registerCapability(input: ChannelAdapterCapabilityInput): void {
    const ownerPluginId = input.ownerPluginId ?? this.defaultOwnerPluginId;
    const source = input.source ?? this.defaultSource;
    const scope = input.scope ?? "global";
    const plugin: ChannelPlugin = {
      meta: {
        name: input.id,
        description: input.description ?? input.name ?? input.id,
        channelType: input.channelType,
        version: input.version ?? "0.0.0",
      },
      factory: input.factory,
    };
    this.registry.registerPlugin(plugin);
    this.capabilities.register({
      id: input.id,
      kind: "channel-adapter",
      name: input.name ?? input.id,
      ownerPluginId,
      scope,
      source,
      status: input.status ?? "available",
      factory: input.factory,
      actions: input.actions ?? ["view", "test", "connect", "disconnect", "reload"],
      metadata: {
        ...input.metadata,
        description: plugin.meta.description,
        channelType: input.channelType,
        version: plugin.meta.version,
      },
    });
  }

  registerRuntimeCapability(capability: RuntimeCapability): void {
    if (capability.kind !== "channel-adapter") {
      throw new Error(`Unsupported channel capability kind: ${capability.kind}`);
    }
    const factory = capability.factory;
    if (typeof factory !== "function") {
      throw new Error(`Channel capability ${capability.id} does not provide an adapter factory`);
    }
    const channelType = typeof capability.metadata["channelType"] === "string"
      ? capability.metadata["channelType"] as ChannelType
      : "custom";
    this.registry.registerPlugin({
      meta: {
        name: capability.id,
        description: typeof capability.metadata["description"] === "string"
          ? capability.metadata["description"]
          : capability.name,
        channelType,
        version: typeof capability.metadata["version"] === "string"
          ? capability.metadata["version"]
          : "0.0.0",
      },
      factory: factory as AdapterFactory,
    });
    this.capabilities.register({
      id: capability.id,
      kind: "channel-adapter",
      name: capability.name,
      ownerPluginId: capability.ownerPluginId,
      scope: capability.scope,
      source: capability.source,
      status: capability.status,
      factory: capability.factory,
      permissions: capability.permissions,
      actions: capability.actions,
      metadata: capability.metadata,
      ...(capability.healthCheck ? { healthCheck: capability.healthCheck } : {}),
    });
  }

  async loadAdapter(
    pluginName: string,
    instanceName: string,
    config: Record<string, unknown> = {},
  ): Promise<ChannelAdapter> {
    try {
      this.ensureCapabilityAvailable(pluginName);
      const adapter = await this.registry.loadAdapter(pluginName, instanceName, config);
      this.gateway.addAdapter(instanceName, adapter);
      await this.eventBus.emitObserve(
        "channel:adapter:load",
        this.describeLoadedAdapter(instanceName),
        this.eventContext(instanceName, { pluginName }),
      );
      return adapter;
    } catch (error) {
      await this.emitError("channel:adapter:load", instanceName, error, { pluginName });
      throw error;
    }
  }

  async unloadAdapter(instanceName: string): Promise<ChannelAdapter | undefined> {
    const entry = this.registry.getLoadedAdapter(instanceName);
    try {
      this.gateway.removeAdapter(instanceName);
      const adapter = await this.registry.unloadAdapter(instanceName);
      if (entry || adapter) {
        await this.eventBus.emitObserve(
          "channel:disconnect",
          entry ? loadedAdapterDescriptor(instanceName, entry) : { instanceName },
          this.eventContext(instanceName, { pluginName: entry?.pluginName, reason: "unload" }),
        );
        await this.eventBus.emitObserve(
          "channel:adapter:unload",
          entry ? loadedAdapterDescriptor(instanceName, entry) : { instanceName },
          this.eventContext(instanceName, { pluginName: entry?.pluginName }),
        );
      }
      return adapter;
    } catch (error) {
      await this.emitError("channel:adapter:unload", instanceName, error, { pluginName: entry?.pluginName });
      throw error;
    }
  }

  async unloadAllByPlugin(pluginName: string): Promise<number> {
    let count = 0;
    for (const entry of this.registry.listLoadedAdapters()) {
      if (entry.pluginName === pluginName) {
        await this.unloadAdapter(entry.instanceName);
        count++;
      }
    }
    return count;
  }

  async connect(instanceName: string): Promise<void> {
    try {
      await this.gateway.connect(instanceName);
      await this.eventBus.emitObserve(
        "channel:connect",
        this.describeLoadedAdapter(instanceName),
        this.eventContext(instanceName),
      );
    } catch (error) {
      await this.emitError("channel:connect", instanceName, error);
      throw error;
    }
  }

  async disconnect(instanceName: string): Promise<void> {
    try {
      await this.gateway.disconnect(instanceName);
      await this.eventBus.emitObserve(
        "channel:disconnect",
        this.describeLoadedAdapter(instanceName),
        this.eventContext(instanceName),
      );
    } catch (error) {
      await this.emitError("channel:disconnect", instanceName, error);
      throw error;
    }
  }

  async sendMessage(instanceName: string, options: SendMessageOptions): Promise<ChannelMessage> {
    try {
      const message = await this.gateway.sendMessage(instanceName, options);
      await this.eventBus.emitObserve(
        "channel:message:send",
        { instance: this.describeLoadedAdapter(instanceName), message: serializeMessage(message) },
        this.eventContext(instanceName),
      );
      return message;
    } catch (error) {
      await this.emitError("channel:message:send", instanceName, error);
      throw error;
    }
  }

  listLoadedAdapters(): ChannelInstanceRecord[] {
    return this.registry.listLoadedAdapters();
  }

  private ensureCapabilityAvailable(pluginName: string): void {
    const capability = this.capabilities.get(pluginName);
    if (!capability) return;
    if (capability.status !== "available") {
      throw new Error(`Channel capability ${pluginName} is not available: ${capability.status}`);
    }
  }

  private describeLoadedAdapter(instanceName: string): Record<string, unknown> {
    const entry = this.registry.getLoadedAdapter(instanceName);
    if (!entry) return { instanceName };
    return loadedAdapterDescriptor(instanceName, entry);
  }

  private eventContext(instanceName: string, metadata: Record<string, unknown> = {}) {
    return {
      pluginId: "channel-service",
      metadata: {
        instanceName,
        ...metadata,
      },
    };
  }

  private async forwardGatewayEvent(event: GatewayEvent): Promise<void> {
    const eventName = eventNameForGatewayEvent(event);
    if (!eventName) return;
    const value = serializeGatewayEvent(event, this.describeLoadedAdapter(event.channelName));
    await this.eventBus.emitObserve(
      eventName,
      value,
      this.eventContext(event.channelName),
    );
  }

  private async emitError(
    phase: string,
    instanceName: string,
    error: unknown,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.eventBus.emitObserve(
      "channel:error",
      {
        phase,
        instance: this.describeLoadedAdapter(instanceName),
        error: error instanceof Error ? error.message : String(error),
      },
      this.eventContext(instanceName, metadata),
    );
  }
}

function loadedAdapterDescriptor(instanceName: string, entry: LoadedAdapter): Record<string, unknown> {
  return {
    instanceName,
    pluginName: entry.pluginName,
    loadedAt: entry.loadedAt,
    configKeys: Object.keys(entry.config),
    adapter: {
      name: entry.adapter.name,
      channelType: entry.adapter.channelType,
      state: entry.adapter.state,
      status: entry.adapter.getStatus(),
    },
  };
}

function serializeMessage(message: ChannelMessage): Record<string, unknown> {
  return {
    id: message.id,
    channelType: message.channelType,
    senderId: message.senderId,
    senderName: message.senderName,
    contentLength: message.content.length,
    attachmentCount: message.attachments.length,
    replyTo: message.replyTo,
    timestamp: message.timestamp,
  };
}

function eventNameForGatewayEvent(event: GatewayEvent): string | null {
  switch (event.type) {
    case "message_received":
      return "channel:message:receive";
    case "channel_error":
      return "channel:error";
    default:
      return null;
  }
}

function serializeGatewayEvent(event: GatewayEvent, instance: Record<string, unknown>): Record<string, unknown> {
  if (event.type === "message_received") {
    return {
      instance,
      message: serializeMessage(event.message),
    };
  }
  if (event.type === "channel_error") {
    return {
      phase: "gateway",
      instance,
      error: event.error,
    };
  }
  return { instance };
}

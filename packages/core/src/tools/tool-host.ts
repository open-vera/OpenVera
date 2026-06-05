import {
  EventBus,
  PluginHost,
  RuntimeCapabilityRegistry,
  type RuntimeCapability,
  type RuntimeCapabilityInput,
  type PluginRuntimeState,
  type RuntimeCapabilityStatus,
} from "@open-vera/plugin-runtime";
import type { CapabilityAction, CapabilityScope } from "@open-vera/shared";
import type { Tool } from "../types/tool.js";
import { ToolRegistry } from "./registry.js";
import type { JSONSchema, ToolContext, ToolDef, ToolResult, ToolVersion } from "./types.js";

export interface ToolCallEvent {
  name: string;
  args: Record<string, unknown>;
  ctx: ToolContext;
}

export type ToolAuditSource = "preflight" | "guardrail" | "event-intercept" | "registry";

export interface ToolGuardrail {
  name: string;
  evaluateToolCall?(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult | null>;
}

export interface ToolAuditSink {
  name: string;
  onToolResult?(event: {
    name: string;
    args: Record<string, unknown>;
    ctx: ToolContext;
    result: ToolResult;
    source: ToolAuditSource;
  }): Promise<void>;
  onToolError?(event: {
    name: string;
    args: Record<string, unknown>;
    ctx: ToolContext;
    error: unknown;
  }): Promise<void>;
}

export interface ToolHostOptions {
  registry?: ToolRegistry;
  eventBus?: EventBus;
  capabilities?: RuntimeCapabilityRegistry;
  ownerPluginId?: string;
  source?: string;
  adoptRegistryTools?: boolean;
  guardrails?: ToolGuardrail[];
  auditSinks?: ToolAuditSink[];
}

export interface PluginToolLoadResult {
  pluginHost: PluginHost;
  states: PluginRuntimeState[];
  registeredToolIds: string[];
}

export interface ToolCapabilityInput {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  ownerPluginId?: string;
  scope?: CapabilityScope;
  source?: string;
  status?: RuntimeCapabilityInput["status"];
  metadata?: Record<string, unknown>;
  permissions?: RuntimeCapabilityInput["permissions"];
  actions?: CapabilityAction[];
  options?: ToolDef["options"];
  version?: ToolVersion;
  group?: string;
  override?: boolean;
}

export class ToolHost {
  readonly registry: ToolRegistry;
  readonly eventBus: EventBus;
  readonly capabilities: RuntimeCapabilityRegistry;

  private readonly defaultOwnerPluginId: string;
  private readonly defaultSource: string;
  private readonly guardrails: ToolGuardrail[] = [];
  private readonly auditSinks: ToolAuditSink[] = [];

  constructor(options: ToolHostOptions = {}) {
    this.registry = options.registry ?? new ToolRegistry();
    this.eventBus = options.eventBus ?? new EventBus();
    this.capabilities = options.capabilities ?? new RuntimeCapabilityRegistry();
    this.defaultOwnerPluginId = options.ownerPluginId ?? "builtin-tools";
    this.defaultSource = options.source ?? "builtin:tools";
    this.guardrails.push(...(options.guardrails ?? []));
    this.auditSinks.push(...(options.auditSinks ?? []));

    if (options.adoptRegistryTools !== false) {
      this.adoptRegistryTools();
    }
  }

  getSchemas(): Tool[] {
    const availableToolIds = new Set(
      this.capabilities
        .list("tool")
        .filter((capability) => capability.status === "available")
        .map((capability) => capability.id),
    );
    return this.registry
      .getSchemas()
      .filter((schema) => availableToolIds.has(schema.name));
  }

  registerCapability(input: ToolCapabilityInput | ToolDef): void {
    const tool = normalizeToolDef(input);
    const ownerPluginId = "ownerPluginId" in input && input.ownerPluginId
      ? input.ownerPluginId
      : this.defaultOwnerPluginId;
    const scope = "scope" in input && input.scope ? input.scope : "global";
    const source = "source" in input && input.source ? input.source : this.defaultSource;
    const metadata = "metadata" in input && input.metadata ? input.metadata : {};
    const permissions = "permissions" in input ? input.permissions : undefined;
    const actions: CapabilityAction[] = "actions" in input && input.actions ? input.actions : ["view", "test"];
    const status = "status" in input && input.status ? input.status : "available";

    const registered = this.capabilities.register({
      id: tool.name,
      kind: "tool",
      name: tool.name,
      ownerPluginId,
      scope,
      status,
      source,
      factory: tool,
      permissions,
      actions,
      metadata: {
        ...metadata,
        ...("override" in input && input.override ? { override: true } : {}),
        description: tool.description,
        parameters: tool.parameters,
        options: tool.options ?? {},
        version: tool.version,
        group: tool.group,
      },
    });
    if (registered.id === tool.name && registered.status === status) {
      this.registry.register(tool);
    }
  }

  registerRuntimeCapability(capability: RuntimeCapability): void {
    if (capability.kind !== "tool") {
      throw new Error(`Unsupported tool capability kind: ${capability.kind}`);
    }

    const tool = runtimeCapabilityToToolDef(capability);
    const registered = this.capabilities.register({
      id: capability.id,
      kind: "tool",
      name: capability.name,
      ownerPluginId: capability.ownerPluginId,
      scope: capability.scope,
      status: capability.status,
      source: capability.source,
      factory: tool,
      permissions: capability.permissions,
      actions: capability.actions,
      metadata: {
        ...capability.metadata,
        description: tool.description,
        parameters: tool.parameters,
        options: tool.options ?? {},
        version: tool.version,
        group: tool.group,
      },
    });
    if (registered.id === capability.id && registered.status === capability.status) {
      this.registry.register(tool);
    }
  }

  useGuardrail(guardrail: ToolGuardrail): void {
    this.guardrails.push(guardrail);
  }

  addAuditSink(sink: ToolAuditSink): void {
    this.auditSinks.push(sink);
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const readiness = this.checkCapabilityReadiness(name);
    if (readiness) {
      await this.emitAuditResult(name, args, ctx, readiness, "preflight");
      return readiness;
    }

    const hookCtx = {
      pluginId: "tool-host",
      sessionId: ctx.sessionId,
      signal: ctx.signal,
      metadata: { toolName: name },
    };

    try {
      for (const guardrail of this.guardrails) {
        const result = await guardrail.evaluateToolCall?.(name, args, ctx);
        if (result) {
          await this.emitAuditResult(name, args, ctx, result, "guardrail");
          return result;
        }
      }

      const before = await this.eventBus.emitIntercept<ToolCallEvent, ToolResult>(
        `tool:before:${name}`,
        { name, args, ctx },
        hookCtx,
      );

      if (before.handled) {
        await this.emitAuditResult(name, args, ctx, before.result, "event-intercept");
        return before.result;
      }

      const call = before.value;
      let result = await this.registry.execute(call.name, call.args, call.ctx);
      result = await this.eventBus.emitTransform<ToolResult>(
        `tool:after:${call.name}`,
        result,
        {
          ...hookCtx,
          metadata: { toolName: call.name, args: call.args },
        },
      );
      await this.eventBus.emitObserve(
        `tool:after:${call.name}`,
        result,
        {
          ...hookCtx,
          metadata: { toolName: call.name, args: call.args },
        },
      );
      await this.emitAuditResult(call.name, call.args, call.ctx, result, "registry");
      return result;
    } catch (error) {
      await this.eventBus.emitObserve(
        `tool:error:${name}`,
        { name, args, error, ctx },
        hookCtx,
      );
      await this.emitAuditError(name, args, ctx, error);
      throw error;
    }
  }

  private async emitAuditResult(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
    result: ToolResult,
    source: ToolAuditSource,
  ): Promise<void> {
    await Promise.all(this.auditSinks.map(async (sink) => {
      try {
        await sink.onToolResult?.({ name, args, ctx, result, source });
      } catch {
        // Audit sinks are observational; failures must not affect tool execution.
      }
    }));
  }

  private async emitAuditError(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
    error: unknown,
  ): Promise<void> {
    await Promise.all(this.auditSinks.map(async (sink) => {
      try {
        await sink.onToolError?.({ name, args, ctx, error });
      } catch {
        // Audit sinks are observational; failures must not affect tool execution.
      }
    }));
  }

  private checkCapabilityReadiness(name: string): ToolResult | null {
    const capability = this.capabilities.get(name);
    if (!capability) {
      return null;
    }
    if (capability.status === "available") {
      return null;
    }
    return unavailableToolResult(name, capability.status);
  }

  private adoptRegistryTools(): void {
    for (const tool of this.registry.list()) {
      if (this.capabilities.get(tool.name)) continue;
      this.capabilities.register({
        id: tool.name,
        kind: "tool",
        name: tool.name,
        ownerPluginId: this.defaultOwnerPluginId,
        scope: "global",
        source: this.defaultSource,
        factory: tool,
        actions: ["view", "test"],
        metadata: {
          description: tool.description,
          parameters: tool.parameters,
          options: tool.options ?? {},
          version: tool.version,
          group: tool.group,
        },
      });
    }
  }
}

function unavailableToolResult(name: string, status: RuntimeCapabilityStatus): ToolResult {
  return {
    ok: false,
    content: `Tool "${name}" is not available: capability status is ${status}`,
    error: {
      code: status === "disabled" ? "PERMISSION_DENIED" : "UNKNOWN",
      message: `Tool capability status is ${status}`,
      retryable: status === "error",
    },
  };
}

export async function loadEnabledPluginTools(
  toolHost: ToolHost,
  rootDir: string,
): Promise<PluginToolLoadResult> {
  const pluginHost = new PluginHost({
    rootDir,
    eventBus: toolHost.eventBus,
    capabilities: new RuntimeCapabilityRegistry(),
  });
  const states = await pluginHost.activateEnabledFromLockfile();
  const registeredToolIds: string[] = [];

  for (const capability of pluginHost.capabilities.list("tool")) {
    if (capability.status !== "available") continue;
    toolHost.registerRuntimeCapability(capability);
    registeredToolIds.push(capability.id);
  }

  return { pluginHost, states, registeredToolIds };
}

export class ToolRegistryAdapter extends ToolHost {
  constructor(registry: ToolRegistry, options: Omit<ToolHostOptions, "registry"> = {}) {
    super({ ...options, registry });
  }
}

function normalizeToolDef(input: ToolCapabilityInput | ToolDef): ToolDef<Record<string, unknown>> {
  return {
    name: input.name,
    description: input.description,
    parameters: input.parameters,
    execute: (args, ctx) => input.execute(args, ctx),
    ...("options" in input && input.options ? { options: input.options } : {}),
    ...("version" in input && input.version ? { version: input.version } : {}),
    ...("group" in input && input.group ? { group: input.group } : {}),
  };
}

function runtimeCapabilityToToolDef(capability: RuntimeCapability): ToolDef<Record<string, unknown>> {
  const metadata = capability.metadata;
  const description = typeof metadata["description"] === "string"
    ? metadata["description"]
    : capability.name;
  const parameters = isJsonSchema(metadata["parameters"])
    ? metadata["parameters"]
    : { type: "object", properties: {} };
  const options = isRecord(metadata["options"])
    ? metadata["options"] as ToolDef["options"]
    : undefined;
  const version = isToolVersion(metadata["version"])
    ? metadata["version"]
    : undefined;
  const group = typeof metadata["group"] === "string" ? metadata["group"] : undefined;
  const executor = capability.factory;

  return {
    name: capability.id,
    description,
    parameters,
    ...(options ? { options } : {}),
    ...(version ? { version } : {}),
    ...(group ? { group } : {}),
    execute: async (args, ctx) => {
      if (isToolDef(executor)) {
        return executor.execute(args, ctx);
      }
      if (typeof executor === "function") {
        return await executor(args, ctx) as ToolResult;
      }
      throw new Error(`Tool capability ${capability.id} does not provide an executable factory`);
    },
  };
}

function isToolDef(value: unknown): value is ToolDef<Record<string, unknown>> {
  return isRecord(value)
    && typeof value["name"] === "string"
    && typeof value["description"] === "string"
    && isJsonSchema(value["parameters"])
    && typeof value["execute"] === "function";
}

function isJsonSchema(value: unknown): value is JSONSchema {
  return isRecord(value);
}

function isToolVersion(value: unknown): value is ToolVersion {
  return isRecord(value) && typeof value["version"] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

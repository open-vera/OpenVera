import type {
  CapabilityAction,
  CapabilityDescriptor,
  CapabilityKind,
  CapabilityScope,
  CapabilityStatus,
} from "@open-vera/shared";
import type { PluginPermissions } from "./manifest.js";

export type RuntimeCapabilityStatus = CapabilityStatus | "shadow";

export type RuntimeCapabilityKind =
  | CapabilityKind
  | "llm-adapter"
  | "model-provider"
  | "model-alias"
  | "channel-adapter"
  | "strategy";

export interface CapabilityHealthResult {
  ok: boolean;
  message?: string;
  checkedAt?: string;
}

export interface RuntimeCapability<TFactory = unknown> {
  id: string;
  kind: RuntimeCapabilityKind;
  name: string;
  ownerPluginId: string;
  scope: CapabilityScope;
  status: RuntimeCapabilityStatus;
  source: string;
  projectId?: string;
  configPath?: string;
  factory?: TFactory;
  metadata: Record<string, unknown>;
  permissions?: PluginPermissions;
  actions: CapabilityAction[];
  healthCheck?: () => Promise<CapabilityHealthResult> | CapabilityHealthResult;
}

export interface RuntimeCapabilityInput<TFactory = unknown> {
  id: string;
  kind: RuntimeCapabilityKind;
  name?: string;
  ownerPluginId: string;
  scope: CapabilityScope;
  status?: RuntimeCapabilityStatus;
  source?: string;
  projectId?: string;
  configPath?: string;
  factory?: TFactory;
  metadata?: Record<string, unknown>;
  permissions?: PluginPermissions;
  actions?: CapabilityAction[];
  healthCheck?: () => Promise<CapabilityHealthResult> | CapabilityHealthResult;
}

export interface CapabilityConflict {
  requested: RuntimeCapability;
  existing: RuntimeCapability;
  resolution: "rejected" | "shadowed-existing" | "shadowed-requested" | "replaced";
}

export class CapabilityConflictError extends Error {
  readonly conflict: CapabilityConflict;

  constructor(conflict: CapabilityConflict) {
    super(`Capability conflict for ${conflict.requested.kind}:${conflict.requested.id}`);
    this.name = "CapabilityConflictError";
    this.conflict = conflict;
  }
}

export class RuntimeCapabilityRegistry {
  private readonly capabilities = new Map<string, RuntimeCapability>();
  private readonly conflicts: CapabilityConflict[] = [];

  register(input: RuntimeCapabilityInput): RuntimeCapability {
    const capability = normalizeCapability(input);
    const existing = this.capabilities.get(capability.id);
    if (!existing) {
      this.capabilities.set(capability.id, capability);
      return capability;
    }

    const resolution = resolveConflict(existing, capability);
    this.conflicts.push({ existing, requested: capability, resolution });

    if (resolution === "rejected") {
      throw new CapabilityConflictError({ existing, requested: capability, resolution });
    }

    if (resolution === "shadowed-requested") {
      const shadowed = { ...capability, status: "shadow" as const };
      this.capabilities.set(`${capability.id}#shadow:${capability.ownerPluginId}`, shadowed);
      return shadowed;
    }

    if (resolution === "shadowed-existing") {
      this.capabilities.set(`${existing.id}#shadow:${existing.ownerPluginId}`, {
        ...existing,
        status: "shadow",
        metadata: {
          ...existing.metadata,
          shadowedBy: capability.ownerPluginId,
          shadowReason: "higher-priority-capability",
        },
      });
      this.capabilities.set(capability.id, capability);
      return capability;
    }

    const replaced = {
      ...capability,
      metadata: {
        ...capability.metadata,
        override: true,
        overridesCapability: {
          id: existing.id,
          kind: existing.kind,
          ownerPluginId: existing.ownerPluginId,
          source: existing.source,
        },
      },
    };
    this.capabilities.set(`${existing.id}#shadow:${existing.ownerPluginId}`, {
      ...existing,
      status: "shadow",
      metadata: {
        ...existing.metadata,
        shadowedBy: capability.ownerPluginId,
        shadowReason: "explicit-override",
      },
    });
    this.capabilities.set(capability.id, replaced);
    return replaced;
  }

  get(id: string): RuntimeCapability | undefined {
    return this.capabilities.get(id);
  }

  list(kind?: RuntimeCapabilityKind): RuntimeCapability[] {
    const capabilities = [...this.capabilities.values()];
    return kind ? capabilities.filter((capability) => capability.kind === kind) : capabilities;
  }

  listDescriptors(kind?: RuntimeCapabilityKind): CapabilityDescriptor[] {
    return this.list(kind).map(toDescriptor);
  }

  async listDescriptorsWithHealth(kind?: RuntimeCapabilityKind): Promise<CapabilityDescriptor[]> {
    return Promise.all(this.list(kind).map(toDescriptorWithHealth));
  }

  removeByPlugin(ownerPluginId: string): void {
    for (const [id, capability] of this.capabilities) {
      if (capability.ownerPluginId === ownerPluginId) {
        this.capabilities.delete(id);
      }
    }
  }

  setStatus(id: string, status: RuntimeCapabilityStatus): RuntimeCapability | undefined {
    const capability = this.capabilities.get(id);
    if (!capability) return undefined;
    const updated = { ...capability, status };
    this.capabilities.set(id, updated);
    return updated;
  }

  getConflicts(): CapabilityConflict[] {
    return [...this.conflicts];
  }
}

export function toDescriptor(capability: RuntimeCapability): CapabilityDescriptor {
  return {
    id: capability.id,
    kind: toGatewayKind(capability.kind),
    name: capability.name,
    status: capability.status as CapabilityDescriptor["status"],
    scope: capability.scope,
    source: capability.source,
    ...(capability.projectId ? { projectId: capability.projectId } : {}),
    ...(capability.configPath ? { configPath: capability.configPath } : {}),
    actions: capability.actions,
    metadata: {
      ...capability.metadata,
      ownerPluginId: capability.ownerPluginId,
      runtimeKind: capability.kind,
      permissions: capability.permissions ?? {},
    },
  };
}

export async function toDescriptorWithHealth(capability: RuntimeCapability): Promise<CapabilityDescriptor> {
  const descriptor = toDescriptor(capability);
  if (!capability.healthCheck) {
    return descriptor;
  }

  const checkedAt = new Date().toISOString();
  try {
    const health = await capability.healthCheck();
    const normalized = {
      ok: health.ok,
      message: health.message,
      checkedAt: health.checkedAt ?? checkedAt,
    };
    return {
      ...descriptor,
      status: normalized.ok ? descriptor.status : "error",
      health: normalized,
    };
  } catch (error) {
    return {
      ...descriptor,
      status: "error",
      health: {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        checkedAt,
      },
    };
  }
}

function normalizeCapability(input: RuntimeCapabilityInput): RuntimeCapability {
  return {
    id: input.id,
    kind: input.kind,
    name: input.name ?? input.id,
    ownerPluginId: input.ownerPluginId,
    scope: input.scope,
    status: input.status ?? "available",
    source: input.source ?? `plugin:${input.ownerPluginId}`,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.configPath ? { configPath: input.configPath } : {}),
    ...(input.factory !== undefined ? { factory: input.factory } : {}),
    metadata: input.metadata ?? {},
    ...(input.permissions ? { permissions: input.permissions } : {}),
    actions: input.actions ?? ["view"],
    ...(input.healthCheck ? { healthCheck: input.healthCheck } : {}),
  };
}

function resolveConflict(existing: RuntimeCapability, requested: RuntimeCapability): CapabilityConflict["resolution"] {
  if (existing.kind === "tool" || requested.kind === "tool") {
    if (existing.kind === "tool" && requested.kind === "tool" && hasExplicitOverride(requested)) {
      return "replaced";
    }
    return "rejected";
  }

  if (existing.kind === "model-alias" || requested.kind === "model-alias") {
    return rankScope(requested.scope) > rankScope(existing.scope)
      ? "shadowed-existing"
      : "shadowed-requested";
  }

  return "shadowed-requested";
}

function hasExplicitOverride(capability: RuntimeCapability): boolean {
  return capability.metadata["override"] === true;
}

function rankScope(scope: CapabilityScope): number {
  switch (scope) {
    case "project":
      return 4;
    case "session":
      return 3;
    case "global":
      return 2;
    case "run":
      return 1;
    default:
      return 0;
  }
}

function toGatewayKind(kind: RuntimeCapabilityKind): CapabilityKind {
  if (kind === "llm-adapter") return "provider";
  if (kind === "model-provider") return "provider";
  if (kind === "model-alias") return "model";
  if (kind === "channel-adapter") return "channel";
  if (kind === "strategy") return "flow";
  return kind;
}

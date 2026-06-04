import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  CapabilityDescriptor,
  CapabilityHealth,
  CapabilityKind,
  GatewayProject,
} from "@open-vera/shared";

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, CapabilityDescriptor>();

  register(capability: CapabilityDescriptor): void {
    this.capabilities.set(capability.id, capability);
  }

  registerMany(capabilities: CapabilityDescriptor[]): void {
    for (const capability of capabilities) {
      this.register(capability);
    }
  }

  remove(id: string): boolean {
    return this.capabilities.delete(id);
  }

  get(id: string): CapabilityDescriptor | undefined {
    return this.capabilities.get(id);
  }

  list(kind?: CapabilityKind): CapabilityDescriptor[] {
    const capabilities = Array.from(this.capabilities.values());
    return kind ? capabilities.filter((capability) => capability.kind === kind) : capabilities;
  }

  listByProject(projectId: string): CapabilityDescriptor[] {
    return this.list().filter((capability) => capability.projectId === projectId);
  }

  updateHealth(id: string, health: CapabilityHealth): CapabilityDescriptor | undefined {
    const capability = this.capabilities.get(id);
    if (!capability) return undefined;
    const updated: CapabilityDescriptor = {
      ...capability,
      status: health.ok ? "available" : "error",
      health,
    };
    this.capabilities.set(id, updated);
    return updated;
  }
}

export function createProjectCapabilityInventory(project: GatewayProject): CapabilityDescriptor[] {
  const at = new Date().toISOString();
  const capability = (
    kind: CapabilityKind,
    name: string,
    relativePath: string,
    actions: CapabilityDescriptor["actions"],
    metadata: Record<string, unknown> = {},
  ): CapabilityDescriptor => {
    const source = join(project.rootDir, relativePath);
    const available = existsSync(source);
    return {
      id: `${project.id}:${kind}:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      kind,
      name,
      status: available ? "available" : "unknown",
      scope: "project",
      source,
      projectId: project.id,
      configPath: relativePath,
      health: {
        ok: available,
        message: available ? "Resource found" : "Resource not found yet",
        checkedAt: at,
      },
      actions,
      metadata,
    };
  };

  return [
    capability("config", "Vera config", ".vera/settings.json", ["view", "edit", "test"], {
      redacted: true,
    }),
    capability("prompt", "Workspace prompt", "CLAUDE.md", ["view", "edit", "reload"]),
    capability("context", "Project context", ".vera/context", ["view", "reload"]),
    capability("memory", "Project memory", ".vera/memory", ["view", "edit", "reload"]),
    capability("rag", "RAG index", ".vera/rag", ["view", "reindex", "test"]),
    capability("skill", "Project skills", ".claude/skills", ["view", "edit", "reload"]),
    capability("plugin", "Plugin registry", ".vera/plugins", ["view", "enable", "disable", "reload"]),
    capability("mcp", "MCP servers", ".cursor/projects", ["view", "test", "reload"]),
    capability("channel", "Channels", ".vera/channels", ["view", "connect", "disconnect", "test"]),
    capability("sandbox", "Sandbox providers", ".vera/sandbox", ["view", "test"]),
    capability("flow", "Flows", ".vera/flows", ["view", "edit", "reload"]),
    capability("conversation", "Conversations", ".vera/conversations", ["view", "edit"]),
    capability("tool", "Tool policies", ".vera/permissions.json", ["view", "edit", "reload"]),
    capability("log", "Runtime logs", ".vera/logs", ["view"]),
    capability("cost", "Cost management", ".vera/cost", ["view", "test"], {
      currency: "USD",
    }),
  ];
}

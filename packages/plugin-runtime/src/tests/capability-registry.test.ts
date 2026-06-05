import { describe, expect, it } from "vitest";
import { CapabilityConflictError, RuntimeCapabilityRegistry } from "../capability-registry.js";

describe("RuntimeCapabilityRegistry", () => {
  it("keeps factories out of Gateway descriptors", () => {
    const registry = new RuntimeCapabilityRegistry();
    registry.register({
      id: "fixture_echo",
      kind: "tool",
      name: "Fixture Echo",
      ownerPluginId: "com.example.fixture",
      scope: "project",
      factory: () => undefined,
      metadata: { ok: true },
    });

    const descriptorJson = JSON.stringify(registry.listDescriptors()[0]);
    expect(descriptorJson).not.toContain("factory");
    expect(JSON.parse(descriptorJson)).toMatchObject({
      id: "fixture_echo",
      kind: "tool",
      status: "available",
      metadata: {
        ownerPluginId: "com.example.fixture",
      },
    });
  });

  it("rejects duplicate tool ids", () => {
    const registry = new RuntimeCapabilityRegistry();
    registry.register({
      id: "read_file",
      kind: "tool",
      ownerPluginId: "builtin",
      scope: "global",
    });

    expect(() =>
      registry.register({
        id: "read_file",
        kind: "tool",
        ownerPluginId: "third-party",
        scope: "project",
      }),
    ).toThrow(CapabilityConflictError);
  });

  it("allows explicit tool override and shadows the overridden capability", () => {
    const registry = new RuntimeCapabilityRegistry();
    registry.register({
      id: "read_file",
      kind: "tool",
      ownerPluginId: "builtin-tools-fs",
      scope: "global",
      source: "builtin:tool-plugin/builtin-tools-fs",
      factory: () => "builtin",
    });

    const active = registry.register({
      id: "read_file",
      kind: "tool",
      ownerPluginId: "com.example.override",
      scope: "project",
      source: "plugin:com.example.override",
      factory: () => "override",
      metadata: { override: true, reason: "project policy" },
    });

    expect(active).toMatchObject({
      id: "read_file",
      kind: "tool",
      ownerPluginId: "com.example.override",
      status: "available",
      metadata: {
        override: true,
        reason: "project policy",
        overridesCapability: {
          id: "read_file",
          kind: "tool",
          ownerPluginId: "builtin-tools-fs",
          source: "builtin:tool-plugin/builtin-tools-fs",
        },
      },
    });
    expect(registry.get("read_file")?.ownerPluginId).toBe("com.example.override");
    expect(registry.list("tool")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ownerPluginId: "builtin-tools-fs",
        status: "shadow",
        metadata: expect.objectContaining({ shadowReason: "explicit-override" }),
      }),
      expect.objectContaining({
        ownerPluginId: "com.example.override",
        status: "available",
      }),
    ]));
    expect(registry.getConflicts()).toHaveLength(1);
    expect(registry.getConflicts()[0]).toMatchObject({
      resolution: "replaced",
      existing: { ownerPluginId: "builtin-tools-fs" },
      requested: { ownerPluginId: "com.example.override" },
    });
    expect(registry.listDescriptors("tool").find((descriptor) => descriptor.id === "read_file"))
      .toMatchObject({
        metadata: {
          ownerPluginId: "com.example.override",
          override: true,
          overridesCapability: {
            ownerPluginId: "builtin-tools-fs",
          },
        },
      });
  });

  it("shadows lower-ranked model aliases", () => {
    const registry = new RuntimeCapabilityRegistry();
    registry.register({
      id: "fast",
      kind: "model-alias",
      ownerPluginId: "builtin",
      scope: "global",
    });
    const active = registry.register({
      id: "fast",
      kind: "model-alias",
      ownerPluginId: "project-plugin",
      scope: "project",
    });

    expect(active.status).toBe("available");
    expect(registry.list("model-alias").map((capability) => capability.status).sort()).toEqual([
      "available",
      "shadow",
    ]);
    expect(registry.listDescriptors("model-alias").map((descriptor) => descriptor.kind)).toEqual([
      "model",
      "model",
    ]);
  });

  it("maps provider runtime kinds to provider descriptors", () => {
    const registry = new RuntimeCapabilityRegistry();
    registry.register({
      id: "openai-compatible",
      kind: "llm-adapter",
      ownerPluginId: "provider-plugin",
      scope: "project",
      factory: () => undefined,
    });
    registry.register({
      id: "local-provider",
      kind: "model-provider",
      ownerPluginId: "provider-plugin",
      scope: "project",
      factory: {},
    });

    expect(registry.listDescriptors().map((descriptor) => [descriptor.id, descriptor.kind])).toEqual([
      ["openai-compatible", "provider"],
      ["local-provider", "provider"],
    ]);
    expect(JSON.stringify(registry.listDescriptors())).not.toContain("factory");
  });

  it("serializes health checks without exposing runtime objects", async () => {
    const registry = new RuntimeCapabilityRegistry();
    registry.register({
      id: "healthy_tool",
      kind: "tool",
      ownerPluginId: "com.example.fixture",
      scope: "project",
      factory: () => undefined,
      healthCheck: () => ({ ok: true, message: "ready" }),
    });
    registry.register({
      id: "failing_tool",
      kind: "tool",
      ownerPluginId: "com.example.fixture",
      scope: "project",
      healthCheck: () => {
        throw new Error("offline");
      },
    });

    const descriptors = await registry.listDescriptorsWithHealth();

    expect(descriptors.find((descriptor) => descriptor.id === "healthy_tool")).toMatchObject({
      status: "available",
      health: {
        ok: true,
        message: "ready",
      },
    });
    expect(descriptors.find((descriptor) => descriptor.id === "failing_tool")).toMatchObject({
      status: "error",
      health: {
        ok: false,
        message: "offline",
      },
    });
    expect(JSON.stringify(descriptors)).not.toContain("factory");
  });
});

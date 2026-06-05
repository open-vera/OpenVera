import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCapabilityRegistry } from "@open-vera/plugin-runtime";
import { describe, expect, it } from "vitest";
import { CapabilityRegistry, createProjectCapabilityInventory } from "../capability-registry.js";
import { DoctorService } from "../doctor.js";
import { createProject, ProjectRegistry } from "../project-registry.js";

describe("ProjectRegistry", () => {
  it("discovers explicit project roots", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-gateway-"));
    mkdirSync(join(root, ".vera", "flows"), { recursive: true });

    const registry = new ProjectRegistry({ roots: [root] });
    const projects = registry.discover();

    expect(projects).toHaveLength(1);
    expect(projects[0]?.rootDir).toBe(root);
    expect(projects[0]?.source).toBe("explicit");
  });

  it("discovers child projects when enabled", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-gateway-"));
    const child = join(root, "child-project");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, "package.json"), "{}");

    const registry = new ProjectRegistry({ roots: [root] });
    const projects = registry.discover();

    expect(projects.map((project) => project.rootDir)).toContain(child);
  });
});

describe("CapabilityRegistry", () => {
  it("registers project capabilities and filters by kind", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-gateway-"));
    mkdirSync(join(root, ".vera", "flows"), { recursive: true });
    const project = createProject(root);

    const registry = new CapabilityRegistry();
    registry.registerMany(createProjectCapabilityInventory(project));

    expect(registry.listByProject(project.id)).toHaveLength(15);
    expect(registry.list("flow")[0]?.status).toBe("available");
    expect(registry.list("rag")[0]?.status).toBe("unknown");
  });

  it("registers runtime plugin capability descriptors", () => {
    const registry = new CapabilityRegistry();
    const runtimeCapabilities = new RuntimeCapabilityRegistry();
    runtimeCapabilities.register({
      id: "fixture_echo",
      kind: "tool",
      name: "Fixture Echo",
      ownerPluginId: "com.example.basic",
      scope: "project",
      factory: () => undefined,
      metadata: { fixture: true },
    });

    registry.registerRuntimeCapabilities({ capabilities: runtimeCapabilities });

    expect(registry.get("fixture_echo")).toMatchObject({
      id: "fixture_echo",
      kind: "tool",
      status: "available",
      metadata: {
        ownerPluginId: "com.example.basic",
        fixture: true,
      },
    });
    expect(JSON.stringify(registry.get("fixture_echo"))).not.toContain("factory");
  });

  it("registers runtime plugin health without exposing factories", async () => {
    const registry = new CapabilityRegistry();
    const runtimeCapabilities = new RuntimeCapabilityRegistry();
    runtimeCapabilities.register({
      id: "healthy_runtime_tool",
      kind: "tool",
      ownerPluginId: "com.example.basic",
      scope: "project",
      factory: () => undefined,
      healthCheck: () => ({ ok: true, message: "ready" }),
    });
    runtimeCapabilities.register({
      id: "broken_runtime_tool",
      kind: "tool",
      ownerPluginId: "com.example.basic",
      scope: "project",
      healthCheck: () => {
        throw new Error("health failed");
      },
    });

    await registry.registerRuntimeCapabilitiesWithHealth({ capabilities: runtimeCapabilities });

    expect(registry.get("healthy_runtime_tool")).toMatchObject({
      status: "available",
      health: {
        ok: true,
        message: "ready",
      },
    });
    expect(registry.get("broken_runtime_tool")).toMatchObject({
      status: "error",
      health: {
        ok: false,
        message: "health failed",
      },
    });
    expect(JSON.stringify(registry.list())).not.toContain("factory");
  });
});

describe("DoctorService", () => {
  it("reports discovered projects and capability warnings", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-gateway-"));
    mkdirSync(join(root, ".vera", "flows"), { recursive: true });
    const project = createProject(root);
    const capabilities = createProjectCapabilityInventory(project);

    const report = new DoctorService({ projects: [project], capabilities }).run();

    expect(report.status).toBe("warn");
    expect(report.checks.some((check) => check.id === "gateway:project-registry")).toBe(true);
    expect(report.checks.some((check) => check.capabilityId?.includes(":rag:"))).toBe(true);
  });
});

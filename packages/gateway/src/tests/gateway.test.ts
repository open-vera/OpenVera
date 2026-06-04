import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

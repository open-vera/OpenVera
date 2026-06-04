import { existsSync } from "node:fs";
import type { CapabilityDescriptor, DoctorCheck, DoctorReport, DoctorStatus, GatewayProject } from "@open-vera/shared";

export interface DoctorServiceOptions {
  projects: GatewayProject[];
  capabilities: CapabilityDescriptor[];
}

export class DoctorService {
  constructor(private readonly options: DoctorServiceOptions) {}

  run(): DoctorReport {
    const checks = [
      this.checkProjectRegistry(),
      ...this.options.projects.flatMap((project) => this.checkProject(project)),
      ...this.options.capabilities.map((capability) => this.checkCapability(capability)),
    ];

    return {
      generatedAt: new Date().toISOString(),
      status: summarizeStatus(checks),
      checks,
    };
  }

  private checkProjectRegistry(): DoctorCheck {
    const count = this.options.projects.length;
    return {
      id: "gateway:project-registry",
      label: "Project registry",
      status: count > 0 ? "pass" : "warn",
      scope: "gateway",
      message: count > 0 ? `${count} project(s) discovered` : "No projects discovered",
      details: { count },
    };
  }

  private checkProject(project: GatewayProject): DoctorCheck[] {
    return [
      {
        id: `${project.id}:root`,
        label: "Project root",
        status: existsSync(project.rootDir) ? "pass" : "fail",
        scope: "project",
        projectId: project.id,
        message: existsSync(project.rootDir) ? "Project root exists" : "Project root is missing",
        details: { rootDir: project.rootDir },
      },
      {
        id: `${project.id}:vera-dir`,
        label: "Vera directory",
        status: existsSync(project.veraDir) ? "pass" : "warn",
        scope: "project",
        projectId: project.id,
        message: existsSync(project.veraDir) ? ".vera directory exists" : ".vera directory is missing",
        details: { veraDir: project.veraDir },
      },
      {
        id: `${project.id}:flows-dir`,
        label: "Flow directory",
        status: existsSync(project.flowsDir) ? "pass" : "warn",
        scope: "project",
        projectId: project.id,
        message: existsSync(project.flowsDir) ? "Flow directory exists" : "Flow directory is missing",
        details: { flowsDir: project.flowsDir },
      },
    ];
  }

  private checkCapability(capability: CapabilityDescriptor): DoctorCheck {
    const healthOk = capability.health?.ok;
    const exists = existsSync(capability.source);
    const ok = healthOk ?? exists;
    const status = ok ? "pass" : optionalCapabilityStatus(capability);

    return {
      id: `${capability.id}:health`,
      label: `${capability.name} capability`,
      status,
      scope: "capability",
      projectId: capability.projectId,
      capabilityId: capability.id,
      message: ok ? "Capability source is available" : capability.health?.message ?? "Capability source is not available",
      details: {
        kind: capability.kind,
        source: capability.source,
        status: capability.status,
        actions: capability.actions,
      },
    };
  }
}

function optionalCapabilityStatus(capability: CapabilityDescriptor): DoctorStatus {
  if (capability.kind === "config" || capability.kind === "flow") {
    return "warn";
  }
  return "warn";
}

function summarizeStatus(checks: DoctorCheck[]): DoctorStatus {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "pass";
}

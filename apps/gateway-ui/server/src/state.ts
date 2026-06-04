import {
  CapabilityRegistry,
  createProjectCapabilityInventory,
  DoctorService,
  ProjectRegistry,
  type CapabilityDescriptor,
  type DoctorReport,
  type GatewayProject,
} from "@open-vera/gateway";

export interface GatewayState {
  projects: GatewayProject[];
  capabilities: CapabilityDescriptor[];
  doctor: DoctorReport;
}

export function loadGatewayState(roots: string[]): GatewayState {
  const projects = new ProjectRegistry({ roots, includeChildren: true }).discover();
  const capabilityRegistry = new CapabilityRegistry();

  for (const project of projects) {
    capabilityRegistry.registerMany(createProjectCapabilityInventory(project));
  }

  const capabilities = capabilityRegistry.list();
  const doctor = new DoctorService({ projects, capabilities }).run();

  return {
    projects,
    capabilities,
    doctor,
  };
}

export function summarizeCapabilities(capabilities: CapabilityDescriptor[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const capability of capabilities) {
    const key = `${capability.kind}:${capability.status}`;
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return summary;
}

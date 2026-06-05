import {
  CapabilityRegistry,
  createProjectCapabilityInventory,
  DoctorService,
  GatewayPluginAdmin,
  GatewayPluginAdminError,
  ProjectRegistry,
  type CapabilityDescriptor,
  type DoctorReport,
  type GatewayProject,
} from "@open-vera/gateway";
import type { EventBus } from "@open-vera/plugin-runtime";

export interface LoadGatewayStateOptions {
  pluginAdmin?: GatewayPluginAdmin;
  eventBus?: EventBus;
}

export interface GatewayState {
  projects: GatewayProject[];
  capabilities: CapabilityDescriptor[];
  doctor: DoctorReport;
  pluginAdmin: GatewayPluginAdmin;
}

export function loadGatewayState(roots: string[], options: LoadGatewayStateOptions = {}): GatewayState {
  const projects = new ProjectRegistry({ roots, includeChildren: true }).discover();
  const capabilityRegistry = new CapabilityRegistry();
  const pluginAdmin = options.pluginAdmin ?? new GatewayPluginAdmin({ roots, eventBus: options.eventBus });

  for (const project of projects) {
    capabilityRegistry.registerMany(createProjectCapabilityInventory(project));
  }
  capabilityRegistry.registerMany(pluginAdmin.listCapabilityDescriptors());

  const capabilities = capabilityRegistry.list();
  const doctor = new DoctorService({ projects, capabilities }).run();

  return {
    projects,
    capabilities,
    doctor,
    pluginAdmin,
  };
}

export async function loadGatewayStateWithHealth(roots: string[], options: LoadGatewayStateOptions = {}): Promise<GatewayState> {
  const projects = new ProjectRegistry({ roots, includeChildren: true }).discover();
  const capabilityRegistry = new CapabilityRegistry();
  const pluginAdmin = options.pluginAdmin ?? new GatewayPluginAdmin({ roots, eventBus: options.eventBus });
  await pluginAdmin.activateEnabledPlugins();

  for (const project of projects) {
    capabilityRegistry.registerMany(createProjectCapabilityInventory(project));
  }
  capabilityRegistry.registerMany(await pluginAdmin.listCapabilityDescriptorsWithHealth());

  const capabilities = capabilityRegistry.list();
  const doctor = new DoctorService({ projects, capabilities }).run();

  return {
    projects,
    capabilities,
    doctor,
    pluginAdmin,
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

export function handlePluginAdminError(error: unknown): { status: number; body: { error: string } } {
  if (error instanceof GatewayPluginAdminError) {
    return {
      status: error.code === "NOT_FOUND" ? 404 : 409,
      body: { error: error.message },
    };
  }
  return {
    status: 500,
    body: { error: error instanceof Error ? error.message : "Plugin operation failed" },
  };
}

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ChannelService } from "@open-vera/core/channel";
import {
  EventBus,
  PluginHost,
  type PluginRiskDisclosure,
  type PluginRuntimeState,
  type PluginRuntimeStatus,
  type PluginSource,
} from "@open-vera/plugin-runtime";
import type { CapabilityDescriptor, GatewayProject } from "@open-vera/shared";
import { ProjectRegistry } from "./project-registry.js";

export type GatewayPluginAdminErrorCode = "NOT_FOUND" | "AMBIGUOUS";
export type GatewayChannelActionName = "connect" | "disconnect" | "test" | "reload";

export class GatewayPluginAdminError extends Error {
  readonly code: GatewayPluginAdminErrorCode;

  constructor(code: GatewayPluginAdminErrorCode, message: string) {
    super(message);
    this.name = "GatewayPluginAdminError";
    this.code = code;
  }
}

export interface GatewayPluginAdminOptions {
  roots: string[];
  eventBus?: EventBus;
}

export interface GatewayPluginTarget {
  pluginId: string;
  projectId?: string;
}

export interface GatewayPluginRecord {
  projectId: string;
  projectName: string;
  projectRoot: string;
  pluginId: string;
  status: PluginRuntimeStatus;
  manifest: PluginRuntimeState["plugin"]["manifest"];
  source: PluginSource;
  checksum: string;
  disclosure: PluginRiskDisclosure;
  capabilities: CapabilityDescriptor[];
  activatedAt?: string;
  lastError?: string;
}

export interface GatewayChannelActionTarget {
  projectId?: string;
  capabilityId: string;
  instanceName?: string;
  config?: Record<string, unknown>;
}

export interface GatewayChannelActionResult {
  projectId: string;
  capabilityId: string;
  instanceName: string;
  action: GatewayChannelActionName;
  status: "ok";
  descriptor?: CapabilityDescriptor;
  details: Record<string, unknown>;
}

interface LocatedPlugin {
  project: GatewayProject;
  host: PluginHost;
  state: PluginRuntimeState;
}

export class GatewayPluginAdmin {
  private readonly roots: string[];
  readonly eventBus: EventBus;
  private readonly hosts = new Map<string, PluginHost>();
  private readonly channelServices = new Map<string, ChannelService>();

  constructor(options: GatewayPluginAdminOptions) {
    this.roots = options.roots;
    this.eventBus = options.eventBus ?? new EventBus();
  }

  list(): GatewayPluginRecord[] {
    return this.discover().map((located) => this.toRecord(located));
  }

  inspect(target: GatewayPluginTarget): GatewayPluginRecord {
    return this.toRecord(this.resolve(target));
  }

  async enable(target: GatewayPluginTarget): Promise<GatewayPluginRecord> {
    const located = this.resolve(target);
    located.host.enable(located.state.plugin.manifest.id);
    const state = await located.host.activate(located.state.plugin.manifest.id);
    return this.toRecord({ ...located, state });
  }

  async disable(target: GatewayPluginTarget): Promise<GatewayPluginRecord> {
    const located = this.resolve(target);
    const state = await located.host.disable(located.state.plugin.manifest.id);
    return this.toRecord({ ...located, state });
  }

  async reload(target: GatewayPluginTarget): Promise<GatewayPluginRecord> {
    const located = this.resolve(target);
    const state = await located.host.reload(located.state.plugin.manifest.id);
    return this.toRecord({ ...located, state });
  }

  async activateEnabledPlugins(): Promise<GatewayPluginRecord[]> {
    this.discover();
    const projects = this.projects();
    const records: GatewayPluginRecord[] = [];
    for (const [projectId, host] of this.hosts) {
      const project = projects.find((item) => item.id === projectId);
      if (!project) continue;
      const states = await host.activateEnabledFromLockfile();
      for (const state of states) {
        records.push(this.toRecord({ project, host, state }));
      }
    }
    return records;
  }

  getProjectCapabilities(projectRootOrId: string): PluginHost["capabilities"] | undefined {
    const project = this.projects().find((item) => (
      item.id === projectRootOrId || item.rootDir === projectRootOrId
    ));
    if (!project) return undefined;
    return this.hosts.get(project.id)?.capabilities;
  }

  listCapabilityDescriptors(): CapabilityDescriptor[] {
    const descriptors: CapabilityDescriptor[] = [];
    for (const host of this.hosts.values()) {
      descriptors.push(...host.capabilities.listDescriptors());
    }
    return descriptors;
  }

  async listCapabilityDescriptorsWithHealth(): Promise<CapabilityDescriptor[]> {
    const descriptorGroups = await Promise.all(
      [...this.hosts.values()].map((host) => host.capabilities.listDescriptorsWithHealth()),
    );
    return descriptorGroups.flat();
  }

  async runChannelAction(
    action: GatewayChannelActionName,
    target: GatewayChannelActionTarget,
  ): Promise<GatewayChannelActionResult> {
    await this.activateEnabledPlugins();
    const located = this.resolveChannelCapability(target);
    const service = this.channelServiceFor(located.project);
    const instanceName = target.instanceName ?? located.capability.id;
    const config = target.config ?? {};

    switch (action) {
      case "connect":
        await this.ensureChannelLoaded(service, located.capability.id, instanceName, config);
        await service.connect(instanceName);
        return this.channelActionResult(action, located.project, located.capability, instanceName, service);
      case "disconnect":
        await service.disconnect(instanceName);
        return this.channelActionResult(action, located.project, located.capability, instanceName, service);
      case "test":
        await this.ensureChannelLoaded(service, located.capability.id, instanceName, config);
        return this.channelActionResult(action, located.project, located.capability, instanceName, service);
      case "reload":
        await service.unloadAdapter(instanceName);
        await this.ensureChannelLoaded(service, located.capability.id, instanceName, config);
        return this.channelActionResult(action, located.project, located.capability, instanceName, service);
    }
  }

  private discover(): LocatedPlugin[] {
    const projects = this.projects();
    const located: LocatedPlugin[] = [];

    for (const project of projects) {
      const host = this.hostFor(project);
      for (const source of discoverProjectPluginSources(project)) {
        located.push({
          project,
          host,
          state: host.discover(source),
        });
      }
    }

    return located;
  }

  private projects(): GatewayProject[] {
    return new ProjectRegistry({ roots: this.roots, includeChildren: true }).discover();
  }

  private resolve(target: GatewayPluginTarget): LocatedPlugin {
    const matches = this.discover().filter((located) => {
      const manifest = located.state.plugin.manifest;
      return manifest.id === target.pluginId
        && (!target.projectId || located.project.id === target.projectId);
    });

    if (matches.length === 0) {
      throw new GatewayPluginAdminError("NOT_FOUND", `Plugin not found: ${target.pluginId}`);
    }
    if (matches.length > 1) {
      throw new GatewayPluginAdminError(
        "AMBIGUOUS",
        `Plugin ${target.pluginId} exists in multiple projects; pass projectId`,
      );
    }
    return matches[0]!;
  }

  private hostFor(project: GatewayProject): PluginHost {
    const existing = this.hosts.get(project.id);
    if (existing) return existing;
    const host = new PluginHost({ rootDir: project.rootDir, eventBus: this.eventBus });
    this.hosts.set(project.id, host);
    return host;
  }

  private channelServiceFor(project: GatewayProject): ChannelService {
    let service = this.channelServices.get(project.id);
    if (!service) {
      service = new ChannelService({ eventBus: this.eventBus });
      this.channelServices.set(project.id, service);
    }
    const host = this.hostFor(project);
    for (const capability of host.capabilities.list("channel-adapter")) {
      if (!service.capabilities.get(capability.id)) {
        service.registerRuntimeCapability(capability);
      }
    }
    return service;
  }

  private resolveChannelCapability(target: GatewayChannelActionTarget): {
    project: GatewayProject;
    capability: NonNullable<ReturnType<PluginHost["capabilities"]["get"]>>;
  } {
    const projects = this.projects();
    const matches: Array<{
      project: GatewayProject;
      capability: NonNullable<ReturnType<PluginHost["capabilities"]["get"]>>;
    }> = [];

    for (const project of projects) {
      if (target.projectId && project.id !== target.projectId) continue;
      const capability = this.hosts.get(project.id)?.capabilities.get(target.capabilityId);
      if (capability?.kind === "channel-adapter") {
        matches.push({ project, capability });
      }
    }

    if (matches.length === 0) {
      throw new GatewayPluginAdminError("NOT_FOUND", `Channel capability not found: ${target.capabilityId}`);
    }
    if (matches.length > 1) {
      throw new GatewayPluginAdminError(
        "AMBIGUOUS",
        `Channel capability ${target.capabilityId} exists in multiple projects; pass projectId`,
      );
    }
    return matches[0]!;
  }

  private async ensureChannelLoaded(
    service: ChannelService,
    capabilityId: string,
    instanceName: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    if (service.gateway.getAdapter(instanceName)) return;
    await service.loadAdapter(capabilityId, instanceName, config);
  }

  private channelActionResult(
    action: GatewayChannelActionName,
    project: GatewayProject,
    capability: NonNullable<ReturnType<PluginHost["capabilities"]["get"]>>,
    instanceName: string,
    service: ChannelService,
  ): GatewayChannelActionResult {
    const loaded = service.listLoadedAdapters().find((item) => item.instanceName === instanceName);
    const descriptor = service.capabilities.listDescriptors()
      .find((item: CapabilityDescriptor) => item.id === capability.id);
    return {
      projectId: project.id,
      capabilityId: capability.id,
      instanceName,
      action,
      status: "ok",
      descriptor,
      details: {
        loaded: Boolean(loaded),
        state: loaded?.adapter.state,
        adapterName: loaded?.adapter.name,
        channelType: loaded?.adapter.channelType,
        status: loaded?.adapter.getStatus(),
      },
    };
  }

  private toRecord(located: LocatedPlugin): GatewayPluginRecord {
    const pluginId = located.state.plugin.manifest.id;
    return {
      projectId: located.project.id,
      projectName: located.project.name,
      projectRoot: located.project.rootDir,
      pluginId,
      status: located.state.status,
      manifest: located.state.plugin.manifest,
      source: located.state.plugin.source,
      checksum: located.state.plugin.checksum,
      disclosure: located.state.disclosure,
      capabilities: located.host.capabilities
        .listDescriptors()
        .filter((descriptor: CapabilityDescriptor) => descriptor.metadata["ownerPluginId"] === pluginId),
      ...(located.state.activatedAt ? { activatedAt: located.state.activatedAt } : {}),
      ...(located.state.lastError ? { lastError: located.state.lastError } : {}),
    };
  }
}

export function discoverProjectPluginSources(project: GatewayProject): PluginSource[] {
  const pluginsDir = join(project.rootDir, ".vera", "plugins");
  if (!existsSync(pluginsDir)) return [];

  return readdirSync(pluginsDir)
    .map((entry) => join(pluginsDir, entry))
    .filter((entryPath) => {
      try {
        return statSync(entryPath).isDirectory();
      } catch {
        return false;
      }
    })
    .filter(hasPluginManifest)
    .map((entryPath) => ({ type: "local", path: entryPath }));
}

function hasPluginManifest(pluginDir: string): boolean {
  return existsSync(join(pluginDir, "vera-plugin.json"))
    || existsSync(join(pluginDir, "plugin.json"))
    || existsSync(join(pluginDir, "package.json"));
}

import type { DiscoveredPlugin, PluginPermissions } from "./manifest.js";

export interface PluginRiskDisclosure {
  pluginId: string;
  source: DiscoveredPlugin["source"];
  version: string;
  checksum: string;
  permissions: PluginPermissions;
  sameProcessRisk: true;
  message: string;
}

export class PolicyEngine {
  inspect(plugin: DiscoveredPlugin): PluginRiskDisclosure {
    return {
      pluginId: plugin.manifest.id,
      source: plugin.source,
      version: plugin.manifest.version,
      checksum: plugin.checksum,
      permissions: plugin.manifest.permissions ?? {},
      sameProcessRisk: true,
      message:
        "This plugin runs in the Vera host process. Enable it only if you trust the plugin source.",
    };
  }

  approvedPermissions(plugin: DiscoveredPlugin): PluginPermissions {
    return plugin.manifest.permissions ?? {};
  }
}

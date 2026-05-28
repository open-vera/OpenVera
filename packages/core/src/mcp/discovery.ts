/**
 * MCP Discovery — Dynamic discovery and connection management for MCP servers.
 *
 * Scans configuration files, environment variables, and well-known paths
 * to discover available MCP servers and manage their lifecycle.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { McpClient } from "./client.js";
import type { McpServerConfig, McpConnectionState } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DiscoveryConfig {
  /** Paths to scan for MCP server configurations */
  configPaths?: string[];
  /** Environment variable prefix for MCP server configs */
  envPrefix?: string;
  /** Whether to auto-connect discovered servers */
  autoConnect?: boolean;
}

export interface DiscoveryResult {
  discovered: McpServerConfig[];
  connected: McpConnectionState[];
  errors: Array<{ serverId: string; error: string }>;
}

// ── MCP Discovery ───────────────────────────────────────────────────────────

export class McpDiscovery {
  private client: McpClient;
  private config: Required<DiscoveryConfig>;

  constructor(client: McpClient, config?: DiscoveryConfig) {
    this.client = client;
    this.config = {
      configPaths: config?.configPaths ?? [
        join(process.env.HOME ?? "~", ".claude", "mcp-servers.json"),
        ".mcp-servers.json",
      ],
      envPrefix: config?.envPrefix ?? "MCP_SERVER_",
      autoConnect: config?.autoConnect ?? false,
    };
  }

  /**
   * Discover all available MCP servers.
   */
  async discover(): Promise<DiscoveryResult> {
    const configs: McpServerConfig[] = [];
    const connected: McpConnectionState[] = [];
    const errors: Array<{ serverId: string; error: string }> = [];

    // Discover from config files
    for (const path of this.config.configPaths) {
      const fileConfigs = this.discoverFromConfigFile(path);
      configs.push(...fileConfigs);
    }

    // Discover from environment variables
    const envConfigs = this.discoverFromEnv();
    configs.push(...envConfigs);

    // Auto-connect if configured
    if (this.config.autoConnect) {
      for (const config of configs) {
        try {
          const state = await this.client.connect(config);
          connected.push(state);
          if (state.status === "error") {
            errors.push({ serverId: config.id, error: state.error ?? "Unknown error" });
          }
        } catch (err) {
          errors.push({
            serverId: config.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return { discovered: configs, connected, errors };
  }

  /**
   * Connect to a specific discovered server.
   */
  async connectServer(config: McpServerConfig): Promise<McpConnectionState> {
    return this.client.connect(config);
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private discoverFromConfigFile(path: string): McpServerConfig[] {
    if (!existsSync(path)) return [];

    try {
      const content = readFileSync(path, "utf-8");
      const data = JSON.parse(content) as Record<string, unknown>;

      // Support both array and object formats
      if (Array.isArray(data)) {
        return data as McpServerConfig[];
      }

      // Object format: { "server-name": { command, args, ... } }
      const configs: McpServerConfig[] = [];
      for (const [id, value] of Object.entries(data)) {
        if (typeof value === "object" && value !== null) {
          configs.push({ id, ...(value as Omit<McpServerConfig, "id">) });
        }
      }
      return configs;
    } catch {
      return [];
    }
  }

  private discoverFromEnv(): McpServerConfig[] {
    const configs: McpServerConfig[] = [];
    const prefix = this.config.envPrefix;

    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith(prefix) || !value) continue;

      // Format: MCP_SERVER_<ID>_COMMAND, MCP_SERVER_<ID>_URL, etc.
      const rest = key.slice(prefix.length);
      const parts = rest.split("_");
      if (parts.length < 2) continue;

      const serverId = parts.slice(0, -1).join("_").toLowerCase();
      const field = parts[parts.length - 1].toLowerCase();

      let existing = configs.find((c) => c.id === serverId);
      if (!existing) {
        existing = { id: serverId, transport: "stdio" };
        configs.push(existing);
      }

      switch (field) {
        case "command":
          existing.command = value;
          existing.transport = "stdio";
          break;
        case "url":
          existing.url = value;
          existing.transport = value.includes("/sse") ? "sse" : "streamable-http";
          break;
        case "args":
          existing.args = value.split(" ");
          break;
      }
    }

    return configs;
  }
}

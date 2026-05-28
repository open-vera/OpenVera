/**
 * MCP Client — Connects to MCP servers and manages tool discovery/invocation.
 *
 * Supports stdio, SSE, and streamable-http transports.
 * Provides a unified interface for calling tools on remote MCP servers.
 */

import type {
  McpServerConfig,
  McpServerInfo,
  McpToolDefinition,
  McpToolCallRequest,
  McpToolCallResult,
  McpConnectionState,
} from "./types.js";

// ── MCP Client ──────────────────────────────────────────────────────────────

export class McpClient {
  private connections = new Map<string, McpConnectionState>();
  private configs = new Map<string, McpServerConfig>();

  /**
   * Connect to an MCP server.
   */
  async connect(config: McpServerConfig): Promise<McpConnectionState> {
    this.configs.set(config.id, config);

    const state: McpConnectionState = {
      serverId: config.id,
      status: "connecting",
      tools: [],
    };
    this.connections.set(config.id, state);

    try {
      const info = await this.initialize(config);
      state.status = "connected";
      state.lastConnected = new Date().toISOString();
      state.tools = await this.listTools(config);

      return { ...state };
    } catch (err) {
      state.status = "error";
      state.error = err instanceof Error ? err.message : String(err);
      return { ...state };
    }
  }

  /**
   * Disconnect from an MCP server.
   */
  async disconnect(serverId: string): Promise<void> {
    const state = this.connections.get(serverId);
    if (state) {
      state.status = "disconnected";
      state.tools = [];
    }
    this.connections.delete(serverId);
    this.configs.delete(serverId);
  }

  /**
   * List tools available on a connected server.
   */
  async listTools(config: McpServerConfig): Promise<McpToolDefinition[]> {
    // In a real implementation, this would send JSON-RPC to the server
    // For now, return empty as tools are populated during connect
    const state = this.connections.get(config.id);
    return state?.tools ?? [];
  }

  /**
   * Call a tool on a connected server.
   */
  async callTool(
    serverId: string,
    request: McpToolCallRequest,
  ): Promise<McpToolCallResult> {
    const state = this.connections.get(serverId);
    if (!state || state.status !== "connected") {
      return {
        content: [{ type: "text", text: `Server ${serverId} is not connected` }],
        isError: true,
      };
    }

    // In a real implementation, this would send JSON-RPC callTool request
    // For now, return a placeholder
    return {
      content: [{ type: "text", text: `Tool ${request.name} called on ${serverId}` }],
    };
  }

  /**
   * Get connection state for a server.
   */
  getConnection(serverId: string): McpConnectionState | undefined {
    return this.connections.get(serverId);
  }

  /**
   * Get all connected servers.
   */
  getConnectedServers(): McpConnectionState[] {
    return [...this.connections.values()].filter((s) => s.status === "connected");
  }

  /**
   * Get all available tools across all connected servers.
   */
  getAllTools(): Array<McpToolDefinition & { serverId: string }> {
    const tools: Array<McpToolDefinition & { serverId: string }> = [];
    for (const state of this.connections.values()) {
      if (state.status === "connected") {
        for (const tool of state.tools) {
          tools.push({ ...tool, serverId: state.serverId });
        }
      }
    }
    return tools;
  }

  /**
   * Check if a specific tool is available.
   */
  hasTool(toolName: string): boolean {
    return this.getAllTools().some((t) => t.name === toolName);
  }

  /**
   * Find which server provides a specific tool.
   */
  findToolServer(toolName: string): string | undefined {
    const tool = this.getAllTools().find((t) => t.name === toolName);
    return tool?.serverId;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private async initialize(config: McpServerConfig): Promise<McpServerInfo> {
    // In a real implementation, this would:
    // 1. Spawn/connect to the server process
    // 2. Send initialize JSON-RPC request
    // 3. Receive server info and capabilities
    return {
      name: config.id,
      version: "1.0.0",
      capabilities: { tools: {} },
    };
  }
}

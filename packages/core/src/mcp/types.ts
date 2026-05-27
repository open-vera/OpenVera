/**
 * MCP (Model Context Protocol) types and interfaces.
 *
 * MCP enables connecting to external tool servers that expose tools
 * via a standardized protocol. This module provides the client-side
 * implementation for discovering and calling MCP tools.
 */

// ── MCP Protocol Types ──────────────────────────────────────────────────────

export interface McpServerInfo {
  name: string;
  version: string;
  capabilities: McpCapabilities;
}

export interface McpCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean };
  prompts?: { listChanged?: boolean };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCallRequest {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: McpContent[];
  isError?: boolean;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string } };

// ── Client Types ─────────────────────────────────────────────────────────────

export type McpTransportType = "stdio" | "sse" | "streamable-http";

export interface McpServerConfig {
  /** Unique server identifier */
  id: string;
  /** Transport type */
  transport: McpTransportType;
  /** Command for stdio transport */
  command?: string;
  /** Arguments for stdio transport */
  args?: string[];
  /** Environment variables for stdio transport */
  env?: Record<string, string>;
  /** URL for SSE or streamable-http transport */
  url?: string;
  /** Connection timeout in ms */
  timeoutMs?: number;
  /** Whether to auto-reconnect on disconnect */
  autoReconnect?: boolean;
}

export interface McpConnectionState {
  serverId: string;
  status: "disconnected" | "connecting" | "connected" | "error";
  error?: string;
  lastConnected?: string;
  tools: McpToolDefinition[];
}

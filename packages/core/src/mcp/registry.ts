/**
 * MCP Tool Registry — Bridges MCP tools into the Vera ToolRegistry.
 *
 * Automatically registers MCP tools as Vera tools, enabling seamless
 * use of external MCP server tools alongside built-in tools.
 */

import type { McpClient } from "./client.js";
import type { McpToolDefinition, McpToolCallResult } from "./types.js";
import type { ToolDef, ToolResult, ToolContext } from "../tools/types.js";

// ── MCP Tool Registry ───────────────────────────────────────────────────────

export class McpToolRegistry {
  private client: McpClient;
  private registeredTools = new Map<string, { serverId: string; tool: McpToolDefinition }>();

  constructor(client: McpClient) {
    this.client = client;
  }

  /**
   * Sync tools from all connected MCP servers into Vera tool definitions.
   */
  syncTools(): ToolDef[] {
    const tools: ToolDef[] = [];
    this.registeredTools.clear();

    for (const mcpTool of this.client.getAllTools()) {
      const veraTool = this.convertToVeraTool(mcpTool);
      tools.push(veraTool);
      this.registeredTools.set(mcpTool.name, {
        serverId: mcpTool.serverId,
        tool: mcpTool,
      });
    }

    return tools;
  }

  /**
   * Execute an MCP tool call through the Vera tool interface.
   */
  async executeMcpTool(
    name: string,
    args: Record<string, unknown>,
    _context?: ToolContext,
  ): Promise<ToolResult> {
    const entry = this.registeredTools.get(name);
    if (!entry) {
      return {
        ok: false,
        content: "",
        error: {
          code: "NOT_FOUND" as const,
          message: `MCP tool not found: ${name}`,
          retryable: false,
        },
      };
    }

    try {
      const result = await this.client.callTool(entry.serverId, {
        name,
        arguments: args,
      });

      return this.convertResult(result);
    } catch (err) {
      return {
        ok: false,
        content: "",
        error: {
          code: "EXEC_ERROR" as const,
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        },
      };
    }
  }

  /**
   * Check if a tool name belongs to an MCP server.
   */
  isMcpTool(name: string): boolean {
    return this.registeredTools.has(name);
  }

  /**
   * Get the server ID for an MCP tool.
   */
  getToolServer(name: string): string | undefined {
    return this.registeredTools.get(name)?.serverId;
  }

  /**
   * Get count of registered MCP tools.
   */
  getToolCount(): number {
    return this.registeredTools.size;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private convertToVeraTool(mcpTool: McpToolDefinition & { serverId: string }): ToolDef {
    return {
      name: mcpTool.name,
      description: `[MCP:${mcpTool.serverId}] ${mcpTool.description}`,
      parameters: mcpTool.inputSchema as ToolDef["parameters"],
      execute: async (args: Record<string, unknown>, context?: ToolContext) => {
        return this.executeMcpTool(mcpTool.name, args, context);
      },
    };
  }

  private convertResult(mcpResult: McpToolCallResult): ToolResult {
    const textParts = mcpResult.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text);

    return {
      ok: !mcpResult.isError,
      content: textParts.join("\n"),
      error: mcpResult.isError
        ? {
            code: "EXEC_ERROR" as const,
            message: textParts.join("\n"),
            retryable: false,
          }
        : undefined,
    };
  }
}

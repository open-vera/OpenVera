import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface McpServerSummary {
  id: string;
  name: string;
  transport?: string;
  source: string;
}

export interface McpToolSummary {
  serverId: string;
  name: string;
  description?: string;
}

function parseMcpConfigFile(path: string): McpServerSummary[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const servers = (parsed.mcpServers ?? parsed.servers ?? parsed) as Record<string, unknown>;
    if (!servers || typeof servers !== "object") return [];

    return Object.entries(servers).map(([id, value]) => {
      const config = (value ?? {}) as Record<string, unknown>;
      return {
        id,
        name: String(config.name ?? id),
        transport: typeof config.type === "string" ? config.type : typeof config.transport === "string" ? config.transport : undefined,
        source: path,
      };
    });
  } catch {
    return [];
  }
}

export function listMcpServers(projectRoot: string): McpServerSummary[] {
  const paths = [
    join(projectRoot, ".mcp-servers.json"),
    join(projectRoot, ".cursor", "mcp.json"),
    join(process.env.HOME ?? "", ".cursor", "mcp.json"),
  ];

  const seen = new Set<string>();
  const servers: McpServerSummary[] = [];
  for (const path of paths) {
    for (const server of parseMcpConfigFile(path)) {
      if (seen.has(server.id)) continue;
      seen.add(server.id);
      servers.push(server);
    }
  }
  return servers;
}

export function listMcpTools(projectRoot: string): McpToolSummary[] {
  return listMcpServers(projectRoot).map((server) => ({
    serverId: server.id,
    name: `${server.id}/*`,
    description: `Tools from ${server.name} (${server.transport ?? "stdio"}) — connect via Core MCP client to invoke.`,
  }));
}

export function simulateMcpToolCall(serverId: string, toolName: string): { ok: boolean; message: string } {
  return {
    ok: true,
    message: `MCP tool call queued for server=${serverId} tool=${toolName}. Gateway will delegate to Core MCP client in a follow-up.`,
  };
}

# MCP -- Model Context Protocol Support

## Overview

MCP (Model Context Protocol) is an open protocol proposed by Anthropic that defines a standardized communication format between LLM applications and external tool servers. Vera acts as an MCP client, connecting to third-party MCP servers and mapping their exposed tools, resources, and prompts into Vera's ToolRegistry for MCP ecosystem compatibility.

In Vera's architecture, MCP sits in the **capability extension layer**: it is not part of the runtime core but uses the adapter pattern to "translate" external MCP server tools into Vera-native tools, so agents call them transparently.

---

## MCP Protocol Overview

### Architecture Roles

```
+---------------------------------------------------+
| Vera Agent Runtime                                |
|                                                   |
|  ToolRegistry                                     |
|  +----------+  +----------+  +-----------------+  |
|  | Built-in |  | Sandbox  |  | MCP Tool Proxy  |  |
|  | read_file|  | tools    |  | (McpToolReg)    |  |
|  | bash     |  |          |  |                 |  |
|  +----------+  +----------+  +--------+--------+  |
|                                       |            |
|                               McpClient            |
|                               +----------+         |
|                               | connect  |         |
|                               |callTool  |         |
|                               +----+-----+         |
+------------------------------------+---------------+
                                     |
                     +---------------+---------------+
                     | stdio         | sse           |
                     v               v               v
               +----------+  +----------+  +----------------+
               | MCP      |  | MCP      |  | MCP            |
               | Server A |  | Server B |  | Server C       |
               | (local)  |  | (HTTP)   |  | (streamable)   |
               +----------+  +----------+  +----------------+
```

### Supported Transports

| Transport | Use Case | Connection |
|-----------|----------|------------|
| `stdio` | Local process (stdin/stdout JSON-RPC) | `command` + `args` spawns child process |
| `sse` | Remote HTTP server (Server-Sent Events) | `url` points to SSE endpoint |
| `streamable-http` | Remote HTTP server (Streamable HTTP) | `url` points to HTTP endpoint |

---

## Source Structure

```
packages/core/src/mcp/
  types.ts      # Protocol types + config types
  client.ts     # McpClient connection management and tool calls
  discovery.ts  # McpDiscovery service discovery
  registry.ts   # McpToolRegistry maps tools to Vera ToolRegistry
  index.ts      # Barrel export

packages/core/src/config/
  types.ts      # MCPServerConfig (mcp_servers field in settings.json)
```

---

## MCP Server Lifecycle

### 1. Discovery

`McpDiscovery` (`packages/core/src/mcp/discovery.ts`) discovers available MCP server configurations from multiple sources:

```ts
class McpDiscovery {
  constructor(client: McpClient, config?: DiscoveryConfig);

  // Scans all sources, returns discovered configs and connection states
  async discover(): Promise<DiscoveryResult>;
}
```

**Discovery sources**:

| Source | Description | Priority |
|--------|-------------|----------|
| Config file | `~/.claude/mcp-servers.json` or `.mcp-servers.json` | High |
| Environment variables | `MCP_SERVER_<ID>_COMMAND` / `MCP_SERVER_<ID>_URL` format | Low |

**Config file formats** (both supported):

```json
// Array format
[
  {
    "id": "my-server",
    "transport": "stdio",
    "command": "node",
    "args": ["./mcp-server.js"]
  }
]

// Object format
{
  "my-server": {
    "transport": "stdio",
    "command": "node",
    "args": ["./mcp-server.js"]
  }
}
```

**Environment variable format**:

```bash
# stdio transport
export MCP_SERVER_MY_SERVER_COMMAND="node"
export MCP_SERVER_MY_SERVER_ARGS="./mcp-server.js --port 3000"

# HTTP transport
export MCP_SERVER_REMOTE_TOOL_URL="https://mcp.example.com/sse"
```

- Server ID extracted from the env var name: content after `MCP_SERVER_` prefix (lowercased)
- URLs containing `/sse` are automatically identified as SSE transport; otherwise streamable-http

### 2. Connect

`McpClient.connect()` establishes a connection to the MCP server:

```ts
const client = new McpClient();
const state = await client.connect({
  id: "my-server",
  transport: "stdio",
  command: "node",
  args: ["./mcp-server.js"],
  timeoutMs: 10000,
});
```

State transitions during connection:

```
disconnected -> connecting -> connected
                                |
                                +-- Success: status="connected"
                                |        - records lastConnected
                                |        - fetches tool list
                                |
                                +-- Failure: status="error"
                                         - records error info
```

### 3. Health Check

The current version performs an initialization handshake (`initialize` JSON-RPC request) during `connect()`, retrieving server capabilities and version info. Continuous health checks (heartbeats) are not yet implemented, planned for P3.

### 4. List Tools

After a successful connection, `listTools` is automatically called to retrieve the server's tool list. Tool definitions include:

```ts
interface McpToolDefinition {
  name: string;                          // Tool name
  description: string;                   // Tool description
  inputSchema: Record<string, unknown>;  // Parameter JSON Schema
}
```

The tool list is stored in `McpConnectionState.tools` and can be accessed via `client.getAllTools()` for a consolidated view across all connected servers.

### 5. Disconnect

```ts
await client.disconnect("my-server");
// State -> disconnected, tool list cleared
```

---

## McpClient Core Features

### Connection Management

```ts
class McpClient {
  // Connect and disconnect
  connect(config: McpServerConfig): Promise<McpConnectionState>;
  disconnect(serverId: string): Promise<void>;

  // Tool invocation
  callTool(serverId: string, request: McpToolCallRequest): Promise<McpToolCallResult>;

  // State queries
  getConnection(serverId: string): McpConnectionState | undefined;
  getConnectedServers(): McpConnectionState[];

  // Tool discovery
  getAllTools(): Array<McpToolDefinition & { serverId: string }>;
  hasTool(toolName: string): boolean;
  findToolServer(toolName: string): string | undefined;
}
```

### Connection State

```ts
interface McpConnectionState {
  serverId: string;
  status: "disconnected" | "connecting" | "connected" | "error";
  error?: string;           // Error details when status=error
  lastConnected?: string;   // ISO timestamp
  tools: McpToolDefinition[];
}
```

---

## MCP Tool to Vera ToolRegistry Mapping

`McpToolRegistry` (`packages/core/src/mcp/registry.ts`) is the core adapter that bridges MCP tools into Vera's tool system.

### Mapping Mechanism

```ts
class McpToolRegistry {
  constructor(client: McpClient);

  // Sync all MCP tools into Vera ToolDef format
  syncTools(): ToolDef[];

  // Execute an MCP tool call
  executeMcpTool(name: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult>;

  // Helpers
  isMcpTool(name: string): boolean;
  getToolServer(name: string): string | undefined;
  getToolCount(): number;
}
```

### Conversion Logic

1. **Name**: MCP tool names are registered directly in Vera without renaming.
2. **Description prefix**: MCP tool descriptions are prefixed with `[MCP:<serverId>]` so users know the tool's origin.
3. **Parameters**: `inputSchema` maps directly to `ToolDef.parameters` (JSON Schema).
4. **Execution proxy**: The `execute` function internally calls `McpClient.callTool()` and converts to `ToolResult`.

```ts
// MCP tool -> Vera tool
function convertToVeraTool(mcpTool): ToolDef {
  return {
    name: mcpTool.name,
    description: `[MCP:${mcpTool.serverId}] ${mcpTool.description}`,
    parameters: mcpTool.inputSchema,
    execute: async (args, context) => {
      return this.executeMcpTool(mcpTool.name, args, context);
    },
  };
}
```

### Result Conversion

MCP tool results can contain multiple content types; conversion prioritizes text extraction:

```ts
// McpToolCallResult -> ToolResult
function convertResult(mcpResult): ToolResult {
  const textParts = mcpResult.content
    .filter(c => c.type === "text")
    .map(c => c.text);

  return {
    ok: !mcpResult.isError,
    content: textParts.join("\n"),
    error: mcpResult.isError ? { code: "EXEC_ERROR", message: textParts.join("\n") } : undefined,
  };
}
```

Currently, `image` and `resource` content types are filtered out (not included in text output). Full multimodal MCP content support is planned for P3.

---

## Configuration: mcp_servers in settings.json

Vera configures MCP servers via `VeraConfig.mcp_servers` (`packages/core/src/config/types.ts`):

```json
{
  "mcp_servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed"],
      "env": {
        "NODE_ENV": "production"
      }
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "$GITHUB_TOKEN"
      }
    },
    "remote-tool": {
      "command": "node",
      "args": ["./mcp-server.js"],
      "env": {
        "API_KEY": "$API_KEY"
      }
    }
  }
}
```

Config structure:

```ts
interface MCPServerConfig {
  command: string;              // Launch command (required)
  args?: string[];              // Command-line arguments
  env?: Record<string, string>;  // Environment variables
}
```

Current configuration only supports `stdio` transport (via `command` + `args` spawning a child process). SSE and streamable-http URL configuration is defined in the `McpServerConfig` interface but not yet present in settings.json's `MCPServerConfig`; this is planned for P3.

---

## MCP Content Types

The protocol defines three content types:

```ts
type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }    // base64 image
  | { type: "resource"; resource: { uri: string; text?: string } };
```

Current Vera MCP implementation:
- **text**: Fully supported, text content extracted.
- **image**: Accepted but not rendered into text results.
- **resource**: Accepted but not expanded (only `resource.text` extracted if present).

---

## Error Handling

MCP module errors propagate via `McpConnectionState.error` (not exceptions), allowing callers to inspect and decide:

```ts
const state = await client.connect(config);
if (state.status === "error") {
  console.error(`Failed to connect to MCP server: ${state.error}`);
}

const result = await client.callTool("server-id", { name: "tool", arguments: {} });
if (result.isError) {
  const errMsg = result.content.find(c => c.type === "text")?.text;
  console.error(`Tool call failed: ${errMsg}`);
}
```

`McpToolRegistry.executeMcpTool` uses try/catch to catch `McpClient.callTool` exceptions and convert them to the standard `ToolResult` error format.

---

## Current Status and Roadmap

### Current Status

MCP in Vera is at the **framework ready, transport not implemented** stage:

| Component | Status | Notes |
|-----------|--------|-------|
| Type definitions | Done | `McpServerConfig`, `McpToolDefinition`, `McpConnectionState`, etc. |
| McpClient | Skeleton | Connect/tool list/tool call methods defined; internal JSON-RPC not implemented |
| McpDiscovery | Done | Config file scanning + env var scanning |
| McpToolRegistry | Done | Vera ToolDef format conversion + execution proxy |
| stdio transport | Not implemented | Child process launch + stdin/stdout JSON-RPC pending |
| SSE transport | Not implemented | HTTP SSE client pending |
| streamable-http transport | Not implemented | HTTP streamable client pending |
| settings.json integration | Partial | `MCPServerConfig` defined, command mode only |

### Roadmap

Vera's MCP support is planned for **P3** ("Extending toward a general-purpose agent platform"):

| Milestone | Content | Priority |
|-----------|---------|----------|
| **M1: stdio transport** | Child process management, JSON-RPC codec, initialization handshake, tool list/call | P3 - High |
| **M2: SSE transport** | HTTP SSE client, reconnection, heartbeat | P3 - High |
| **M3: settings.json completion** | `url` field support, automatic transport detection | P3 - High |
| **M4: Permission governance** | MCP tools in SecurityPlugin allowlist, source-based isolation | P3 - Medium |
| **M5: Multimodal content** | Full image/resource type support | P3 - Medium |
| **M6: Auto-reconnect** | Automatic retry on disconnect (exponential backoff) | P3 - Low |
| **M7: MCP server hot reload** | Runtime add/remove MCP servers | P3 - Low |

### Relationship with Claude Code

Vera's MCP configuration is compatible with Claude Code's `mcp-servers.json` format, enabling seamless migration by reading existing MCP server configs from `~/.claude/mcp-servers.json`. The `MCP_SERVER_` environment variable prefix is also consistent.

---

## Usage Examples

### Register MCP Tools with Vera

```ts
import { McpClient, McpToolRegistry, McpDiscovery } from "@vera/core";

// 1. Create MCP client
const client = new McpClient();

// 2. Discover and connect MCP servers
const discovery = new McpDiscovery(client, { autoConnect: true });
const result = await discovery.discover();

console.log(`Discovered ${result.discovered.length} servers`);
console.log(`Successfully connected ${result.connected.length}`);
for (const err of result.errors) {
  console.warn(`${err.serverId}: ${err.error}`);
}

// 3. Register MCP tools into Vera ToolRegistry
const mcpRegistry = new McpToolRegistry(client);
const mcpTools = mcpRegistry.syncTools();

// 4. Merge into Vera ToolRegistry
for (const tool of mcpTools) {
  veraToolRegistry.register(tool); // tool.name, tool.description includes [MCP:serverId] prefix
}

// 5. Agents use transparently
// agent calls tool "github_search_repos" -> McpToolRegistry -> McpClient -> MCP Server
```

### Query MCP Tools

```ts
// List all MCP tools
const allTools = client.getAllTools();
for (const t of allTools) {
  console.log(`${t.name} (from ${t.serverId}): ${t.description}`);
}

// Find which server owns a tool
const server = client.findToolServer("github_search_repos");
console.log(`github_search_repos is on ${server}`);
```

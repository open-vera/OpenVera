# MCP —— Model Context Protocol 支持

## 概述

MCP（Model Context Protocol）是 Anthropic 提出的开放协议，定义了 LLM 应用与外部工具服务器之间的标准化通信格式。Vera 作为 MCP 客户端，连接第三方 MCP 服务器，将其暴露的工具、资源和提示词映射到 Vera 的 ToolRegistry 中，实现 MCP 生态兼容。

在 Vera 的架构中，MCP 位于**能力扩展层**：它不是运行时核心的一部分，而是使用适配器模式将外部 MCP 服务器工具"翻译"为 Vera 原生工具，使 Agent 可以透明地调用它们。

---

## MCP 协议概述

### 架构角色

```
+---------------------------------------------------+
| Vera Agent Runtime                                |
|                                                   |
|  ToolRegistry                                     |
|  +----------+  +----------+  +-----------------+  |
|  | 内置工具 |  | Sandbox  |  | MCP 工具代理    |  |
|  | read_file|  | 工具     |  | (McpToolReg)    |  |
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
               | (本地)   |  | (HTTP)   |  | (streamable)   |
               +----------+  +----------+  +----------------+
```

### 支持的传输方式

| 传输方式 | 用例 | 连接方式 |
|---------|------|---------|
| `stdio` | 本地进程（stdin/stdout JSON-RPC） | `command` + `args` 启动子进程 |
| `sse` | 远程 HTTP 服务器（Server-Sent Events） | `url` 指向 SSE 端点 |
| `streamable-http` | 远程 HTTP 服务器（Streamable HTTP） | `url` 指向 HTTP 端点 |

---

## 源码结构

```
packages/core/src/mcp/
  types.ts      # 协议类型 + 配置类型
  client.ts     # McpClient 连接管理与工具调用
  discovery.ts  # McpDiscovery 服务发现
  registry.ts   # McpToolRegistry 将工具映射到 Vera ToolRegistry
  index.ts      # Barrel 导出

packages/core/src/config/
  types.ts      # MCPServerConfig（settings.json 中的 mcp_servers 字段）
```

---

## MCP 服务器生命周期

### 1. 发现

`McpDiscovery`（`packages/core/src/mcp/discovery.ts`）从多个来源发现可用的 MCP 服务器配置：

```ts
class McpDiscovery {
  constructor(client: McpClient, config?: DiscoveryConfig);

  // 扫描所有来源，返回发现的配置和连接状态
  async discover(): Promise<DiscoveryResult>;
}
```

**发现来源**：

| 来源 | 描述 | 优先级 |
|------|------|--------|
| 配置文件 | `~/.claude/mcp-servers.json` 或 `.mcp-servers.json` | 高 |
| 环境变量 | `MCP_SERVER_<ID>_COMMAND` / `MCP_SERVER_<ID>_URL` 格式 | 低 |

**支持的配置文件格式**（两种均可）：

```json
// 数组格式
[
  {
    "id": "my-server",
    "transport": "stdio",
    "command": "node",
    "args": ["./mcp-server.js"]
  }
]

// 对象格式
{
  "my-server": {
    "transport": "stdio",
    "command": "node",
    "args": ["./mcp-server.js"]
  }
}
```

**环境变量格式**：

```bash
# stdio 传输
export MCP_SERVER_MY_SERVER_COMMAND="node"
export MCP_SERVER_MY_SERVER_ARGS="./mcp-server.js --port 3000"

# HTTP 传输
export MCP_SERVER_REMOTE_TOOL_URL="https://mcp.example.com/sse"
```

- 服务器 ID 从环境变量名中提取：`MCP_SERVER_` 前缀后的内容（转小写）
- 包含 `/sse` 的 URL 自动识别为 SSE 传输；否则为 streamable-http

### 2. 连接

`McpClient.connect()` 建立与 MCP 服务器的连接：

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

连接过程中的状态转换：

```
disconnected -> connecting -> connected
                                |
                                +-- 成功：status="connected"
                                |        - 记录 lastConnected
                                |        - 获取工具列表
                                |
                                +-- 失败：status="error"
                                         - 记录错误信息
```

### 3. 健康检查

当前版本在 `connect()` 期间执行初始化握手（`initialize` JSON-RPC 请求），获取服务器能力和版本信息。持续健康检查（心跳）尚未实现，计划在 P3 阶段。

### 4. 列出工具

连接成功后自动调用 `listTools` 获取服务器的工具列表。工具定义包括：

```ts
interface McpToolDefinition {
  name: string;                          // 工具名称
  description: string;                   // 工具描述
  inputSchema: Record<string, unknown>;  // 参数 JSON Schema
}
```

工具列表存储在 `McpConnectionState.tools` 中，可通过 `client.getAllTools()` 获取所有已连接服务器的汇总视图。

### 5. 断开连接

```ts
await client.disconnect("my-server");
// 状态 -> disconnected，工具列表清空
```

---

## McpClient 核心功能

### 连接管理

```ts
class McpClient {
  // 连接与断开
  connect(config: McpServerConfig): Promise<McpConnectionState>;
  disconnect(serverId: string): Promise<void>;

  // 工具调用
  callTool(serverId: string, request: McpToolCallRequest): Promise<McpToolCallResult>;

  // 状态查询
  getConnection(serverId: string): McpConnectionState | undefined;
  getConnectedServers(): McpConnectionState[];

  // 工具发现
  getAllTools(): Array<McpToolDefinition & { serverId: string }>;
  hasTool(toolName: string): boolean;
  findToolServer(toolName: string): string | undefined;
}
```

### 连接状态

```ts
interface McpConnectionState {
  serverId: string;
  status: "disconnected" | "connecting" | "connected" | "error";
  error?: string;           // status=error 时的错误详情
  lastConnected?: string;   // ISO 时间戳
  tools: McpToolDefinition[];
}
```

---

## MCP 工具到 Vera ToolRegistry 的映射

`McpToolRegistry`（`packages/core/src/mcp/registry.ts`）是将 MCP 工具桥接到 Vera 工具系统的核心适配器。

### 映射机制

```ts
class McpToolRegistry {
  constructor(client: McpClient);

  // 将所有 MCP 工具同步为 Vera ToolDef 格式
  syncTools(): ToolDef[];

  // 执行 MCP 工具调用
  executeMcpTool(name: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult>;

  // 辅助方法
  isMcpTool(name: string): boolean;
  getToolServer(name: string): string | undefined;
  getToolCount(): number;
}
```

### 转换逻辑

1. **名称**：MCP 工具名称直接注册到 Vera 中，不做重命名。
2. **描述前缀**：MCP 工具描述前添加 `[MCP:<serverId>]` 前缀，方便用户知道工具来源。
3. **参数**：`inputSchema` 直接映射到 `ToolDef.parameters`（JSON Schema）。
4. **执行代理**：`execute` 函数内部调用 `McpClient.callTool()` 并转换为 `ToolResult`。

```ts
// MCP 工具 -> Vera 工具
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

### 结果转换

MCP 工具结果可能包含多种内容类型；转换时优先提取文本：

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

目前 `image` 和 `resource` 内容类型会被过滤掉（不包含在文本输出中）。完整的多模态 MCP 内容支持计划在 P3 阶段。

---

## 配置：settings.json 中的 mcp_servers

Vera 通过 `VeraConfig.mcp_servers`（`packages/core/src/config/types.ts`）配置 MCP 服务器：

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

配置结构：

```ts
interface MCPServerConfig {
  command: string;              // 启动命令（必填）
  args?: string[];              // 命令行参数
  env?: Record<string, string>;  // 环境变量
}
```

当前配置仅支持 `stdio` 传输（通过 `command` + `args` 启动子进程）。SSE 和 streamable-http 的 URL 配置已在 `McpServerConfig` 接口中定义，但尚未进入 settings.json 的 `MCPServerConfig`；计划在 P3 阶段完成。

---

## MCP 内容类型

协议定义了三种内容类型：

```ts
type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }    // base64 图片
  | { type: "resource"; resource: { uri: string; text?: string } };
```

当前 Vera MCP 实现：
- **text**：完全支持，文本内容被提取。
- **image**：接受但不渲染到文本结果中。
- **resource**：接受但不展开（仅提取 `resource.text`（如果存在））。

---

## 错误处理

MCP 模块的错误通过 `McpConnectionState.error` 传播（不抛出异常），允许调用方检查并决策：

```ts
const state = await client.connect(config);
if (state.status === "error") {
  console.error(`连接 MCP 服务器失败: ${state.error}`);
}

const result = await client.callTool("server-id", { name: "tool", arguments: {} });
if (result.isError) {
  const errMsg = result.content.find(c => c.type === "text")?.text;
  console.error(`工具调用失败: ${errMsg}`);
}
```

`McpToolRegistry.executeMcpTool` 使用 try/catch 捕获 `McpClient.callTool` 的异常，并转换为标准的 `ToolResult` 错误格式。

---

## 当前状态与路线图

### 当前状态

Vera 中的 MCP 处于**框架就绪、传输未实现**阶段：

| 组件 | 状态 | 说明 |
|------|------|------|
| 类型定义 | 已完成 | `McpServerConfig`、`McpToolDefinition`、`McpConnectionState` 等 |
| McpClient | 骨架 | 定义了 connect/工具列表/工具调用方法；内部 JSON-RPC 未实现 |
| McpDiscovery | 已完成 | 配置文件扫描 + 环境变量扫描 |
| McpToolRegistry | 已完成 | Vera ToolDef 格式转换 + 执行代理 |
| stdio 传输 | 未实现 | 子进程启动 + stdin/stdout JSON-RPC 待完成 |
| SSE 传输 | 未实现 | HTTP SSE 客户端待完成 |
| streamable-http 传输 | 未实现 | HTTP streamable 客户端待完成 |
| settings.json 集成 | 部分完成 | `MCPServerConfig` 已定义，仅 command 模式 |

### 路线图

Vera 的 MCP 支持计划在 **P3**（"向通用 Agent 平台扩展"）阶段：

| 里程碑 | 内容 | 优先级 |
|--------|------|--------|
| **M1: stdio 传输** | 子进程管理、JSON-RPC 编解码、初始化握手、工具列表/调用 | P3 - 高 |
| **M2: SSE 传输** | HTTP SSE 客户端、重连、心跳 | P3 - 高 |
| **M3: settings.json 完善** | `url` 字段支持、自动传输检测 | P3 - 高 |
| **M4: 权限治理** | MCP 工具在 SecurityPlugin 允许列表中、基于来源的隔离 | P3 - 中 |
| **M5: 多模态内容** | 完整的 image/resource 类型支持 | P3 - 中 |
| **M6: 自动重连** | 断连时自动重试（指数退避） | P3 - 低 |
| **M7: MCP 服务器热加载** | 运行时动态添加/移除 MCP 服务器 | P3 - 低 |

### 与 Claude Code 的关系

Vera 的 MCP 配置与 Claude Code 的 `mcp-servers.json` 格式兼容，可通过读取 `~/.claude/mcp-servers.json` 中已有的 MCP 服务器配置实现无缝迁移。`MCP_SERVER_` 环境变量前缀也保持一致。

---

## 使用示例

### 将 MCP 工具注册到 Vera

```ts
import { McpClient, McpToolRegistry, McpDiscovery } from "@vera/core";

// 1. 创建 MCP 客户端
const client = new McpClient();

// 2. 发现并连接 MCP 服务器
const discovery = new McpDiscovery(client, { autoConnect: true });
const result = await discovery.discover();

console.log(`发现 ${result.discovered.length} 个服务器`);
console.log(`成功连接 ${result.connected.length} 个`);
for (const err of result.errors) {
  console.warn(`${err.serverId}: ${err.error}`);
}

// 3. 将 MCP 工具注册到 Vera ToolRegistry
const mcpRegistry = new McpToolRegistry(client);
const mcpTools = mcpRegistry.syncTools();

// 4. 合并到 Vera ToolRegistry
for (const tool of mcpTools) {
  veraToolRegistry.register(tool); // tool.description 包含 [MCP:serverId] 前缀
}

// 5. Agent 透明使用
// agent 调用工具 "github_search_repos" -> McpToolRegistry -> McpClient -> MCP Server
```

### 查询 MCP 工具

```ts
// 列出所有 MCP 工具
const allTools = client.getAllTools();
for (const t of allTools) {
  console.log(`${t.name}（来自 ${t.serverId}）: ${t.description}`);
}

// 查找工具所属的服务器
const server = client.findToolServer("github_search_repos");
console.log(`github_search_repos 位于 ${server}`);
```

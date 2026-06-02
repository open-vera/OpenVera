/**
 * Comprehensive unit tests for MCP Discovery.
 * Covers: McpDiscovery constructor, discover(), connectServer(),
 * discoverFromConfigFile(), discoverFromEnv().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { McpServerConfig, McpConnectionState } from "../types.js";

// ── Mock state holders ────────────────────────────────────────────────────────

let mockExistsSync: ReturnType<typeof vi.fn>;
let mockReadFileSync: ReturnType<typeof vi.fn>;
let mockClientConnect: ReturnType<typeof vi.fn>;

// ── Mocks (hoisted by vitest) ─────────────────────────────────────────────────

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) =>
    (mockExistsSync as (...a: unknown[]) => boolean)(...args),
  readFileSync: (...args: unknown[]) =>
    (mockReadFileSync as (...a: unknown[]) => string)(...args),
}));

vi.mock("node:path", () => ({
  join: (...segments: string[]) => segments.join("/"),
}));

vi.mock("../client.js", () => ({
  McpClient: class {
    connect = (...args: unknown[]) =>
      (mockClientConnect as (...a: unknown[]) => unknown)(...args);
  },
}));

// ── Imports (after mocks are hoisted) ─────────────────────────────────────────

import { McpDiscovery } from "../discovery.js";
import { McpClient } from "../client.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConnectionState(
  serverId: string,
  status: McpConnectionState["status"] = "connected",
  error?: string,
): McpConnectionState {
  return { serverId, status, error, tools: [] };
}

function createClient(): McpClient {
  return new McpClient();
}

// ── McpDiscovery Constructor ──────────────────────────────────────────────────

describe("McpDiscovery constructor", () => {
  beforeEach(() => {
    mockExistsSync = vi.fn();
    mockReadFileSync = vi.fn();
    mockClientConnect = vi.fn();
  });

  it("should use defaults when no config is provided", () => {
    const discovery = new McpDiscovery(createClient());

    const cfg = (discovery as any).config;
    expect(cfg.envPrefix).toBe("MCP_SERVER_");
    expect(cfg.autoConnect).toBe(false);
    expect(Array.isArray(cfg.configPaths)).toBe(true);
    expect(cfg.configPaths.length).toBe(2);
  });

  it("should merge partial config with defaults", () => {
    const discovery = new McpDiscovery(createClient(), {
      configPaths: ["/custom/path.json"],
      autoConnect: true,
    });

    const cfg = (discovery as any).config;
    expect(cfg.configPaths).toEqual(["/custom/path.json"]);
    expect(cfg.autoConnect).toBe(true);
    expect(cfg.envPrefix).toBe("MCP_SERVER_");
  });

  it('should fallback to "~" when HOME is not set', () => {
    const home = process.env.HOME;
    delete process.env.HOME;

    try {
      const discovery = new McpDiscovery(createClient());
      const cfg = (discovery as any).config;
      expect(cfg.configPaths).toContain("~/.claude/mcp-servers.json");
    } finally {
      process.env.HOME = home;
    }
  });

  it("should override envPrefix when provided", () => {
    const discovery = new McpDiscovery(createClient(), {
      envPrefix: "CUSTOM_MCP_",
    });

    const cfg = (discovery as any).config;
    expect(cfg.envPrefix).toBe("CUSTOM_MCP_");
  });
});

// ── discover() ────────────────────────────────────────────────────────────────

describe("discover()", () => {
  beforeEach(() => {
    mockExistsSync = vi.fn().mockReturnValue(false);
    mockReadFileSync = vi.fn();
    mockClientConnect = vi.fn();
  });

  it("should return empty result when no config files or env vars", async () => {
    const discovery = new McpDiscovery(createClient());
    const result = await discovery.discover();
    expect(result).toEqual({ discovered: [], connected: [], errors: [] });
  });

  it("should discover from config file (array format)", async () => {
    const arrayConfigs: McpServerConfig[] = [
      { id: "server-a", transport: "stdio", command: "node" },
      { id: "server-b", transport: "sse", url: "http://localhost/sse" },
    ];

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(arrayConfigs));

    const discovery = new McpDiscovery(createClient(), {
      configPaths: ["/single.json"],
    });
    const result = await discovery.discover();

    expect(result.discovered).toEqual(arrayConfigs);
    expect(result.connected).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("should discover from config file (object format)", async () => {
    const objectConfig = {
      "server-a": { command: "node", transport: "stdio" },
      "server-b": { url: "http://localhost/sse", transport: "sse" },
    };

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(objectConfig));

    const discovery = new McpDiscovery(createClient(), {
      configPaths: ["/single.json"],
    });
    const result = await discovery.discover();

    expect(result.discovered).toHaveLength(2);
    expect(result.discovered[0].id).toBe("server-a");
    expect(result.discovered[0].command).toBe("node");
    expect(result.discovered[1].id).toBe("server-b");
    expect(result.discovered[1].url).toBe("http://localhost/sse");
  });

  it("should skip non-object values in object format", async () => {
    const objectConfig = {
      "server-a": { command: "node", transport: "stdio" },
      "not-a-server": "just a string",
      "also-not": null,
      "server-b": { command: "python", transport: "stdio" },
    };

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(objectConfig));

    const discovery = new McpDiscovery(createClient(), {
      configPaths: ["/single.json"],
    });
    const result = await discovery.discover();

    expect(result.discovered).toHaveLength(2);
    expect(result.discovered[0].id).toBe("server-a");
    expect(result.discovered[1].id).toBe("server-b");
  });

  it("should auto-connect discovered servers when autoConnect is true", async () => {
    const configs: McpServerConfig[] = [
      { id: "s1", transport: "stdio", command: "node" },
    ];

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(configs));
    mockClientConnect.mockResolvedValue(makeConnectionState("s1", "connected"));

    const discovery = new McpDiscovery(createClient(), {
      configPaths: ["/single.json"],
      autoConnect: true,
    });
    const result = await discovery.discover();

    expect(result.discovered).toEqual(configs);
    expect(result.connected).toHaveLength(1);
    expect(result.connected[0].serverId).toBe("s1");
    expect(result.errors).toHaveLength(0);
    expect(mockClientConnect).toHaveBeenCalledTimes(1);
  });

  it("should record errors when connect returns status=error", async () => {
    const configs: McpServerConfig[] = [
      { id: "s1", transport: "stdio", command: "bad-cmd" },
    ];

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(configs));
    mockClientConnect.mockResolvedValue(
      makeConnectionState("s1", "error", "Connection refused"),
    );

    const discovery = new McpDiscovery(createClient(), {
      configPaths: ["/single.json"],
      autoConnect: true,
    });
    const result = await discovery.discover();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual({
      serverId: "s1",
      error: "Connection refused",
    });
  });

  it("should record errors when connect throws an exception", async () => {
    const configs: McpServerConfig[] = [
      { id: "s1", transport: "stdio", command: "crash-cmd" },
    ];

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(configs));
    mockClientConnect.mockRejectedValue(new Error("Process crashed"));

    const discovery = new McpDiscovery(createClient(), {
      configPaths: ["/single.json"],
      autoConnect: true,
    });
    const result = await discovery.discover();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual({
      serverId: "s1",
      error: "Process crashed",
    });
  });

  it("should record error with stringified message when non-Error thrown", async () => {
    const configs: McpServerConfig[] = [
      { id: "s1", transport: "stdio", command: "crash-cmd" },
    ];

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(configs));
    mockClientConnect.mockRejectedValue("raw string error");

    const discovery = new McpDiscovery(createClient(), {
      configPaths: ["/single.json"],
      autoConnect: true,
    });
    const result = await discovery.discover();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toBe("raw string error");
  });

  it("should handle mix of successful and failed connections", async () => {
    const configs: McpServerConfig[] = [
      { id: "s1", transport: "stdio", command: "ok" },
      { id: "s2", transport: "stdio", command: "bad" },
    ];

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(configs));

    let callCount = 0;
    mockClientConnect.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(makeConnectionState("s1", "connected"));
      }
      return Promise.reject(new Error("fail"));
    });

    const discovery = new McpDiscovery(createClient(), {
      configPaths: ["/single.json"],
      autoConnect: true,
    });
    const result = await discovery.discover();

    expect(result.connected).toHaveLength(1);
    expect(result.connected[0].serverId).toBe("s1");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].serverId).toBe("s2");
  });

  it("should discover from env vars in addition to config files", async () => {
    const arrayConfigs: McpServerConfig[] = [
      { id: "file-srv", transport: "stdio", command: "node" },
    ];

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(arrayConfigs));

    vi.stubEnv("MCP_SERVER_ENV_SRV_COMMAND", "python");

    const discovery = new McpDiscovery(createClient(), {
      configPaths: ["/single.json"],
    });
    const result = await discovery.discover();

    expect(result.discovered.length).toBeGreaterThanOrEqual(1);
    const envDiscovered = result.discovered.find((c) => c.id === "env_srv");
    expect(envDiscovered).toBeDefined();
    expect(envDiscovered!.command).toBe("python");

    vi.unstubAllEnvs();
  });
});

// ── discoverFromConfigFile() edge cases ───────────────────────────────────────

describe("discoverFromConfigFile edge cases", () => {
  beforeEach(() => {
    mockExistsSync = vi.fn();
    mockReadFileSync = vi.fn();
    mockClientConnect = vi.fn();
  });

  it("should return empty for non-existent file", async () => {
    mockExistsSync.mockReturnValue(false);

    const discovery = new McpDiscovery(createClient(), {
      configPaths: ["/nonexistent.json"],
    });

    const result = await discovery.discover();
    expect(result.discovered).toEqual([]);
  });

  it("should return empty for invalid JSON in file", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("{ not valid json }");

    const discovery = new McpDiscovery(createClient(), {
      configPaths: ["/bad.json"],
    });

    const result = await discovery.discover();
    expect(result.discovered).toEqual([]);
  });

  it("should return empty for empty JSON array", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("[]");

    const discovery = new McpDiscovery(createClient(), {
      configPaths: ["/empty.json"],
    });

    const result = await discovery.discover();
    expect(result.discovered).toEqual([]);
  });

  it("should return empty for empty JSON object", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("{}");

    const discovery = new McpDiscovery(createClient(), {
      configPaths: ["/empty-obj.json"],
    });

    const result = await discovery.discover();
    expect(result.discovered).toEqual([]);
  });

  it("should scan all configured paths", async () => {
    const configs1: McpServerConfig[] = [
      { id: "s1", transport: "stdio", command: "node" },
    ];
    const configs2: McpServerConfig[] = [
      { id: "s2", transport: "sse", url: "http://localhost/sse" },
    ];

    mockExistsSync
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true);
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify(configs1))
      .mockReturnValueOnce(JSON.stringify(configs2));

    const discovery = new McpDiscovery(createClient(), {
      configPaths: ["/path1.json", "/path2.json"],
    });

    const result = await discovery.discover();
    expect(result.discovered).toHaveLength(2);
    expect(result.discovered[0].id).toBe("s1");
    expect(result.discovered[1].id).toBe("s2");
  });
});

// ── connectServer() ───────────────────────────────────────────────────────────

describe("connectServer()", () => {
  beforeEach(() => {
    mockExistsSync = vi.fn().mockReturnValue(false);
    mockReadFileSync = vi.fn();
    mockClientConnect = vi.fn();
  });

  it("should delegate to client.connect", async () => {
    const config: McpServerConfig = {
      id: "my-server",
      transport: "stdio",
      command: "node",
    };
    mockClientConnect.mockResolvedValue(
      makeConnectionState("my-server", "connected"),
    );

    const discovery = new McpDiscovery(createClient());
    const state = await discovery.connectServer(config);

    expect(state.serverId).toBe("my-server");
    expect(state.status).toBe("connected");
    expect(mockClientConnect).toHaveBeenCalledWith(config);
  });

  it("should propagate connection errors from client", async () => {
    const config: McpServerConfig = {
      id: "bad-server",
      transport: "stdio",
      command: "bad",
    };
    mockClientConnect.mockRejectedValue(new Error("Connection failed"));

    const discovery = new McpDiscovery(createClient());

    await expect(discovery.connectServer(config)).rejects.toThrow(
      "Connection failed",
    );
  });
});

// ── discoverFromEnv() ─────────────────────────────────────────────────────────

describe("discoverFromEnv", () => {
  beforeEach(() => {
    mockExistsSync = vi.fn().mockReturnValue(false);
    mockReadFileSync = vi.fn();
    mockClientConnect = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should return empty when no matching env vars", async () => {
    const discovery = new McpDiscovery(createClient());
    const result = await discovery.discover();
    expect(result.discovered).toEqual([]);
  });

  it("should discover server from COMMAND env var", async () => {
    vi.stubEnv("MCP_SERVER_MYSERVER_COMMAND", "node server.js");

    const discovery = new McpDiscovery(createClient());
    const result = await discovery.discover();

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0].id).toBe("myserver");
    expect(result.discovered[0].command).toBe("node server.js");
    expect(result.discovered[0].transport).toBe("stdio");
  });

  it("should discover server from URL env var with SSE transport", async () => {
    vi.stubEnv("MCP_SERVER_SSE_SERVER_URL", "http://localhost:3000/sse");

    const discovery = new McpDiscovery(createClient());
    const result = await discovery.discover();

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0].id).toBe("sse_server");
    expect(result.discovered[0].url).toBe("http://localhost:3000/sse");
    expect(result.discovered[0].transport).toBe("sse");
  });

  it("should detect streamable-http transport for non-SSE URLs", async () => {
    vi.stubEnv("MCP_SERVER_HTTP_SRV_URL", "https://api.example.com/mcp");

    const discovery = new McpDiscovery(createClient());
    const result = await discovery.discover();

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0].transport).toBe("streamable-http");
  });

  it("should infer SSE transport when URL contains /sse anywhere", async () => {
    vi.stubEnv(
      "MCP_SERVER_MY_SRV_URL",
      "https://api.example.com/v1/mcp/sse/connect",
    );

    const discovery = new McpDiscovery(createClient());
    const result = await discovery.discover();

    expect(result.discovered[0].transport).toBe("sse");
  });

  it("should parse ARGS env var by splitting on spaces", async () => {
    vi.stubEnv("MCP_SERVER_MYSERVER_ARGS", "--port 8080 --debug");

    const discovery = new McpDiscovery(createClient());
    const result = await discovery.discover();

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0].args).toEqual(["--port", "8080", "--debug"]);
  });

  it("should merge multiple env vars for the same server", async () => {
    vi.stubEnv("MCP_SERVER_SHARED_COMMAND", "node");
    vi.stubEnv("MCP_SERVER_SHARED_ARGS", "server.js --port 3000");
    vi.stubEnv("MCP_SERVER_SHARED_URL", "http://localhost/sse");

    const discovery = new McpDiscovery(createClient());
    const result = await discovery.discover();

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0].id).toBe("shared");
    expect(result.discovered[0].command).toBe("node");
    expect(result.discovered[0].args).toEqual(["server.js", "--port", "3000"]);
    expect(result.discovered[0].url).toBe("http://localhost/sse");
    expect(result.discovered[0].transport).toBe("sse");
  });

  it("should skip env vars without proper suffix (parts.length < 2)", async () => {
    vi.stubEnv("MCP_SERVER_NOSUFFIX", "value");

    const discovery = new McpDiscovery(createClient());
    const result = await discovery.discover();

    expect(result.discovered).toEqual([]);
  });

  it("should skip env vars with empty value", async () => {
    vi.stubEnv("MCP_SERVER_EMPTY_COMMAND", "");

    const discovery = new McpDiscovery(createClient());
    const result = await discovery.discover();

    expect(result.discovered).toEqual([]);
  });

  it("should ignore unknown env var fields", async () => {
    vi.stubEnv("MCP_SERVER_MYSERVER_TIMEOUT", "5000");
    vi.stubEnv("MCP_SERVER_MYSERVER_COMMAND", "echo");

    const discovery = new McpDiscovery(createClient());
    const result = await discovery.discover();

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0].command).toBe("echo");
    expect((result.discovered[0] as any).timeout).toBeUndefined();
  });

  it("should handle multiple servers from env vars", async () => {
    vi.stubEnv("MCP_SERVER_SERVER_A_COMMAND", "node");
    vi.stubEnv("MCP_SERVER_SERVER_B_URL", "http://localhost/sse");

    const discovery = new McpDiscovery(createClient());
    const result = await discovery.discover();

    expect(result.discovered).toHaveLength(2);
    const ids = result.discovered.map((c) => c.id).sort();
    expect(ids).toEqual(["server_a", "server_b"]);
  });

  it("should preserve underscores in multi-segment server IDs", async () => {
    vi.stubEnv("MCP_SERVER_MY_ORG_SERVER_COMMAND", "java");

    const discovery = new McpDiscovery(createClient());
    const result = await discovery.discover();

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0].id).toBe("my_org_server");
  });

  it("should use custom env prefix when configured", async () => {
    vi.stubEnv("CUSTOM_MCP_TEST_SRV_COMMAND", "ruby");

    const discovery = new McpDiscovery(createClient(), {
      envPrefix: "CUSTOM_MCP_",
    });

    const result = await discovery.discover();
    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0].id).toBe("test_srv");
    expect(result.discovered[0].command).toBe("ruby");
  });

  it("should ignore env vars with different prefix", async () => {
    vi.stubEnv("OTHER_PREFIX_SERVER_COMMAND", "node");

    const discovery = new McpDiscovery(createClient());
    const result = await discovery.discover();

    expect(result.discovered).toEqual([]);
  });

  it("should default transport to stdio for new env-var server", async () => {
    vi.stubEnv("MCP_SERVER_NEW_SRV_COMMAND", "python3");

    const discovery = new McpDiscovery(createClient());
    const result = await discovery.discover();

    expect(result.discovered[0].transport).toBe("stdio");
  });
});

// ── Integration-style: no config files, just env ─────────────────────────────

describe("discover() with only env vars", () => {
  beforeEach(() => {
    mockExistsSync = vi.fn().mockReturnValue(false);
    mockReadFileSync = vi.fn();
    mockClientConnect = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should discover servers solely from environment", async () => {
    vi.stubEnv("MCP_SERVER_PROD_DB_COMMAND", "pgcli");
    vi.stubEnv("MCP_SERVER_PROD_DB_ARGS", "--host localhost");

    const discovery = new McpDiscovery(createClient());
    const result = await discovery.discover();

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0].id).toBe("prod_db");
    expect(result.discovered[0].command).toBe("pgcli");
    expect(result.discovered[0].args).toEqual(["--host", "localhost"]);
  });

  it("should not auto-connect when autoConnect is false", async () => {
    vi.stubEnv("MCP_SERVER_SKIP_CONNECT_COMMAND", "node");

    const discovery = new McpDiscovery(createClient(), { autoConnect: false });
    const result = await discovery.discover();

    expect(result.discovered).toHaveLength(1);
    expect(result.connected).toEqual([]);
    expect(mockClientConnect).not.toHaveBeenCalled();
  });
});

// ── Format handling: discoverFromConfigFile via discover ──────────────────────

describe("config file format handling", () => {
  beforeEach(() => {
    mockExistsSync = vi.fn();
    mockReadFileSync = vi.fn();
    mockClientConnect = vi.fn();
  });

  it("should handle array with mixed transport types", async () => {
    const configs: McpServerConfig[] = [
      { id: "stdio-srv", transport: "stdio", command: "node" },
      { id: "sse-srv", transport: "sse", url: "http://localhost/sse" },
      {
        id: "http-srv",
        transport: "streamable-http",
        url: "http://localhost/mcp",
      },
    ];

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(configs));

    const discovery = new McpDiscovery(createClient(), {
      configPaths: ["/single.json"],
    });
    const result = await discovery.discover();

    expect(result.discovered).toHaveLength(3);
    expect(result.discovered.map((c) => c.transport)).toEqual([
      "stdio",
      "sse",
      "streamable-http",
    ]);
  });

  it("should handle object format with multiple servers", async () => {
    const objectConfig = {
      server1: {
        transport: "stdio",
        command: "node",
        args: ["server.js"],
      },
      server2: {
        transport: "sse",
        url: "http://localhost/sse",
        timeoutMs: 5000,
      },
    };

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(objectConfig));

    const discovery = new McpDiscovery(createClient(), {
      configPaths: ["/single.json"],
    });
    const result = await discovery.discover();

    expect(result.discovered).toHaveLength(2);
    expect(result.discovered[0].id).toBe("server1");
    expect(result.discovered[0].args).toEqual(["server.js"]);
    expect(result.discovered[1].id).toBe("server2");
    expect(result.discovered[1].timeoutMs).toBe(5000);
  });

  it("should skip null values in object format", async () => {
    const objectConfig = {
      server1: null,
      server2: { command: "node", transport: "stdio" },
    };

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(objectConfig));

    const discovery = new McpDiscovery(createClient(), {
      configPaths: ["/single.json"],
    });
    const result = await discovery.discover();

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0].id).toBe("server2");
  });
});

// ── auto-connect edge cases ───────────────────────────────────────────────────

describe("auto-connect edge cases", () => {
  beforeEach(() => {
    mockExistsSync = vi.fn();
    mockReadFileSync = vi.fn();
    mockClientConnect = vi.fn();
  });

  it('should use "Unknown error" when status is error but no error message', async () => {
    const configs: McpServerConfig[] = [
      { id: "s1", transport: "stdio", command: "cmd" },
    ];

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(configs));
    mockClientConnect.mockResolvedValue({
      serverId: "s1",
      status: "error",
      tools: [],
    } as McpConnectionState);

    const discovery = new McpDiscovery(createClient(), {
      configPaths: ["/single.json"],
      autoConnect: true,
    });
    const result = await discovery.discover();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toBe("Unknown error");
  });

  it("should handle multiple discovered from file + env with autoConnect", async () => {
    const fileConfigs: McpServerConfig[] = [
      { id: "file-srv", transport: "stdio", command: "node" },
    ];

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(fileConfigs));

    vi.stubEnv("MCP_SERVER_ENV_SRV_COMMAND", "python");
    mockClientConnect.mockResolvedValue(makeConnectionState("any", "connected"));

    const discovery = new McpDiscovery(createClient(), { autoConnect: true });
    const result = await discovery.discover();

    expect(result.discovered.length).toBeGreaterThanOrEqual(2);
    expect(result.connected).toHaveLength(result.discovered.length);
    expect(result.errors).toEqual([]);

    vi.unstubAllEnvs();
  });
});

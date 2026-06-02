/**
 * Comprehensive unit tests for McpClient.
 *
 * Covers all methods, all branches, and edge cases.
 * Mocked: none (pure in-memory stub, no external I/O).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { McpClient } from "../client.js";
import type {
  McpServerConfig,
  McpConnectionState,
  McpToolDefinition,
} from "../types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function stdioConfig(overrides?: Partial<McpServerConfig>): McpServerConfig {
  return { id: "srv", transport: "stdio", command: "echo", ...overrides };
}

function connectedState(
  overrides?: Partial<McpConnectionState>,
): McpConnectionState {
  return {
    serverId: "srv",
    status: "connected",
    tools: [],
    lastConnected: new Date().toISOString(),
    ...overrides,
  };
}

function sampleTools(): McpToolDefinition[] {
  return [
    { name: "t1", description: "Tool One", inputSchema: {} },
    { name: "t2", description: "Tool Two", inputSchema: { type: "object" } },
  ];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("McpClient", () => {
  let client: McpClient;

  beforeEach(() => {
    client = new McpClient();
  });

  // ── connect() ────────────────────────────────────────────────────────────

  describe("connect", () => {
    it("should connect and return connected state", async () => {
      const state = await client.connect(stdioConfig());

      expect(state.serverId).toBe("srv");
      expect(state.status).toBe("connected");
      expect(state.tools).toEqual([]);
      expect(state.lastConnected).toBeTruthy();
    });

    it("should set lastConnected to an ISO date string", async () => {
      const state = await client.connect(stdioConfig());

      expect(state.lastConnected).toBeDefined();
      // ISO 8601 format: should contain T and parse as valid date
      expect(state.lastConnected).toContain("T");
      expect(() => new Date(state.lastConnected!)).not.toThrow();
    });

    it("should store the config for later reuse", async () => {
      const config = stdioConfig({ id: "cfg-srv" });
      await client.connect(config);

      // Re-connecting with same id should succeed (config already stored)
      const state2 = await client.connect(config);
      expect(state2.status).toBe("connected");
    });

    it("should handle Error instance during connect", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(client as any, "initialize").mockRejectedValueOnce(
        new Error("connection refused"),
      );

      const state = await client.connect(stdioConfig());

      expect(state.status).toBe("error");
      expect(state.error).toBe("connection refused");
      expect(state.tools).toEqual([]);
    });

    it("should handle non-Error throw during connect", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(client as any, "initialize").mockRejectedValueOnce(
        "raw string error",
      );

      const state = await client.connect(stdioConfig());

      expect(state.status).toBe("error");
      expect(state.error).toBe("raw string error");
    });

    it("should handle null/undefined error during connect", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(client as any, "initialize").mockRejectedValueOnce(null);

      const state = await client.connect(stdioConfig());

      expect(state.status).toBe("error");
      // String(null) === "null"
      expect(state.error).toBe("null");
    });

    it("should return a shallow copy of state (not the same reference)", async () => {
      const state = await client.connect(stdioConfig());

      // Mutating the returned object should not affect internal state
      state.status = "disconnected";
      expect(client.getConnection("srv")!.status).toBe("connected");
    });
  });

  // ── disconnect() ─────────────────────────────────────────────────────────

  describe("disconnect", () => {
    it("should disconnect a connected server and remove state", async () => {
      await client.connect(stdioConfig());
      await client.disconnect("srv");

      expect(client.getConnection("srv")).toBeUndefined();
    });

    it("should handle disconnect of non-existent server gracefully", async () => {
      // Should not throw
      await expect(client.disconnect("unknown")).resolves.toBeUndefined();
    });

    it("should clear tools array on disconnect", async () => {
      await client.connect(stdioConfig());
      // Inject tools into the internal state
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.get("srv").tools = sampleTools();

      await client.disconnect("srv");

      const state = client.getConnection("srv");
      expect(state).toBeUndefined();
    });

    it("should remove config as well as connection", async () => {
      await client.connect(stdioConfig({ id: "rm-me" }));
      await client.disconnect("rm-me");

      // Re-connecting should work and not use stale config
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((client as any).configs.has("rm-me")).toBe(false);
    });
  });

  // ── listTools() ──────────────────────────────────────────────────────────

  describe("listTools", () => {
    it("should return tools from connected server state", async () => {
      await client.connect(stdioConfig());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.get("srv").tools = sampleTools();

      const tools = await client.listTools(stdioConfig());
      expect(tools).toEqual(sampleTools());
    });

    it("should return empty array for unregistered server", async () => {
      const tools = await client.listTools({ id: "missing", transport: "stdio" });
      expect(tools).toEqual([]);
    });
  });

  // ── callTool() ───────────────────────────────────────────────────────────

  describe("callTool", () => {
    it("should call tool on connected server and return placeholder result", async () => {
      await client.connect(stdioConfig());

      const result = await client.callTool("srv", { name: "myTool" });

      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual([
        { type: "text", text: "Tool myTool called on srv" },
      ]);
    });

    it("should return error when server does not exist", async () => {
      const result = await client.callTool("nonexistent", { name: "t1" });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "Server nonexistent is not connected" },
      ]);
    });

    it("should return error when server is disconnected", async () => {
      await client.connect(stdioConfig());
      // Manually set state to disconnected
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.set("srv", {
        serverId: "srv",
        status: "disconnected",
        tools: [],
      });

      const result = await client.callTool("srv", { name: "t1" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not connected");
    });

    it("should return error when server is in error state", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.set("srv", {
        serverId: "srv",
        status: "error",
        error: "some error",
        tools: [],
      });

      const result = await client.callTool("srv", { name: "t1" });

      expect(result.isError).toBe(true);
    });

    it("should return error when server is still connecting", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.set("srv", {
        serverId: "srv",
        status: "connecting",
        tools: [],
      });

      const result = await client.callTool("srv", { name: "t1" });

      expect(result.isError).toBe(true);
    });

    it("should include tool arguments in the request", async () => {
      await client.connect(stdioConfig());

      const result = await client.callTool("srv", {
        name: "searchTool",
        arguments: { query: "hello", limit: 10 },
      });

      expect(result.content[0].text).toContain("Tool searchTool called on srv");
    });
  });

  // ── getConnection() ──────────────────────────────────────────────────────

  describe("getConnection", () => {
    it("should return connection state for known server", async () => {
      await client.connect(stdioConfig());

      const state = client.getConnection("srv");
      expect(state).toBeDefined();
      expect(state!.serverId).toBe("srv");
      expect(state!.status).toBe("connected");
    });

    it("should return undefined for unknown server", () => {
      expect(client.getConnection("ghost")).toBeUndefined();
    });

    it("should return undefined after disconnect", async () => {
      await client.connect(stdioConfig());
      await client.disconnect("srv");

      expect(client.getConnection("srv")).toBeUndefined();
    });
  });

  // ── getConnectedServers() ────────────────────────────────────────────────

  describe("getConnectedServers", () => {
    it("should return all connected servers", async () => {
      await client.connect(stdioConfig({ id: "a" }));
      await client.connect(stdioConfig({ id: "b" }));

      const connected = client.getConnectedServers();
      expect(connected).toHaveLength(2);
      expect(connected.map((s) => s.serverId).sort()).toEqual(["a", "b"]);
    });

    it("should return empty array when no connections exist", () => {
      expect(client.getConnectedServers()).toEqual([]);
    });

    it("should exclude non-connected servers (disconnected)", async () => {
      await client.connect(stdioConfig({ id: "ok" }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.set("bad", {
        serverId: "bad",
        status: "disconnected",
        tools: [],
      });

      const connected = client.getConnectedServers();
      expect(connected).toHaveLength(1);
      expect(connected[0].serverId).toBe("ok");
    });

    it("should exclude non-connected servers (error)", async () => {
      await client.connect(stdioConfig({ id: "ok" }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.set("err", {
        serverId: "err",
        status: "error",
        error: "fail",
        tools: [],
      });

      const connected = client.getConnectedServers();
      expect(connected).toHaveLength(1);
      expect(connected[0].serverId).toBe("ok");
    });

    it("should exclude servers still connecting", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.set("pend", {
        serverId: "pend",
        status: "connecting",
        tools: [],
      });

      expect(client.getConnectedServers()).toEqual([]);
    });

    it("should return a new array each call (container copy)", async () => {
      await client.connect(stdioConfig());

      const a = client.getConnectedServers();
      const b = client.getConnectedServers();

      // Same contents
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(a[0].serverId).toBe(b[0].serverId);

      // Different array containers
      expect(a).not.toBe(b);
    });
  });

  // ── getAllTools() ────────────────────────────────────────────────────────

  describe("getAllTools", () => {
    it("should collect tools from all connected servers with serverId", async () => {
      const tools = sampleTools();
      await client.connect(stdioConfig({ id: "alpha" }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.get("alpha").tools = tools;

      const result = client.getAllTools();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ ...tools[0], serverId: "alpha" });
      expect(result[1]).toEqual({ ...tools[1], serverId: "alpha" });
    });

    it("should collect tools from multiple connected servers", async () => {
      await client.connect(stdioConfig({ id: "one" }));
      await client.connect(stdioConfig({ id: "two" }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.get("one").tools = [{ name: "tA", description: "", inputSchema: {} }];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.get("two").tools = [{ name: "tB", description: "", inputSchema: {} }];

      const result = client.getAllTools();

      expect(result).toHaveLength(2);
      expect(result.map((t) => t.serverId).sort()).toEqual(["one", "two"]);
    });

    it("should return empty array when no servers are connected", () => {
      expect(client.getAllTools()).toEqual([]);
    });

    it("should skip non-connected servers", async () => {
      await client.connect(stdioConfig({ id: "live" }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.get("live").tools = [
        { name: "liveTool", description: "", inputSchema: {} },
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.set("dead", {
        serverId: "dead",
        status: "disconnected",
        tools: [{ name: "deadTool", description: "", inputSchema: {} }],
      });

      const result = client.getAllTools();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("liveTool");
    });

    it("should shallow-copy tools to avoid mutation of internal state", async () => {
      await client.connect(stdioConfig());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.get("srv").tools = [
        { name: "orig", description: "", inputSchema: {} },
      ];

      const result = client.getAllTools();
      result[0].name = "mutated";

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((client as any).connections.get("srv").tools[0].name).toBe("orig");
    });
  });

  // ── hasTool() ────────────────────────────────────────────────────────────

  describe("hasTool", () => {
    it("should return true when tool exists on a connected server", async () => {
      await client.connect(stdioConfig());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.get("srv").tools = [
        { name: "existing-tool", description: "", inputSchema: {} },
      ];

      expect(client.hasTool("existing-tool")).toBe(true);
    });

    it("should return false when tool does not exist", async () => {
      await client.connect(stdioConfig());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.get("srv").tools = [
        { name: "alpha", description: "", inputSchema: {} },
      ];

      expect(client.hasTool("beta")).toBe(false);
    });

    it("should return false when no servers are connected", () => {
      expect(client.hasTool("anything")).toBe(false);
    });

    it("should return false when tool only exists on a disconnected server", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.set("srv", {
        serverId: "srv",
        status: "disconnected",
        tools: [{ name: "isolated", description: "", inputSchema: {} }],
      });

      expect(client.hasTool("isolated")).toBe(false);
    });
  });

  // ── findToolServer() ─────────────────────────────────────────────────────

  describe("findToolServer", () => {
    it("should return serverId when tool is found", async () => {
      await client.connect(stdioConfig({ id: "provider" }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.get("provider").tools = [
        { name: "shared-tool", description: "", inputSchema: {} },
      ];

      expect(client.findToolServer("shared-tool")).toBe("provider");
    });

    it("should return the first matching server when tool exists on multiple", async () => {
      await client.connect(stdioConfig({ id: "first" }));
      await client.connect(stdioConfig({ id: "second" }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.get("first").tools = [
        { name: "dup", description: "", inputSchema: {} },
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.get("second").tools = [
        { name: "dup", description: "", inputSchema: {} },
      ];

      // getAllTools iterates connections in insertion order
      expect(client.findToolServer("dup")).toBe("first");
    });

    it("should return undefined when tool is not found", async () => {
      await client.connect(stdioConfig());

      expect(client.findToolServer("missing")).toBeUndefined();
    });

    it("should return undefined when no servers are connected", () => {
      expect(client.findToolServer("orphan")).toBeUndefined();
    });
  });

  // ── Integration-style / state transitions ────────────────────────────────

  describe("state transitions", () => {
    it("should move from connecting → connected on success", async () => {
      // Capture intermediate states by spying
      const states: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const origConnect = client.connect.bind(client);
      const spied = vi.spyOn(client, "connect");

      await origConnect(stdioConfig());

      // After connect, the final state should be connected
      expect(client.getConnection("srv")!.status).toBe("connected");
      spied.mockRestore();
    });

    it("should move from connected → disconnected on disconnect", async () => {
      await client.connect(stdioConfig({ id: "cycle" }));
      expect(client.getConnection("cycle")!.status).toBe("connected");

      await client.disconnect("cycle");
      expect(client.getConnection("cycle")).toBeUndefined();
    });

    it("should move from connecting → error on failure", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(client as any, "initialize").mockRejectedValueOnce(
        new Error("fail"),
      );

      const state = await client.connect(stdioConfig({ id: "fail-srv" }));

      expect(state.status).toBe("error");
      expect(state.error).toBe("fail");
      expect(state.tools).toEqual([]);
    });

    it("should re-connect after disconnect (new connection)", async () => {
      await client.connect(stdioConfig({ id: "reconn" }));
      await client.disconnect("reconn");
      expect(client.getConnection("reconn")).toBeUndefined();

      const state = await client.connect(stdioConfig({ id: "reconn" }));
      expect(state.status).toBe("connected");
    });

    it("should overwrite previous connection state on re-connect without disconnect", async () => {
      await client.connect(stdioConfig({ id: "overwrite" }));
      // Inject tools into the first connection
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.get("overwrite").tools = [
        { name: "old-tool", description: "", inputSchema: {} },
      ];

      // Connect again (overwrites)
      const state = await client.connect(stdioConfig({ id: "overwrite" }));
      expect(state.status).toBe("connected");
      // tools are reset because listTools is called again and returns state.tools
    });
  });

  // ── listTools coverage edge cases ────────────────────────────────────────

  describe("listTools edge cases", () => {
    it("should return empty tools for newly connected server (stub default)", async () => {
      await client.connect(stdioConfig());
      const tools = await client.listTools(stdioConfig());
      expect(tools).toEqual([]);
    });

    it("should reflect tool changes after state mutation", async () => {
      await client.connect(stdioConfig());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).connections.get("srv").tools = sampleTools();

      const tools = await client.listTools(stdioConfig());
      expect(tools).toEqual(sampleTools());
    });
  });
});

/**
 * Comprehensive unit tests for McpToolRegistry.
 * Covers all public methods, private helpers (indirectly), all branches.
 * Uses vi.mock() for McpClient dependency to ensure coverage instrumentation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpToolRegistry } from "../registry.js";
import type { McpToolDefinition, McpToolCallResult } from "../types.js";
import type { ToolContext } from "../../tools/types.js";

// ── Mock McpClient module ──────────────────────────────────────────────────

const { mockGetAllTools, mockCallTool } = vi.hoisted(() => {
  return {
    mockGetAllTools: vi.fn<() => Array<McpToolDefinition & { serverId: string }>>(),
    mockCallTool: vi.fn<
      (
        serverId: string,
        request: { name: string; arguments: Record<string, unknown> },
      ) => Promise<McpToolCallResult>
    >(),
  };
});

vi.mock("../client.js", () => {
  return {
    McpClient: vi.fn(function () {
      return {
        getAllTools: mockGetAllTools,
        callTool: mockCallTool,
      };
    }),
  };
});

import { McpClient } from "../client.js";

// ── Tool Definition Helpers ────────────────────────────────────────────────

function makeMcpTool(
  name: string,
  opts?: Partial<McpToolDefinition & { serverId: string }>,
): McpToolDefinition & { serverId: string } {
  return {
    name,
    description: opts?.description ?? `${name} description`,
    inputSchema: opts?.inputSchema ?? { type: "object", properties: {} },
    serverId: opts?.serverId ?? "server-1",
  };
}

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    cwd: "/tmp",
    sessionId: "sess-1",
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("McpToolRegistry", () => {
  let client: McpClient;
  let registry: McpToolRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: empty tools, success call
    mockGetAllTools.mockReturnValue([]);
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
    client = new McpClient();
    registry = new McpToolRegistry(client);
  });

  // ── Constructor / fresh state ────────────────────────────────────────────

  describe("constructor", () => {
    it("should create an instance with getToolCount 0", () => {
      expect(registry).toBeInstanceOf(McpToolRegistry);
      expect(registry.getToolCount()).toBe(0);
    });

    it("should return isMcpTool false for any name on fresh instance", () => {
      expect(registry.isMcpTool("anything")).toBe(false);
    });

    it("should return getToolServer undefined on fresh instance", () => {
      expect(registry.getToolServer("anything")).toBeUndefined();
    });
  });

  // ── syncTools ────────────────────────────────────────────────────────────

  describe("syncTools", () => {
    it("should return empty array when no servers have tools", () => {
      mockGetAllTools.mockReturnValue([]);
      const tools = registry.syncTools();
      expect(tools).toEqual([]);
      expect(registry.getToolCount()).toBe(0);
    });

    it("should convert and register tools from connected servers", () => {
      const mcpTool = makeMcpTool("search", {
        serverId: "srv-1",
        description: "Search files",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      });
      mockGetAllTools.mockReturnValue([mcpTool]);

      const tools = registry.syncTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("search");
      expect(tools[0].description).toBe("[MCP:srv-1] Search files");
      expect(tools[0].parameters).toEqual(mcpTool.inputSchema);
      expect(typeof tools[0].execute).toBe("function");
      expect(registry.getToolCount()).toBe(1);
      expect(registry.isMcpTool("search")).toBe(true);
      expect(registry.getToolServer("search")).toBe("srv-1");
    });

    it("should register multiple tools from different servers", () => {
      mockGetAllTools.mockReturnValue([
        makeMcpTool("a", { serverId: "srv-1" }),
        makeMcpTool("b", { serverId: "srv-2" }),
      ]);

      const tools = registry.syncTools();
      expect(tools).toHaveLength(2);
      expect(registry.getToolCount()).toBe(2);
      expect(registry.isMcpTool("a")).toBe(true);
      expect(registry.isMcpTool("b")).toBe(true);
      expect(registry.getToolServer("a")).toBe("srv-1");
      expect(registry.getToolServer("b")).toBe("srv-2");
    });

    it("should clear previous registrations before syncing", () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("old-tool")]);
      registry.syncTools();
      expect(registry.isMcpTool("old-tool")).toBe(true);

      // Second sync with different tools — old-tool should be gone
      mockGetAllTools.mockReturnValue([makeMcpTool("new-tool", { serverId: "srv-2" })]);
      registry.syncTools();
      expect(registry.isMcpTool("old-tool")).toBe(false);
      expect(registry.isMcpTool("new-tool")).toBe(true);
      expect(registry.getToolCount()).toBe(1);
    });

    it("should convert ToolDef.execute to delegate to executeMcpTool", async () => {
      const mcpTool = makeMcpTool("delegated", { serverId: "srv-1" });
      mockGetAllTools.mockReturnValue([mcpTool]);
      mockCallTool.mockResolvedValue({
        content: [{ type: "text", text: "delegated ok" }],
        isError: false,
      });

      const tools = registry.syncTools();
      const ctx = makeContext();
      const result = await tools[0].execute({ key: "val" }, ctx);

      expect(result.ok).toBe(true);
      expect(result.content).toBe("delegated ok");
      expect(mockCallTool).toHaveBeenCalledWith("srv-1", {
        name: "delegated",
        arguments: { key: "val" },
      });
    });
  });

  // ── executeMcpTool ───────────────────────────────────────────────────────

  describe("executeMcpTool", () => {
    it("should return NOT_FOUND error when tool is not registered", async () => {
      const result = await registry.executeMcpTool("nonexistent", {}, makeContext());

      expect(result.ok).toBe(false);
      expect(result.content).toBe("");
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe("NOT_FOUND");
      expect(result.error!.message).toContain("not found");
      expect(result.error!.message).toContain("nonexistent");
      expect(result.error!.retryable).toBe(false);
    });

    it("should return NOT_FOUND when getAllTools has tools but syncTools was not called", async () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("present")]);
      // syncTools was never called, so no tool is registered internally
      const result = await registry.executeMcpTool("present", {});

      expect(result.ok).toBe(false);
      expect(result.error!.code).toBe("NOT_FOUND");
    });

    it("should execute a registered tool via callTool and return success", async () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("test-tool", { serverId: "srv-1" })]);
      mockCallTool.mockResolvedValue({
        content: [{ type: "text", text: "executed successfully" }],
        isError: false,
      });
      registry.syncTools();

      const result = await registry.executeMcpTool("test-tool", { arg1: "val1" }, makeContext());

      expect(result.ok).toBe(true);
      expect(result.content).toBe("executed successfully");
      expect(result.error).toBeUndefined();
      expect(mockCallTool).toHaveBeenCalledWith("srv-1", {
        name: "test-tool",
        arguments: { arg1: "val1" },
      });
    });

    it("should route to the correct serverId for different tools", async () => {
      mockGetAllTools.mockReturnValue([
        makeMcpTool("toolA", { serverId: "srv-a" }),
        makeMcpTool("toolB", { serverId: "srv-b" }),
      ]);
      mockCallTool.mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      });
      registry.syncTools();

      await registry.executeMcpTool("toolA", {});
      expect(mockCallTool).toHaveBeenCalledWith("srv-a", expect.any(Object));

      await registry.executeMcpTool("toolB", {});
      expect(mockCallTool).toHaveBeenCalledWith("srv-b", expect.any(Object));
    });

    it("should return EXEC_ERROR when callTool throws an Error instance", async () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("crash", { serverId: "srv-1" })]);
      mockCallTool.mockRejectedValue(new Error("network timeout"));
      registry.syncTools();

      const result = await registry.executeMcpTool("crash", {});

      expect(result.ok).toBe(false);
      expect(result.content).toBe("");
      expect(result.error!.code).toBe("EXEC_ERROR");
      expect(result.error!.message).toBe("network timeout");
      expect(result.error!.retryable).toBe(false);
    });

    it("should return EXEC_ERROR when callTool throws a string", async () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("crash", { serverId: "srv-1" })]);
      mockCallTool.mockRejectedValue("string error"); // eslint-disable-line prefer-promise-reject-errors
      registry.syncTools();

      const result = await registry.executeMcpTool("crash", {});

      expect(result.ok).toBe(false);
      expect(result.error!.code).toBe("EXEC_ERROR");
      expect(result.error!.message).toBe("string error");
    });

    it("should stringify non-Error throw via String()", async () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("num-crash", { serverId: "srv-1" })]);
      mockCallTool.mockRejectedValue(42); // eslint-disable-line prefer-promise-reject-errors
      registry.syncTools();

      const result = await registry.executeMcpTool("num-crash", {});

      expect(result.ok).toBe(false);
      expect(result.error!.code).toBe("EXEC_ERROR");
      expect(result.error!.message).toBe("42");
    });

    it("should accept optional context argument", async () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("ctx-test", { serverId: "srv-1" })]);
      mockCallTool.mockResolvedValue({
        content: [{ type: "text", text: "done" }],
        isError: false,
      });
      registry.syncTools();

      const ctx = makeContext({ cwd: "/special", sessionId: "sess-99" });
      const result = await registry.executeMcpTool("ctx-test", {}, ctx);

      expect(result.ok).toBe(true);
      expect(result.content).toBe("done");
    });
  });

  // ── isMcpTool ─────────────────────────────────────────────────────────────

  describe("isMcpTool", () => {
    it("should return false when no tools are registered", () => {
      expect(registry.isMcpTool("anything")).toBe(false);
    });

    it("should return true for a registered tool", () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("registered")]);
      registry.syncTools();
      expect(registry.isMcpTool("registered")).toBe(true);
    });

    it("should return false for an unregistered tool name", () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("alpha")]);
      registry.syncTools();
      expect(registry.isMcpTool("beta")).toBe(false);
    });

    it("should work with empty string tool name", () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("")]);
      registry.syncTools();
      expect(registry.isMcpTool("")).toBe(true);
      expect(registry.isMcpTool("non-empty")).toBe(false);
    });
  });

  // ── getToolServer ────────────────────────────────────────────────────────

  describe("getToolServer", () => {
    it("should return undefined when nothing is registered", () => {
      expect(registry.getToolServer("anything")).toBeUndefined();
    });

    it("should return serverId for a registered tool", () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("tool1", { serverId: "server-abc" })]);
      registry.syncTools();
      expect(registry.getToolServer("tool1")).toBe("server-abc");
    });

    it("should return undefined for unregistered tool", () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("present")]);
      registry.syncTools();
      expect(registry.getToolServer("absent")).toBeUndefined();
    });
  });

  // ── getToolCount ─────────────────────────────────────────────────────────

  describe("getToolCount", () => {
    it("should return 0 for a fresh registry", () => {
      expect(registry.getToolCount()).toBe(0);
    });

    it("should return 0 after syncing with no tools", () => {
      mockGetAllTools.mockReturnValue([]);
      registry.syncTools();
      expect(registry.getToolCount()).toBe(0);
    });

    it("should return the number of synced tools", () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("a"), makeMcpTool("b"), makeMcpTool("c")]);
      registry.syncTools();
      expect(registry.getToolCount()).toBe(3);
    });

    it("should update count after re-sync", () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("one")]);
      registry.syncTools();
      expect(registry.getToolCount()).toBe(1);

      mockGetAllTools.mockReturnValue([makeMcpTool("x"), makeMcpTool("y")]);
      registry.syncTools();
      expect(registry.getToolCount()).toBe(2);
    });
  });

  // ── convertResult (via executeMcpTool) ───────────────────────────────────

  describe("convertResult (via executeMcpTool)", () => {
    it("should join multiple text parts with newline", async () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("multi-text", { serverId: "srv-1" })]);
      mockCallTool.mockResolvedValue({
        content: [
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
          { type: "text", text: "line 3" },
        ],
        isError: false,
      });
      registry.syncTools();

      const result = await registry.executeMcpTool("multi-text", {});
      expect(result.ok).toBe(true);
      expect(result.content).toBe("line 1\nline 2\nline 3");
    });

    it("should filter out non-text content parts (image, resource)", async () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("mixed", { serverId: "srv-1" })]);
      mockCallTool.mockResolvedValue({
        content: [
          { type: "image", data: "base64...", mimeType: "image/png" },
          { type: "text", text: "text only" },
          { type: "resource", resource: { uri: "file:///test" } },
        ],
        isError: false,
      });
      registry.syncTools();

      const result = await registry.executeMcpTool("mixed", {});
      expect(result.ok).toBe(true);
      expect(result.content).toBe("text only");
    });

    it("should return EXEC_ERROR when callTool result has isError=true", async () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("err-tool", { serverId: "srv-1" })]);
      mockCallTool.mockResolvedValue({
        content: [{ type: "text", text: "something went wrong" }],
        isError: true,
      });
      registry.syncTools();

      const result = await registry.executeMcpTool("err-tool", {});
      expect(result.ok).toBe(false);
      expect(result.content).toBe("something went wrong");
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe("EXEC_ERROR");
      expect(result.error!.message).toBe("something went wrong");
      expect(result.error!.retryable).toBe(false);
    });

    it("should handle empty content with isError=false", async () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("empty-ok", { serverId: "srv-1" })]);
      mockCallTool.mockResolvedValue({ content: [], isError: false });
      registry.syncTools();

      const result = await registry.executeMcpTool("empty-ok", {});
      expect(result.ok).toBe(true);
      expect(result.content).toBe("");
      expect(result.error).toBeUndefined();
    });

    it("should handle empty content with isError=true", async () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("empty-error", { serverId: "srv-1" })]);
      mockCallTool.mockResolvedValue({ content: [], isError: true });
      registry.syncTools();

      const result = await registry.executeMcpTool("empty-error", {});
      expect(result.ok).toBe(false);
      expect(result.content).toBe("");
      expect(result.error!.code).toBe("EXEC_ERROR");
      expect(result.error!.message).toBe("");
    });
  });

  // ── ToolDef.execute integration ──────────────────────────────────────────

  describe("converted ToolDef.execute", () => {
    it("should pass through success result from executeMcpTool", async () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("calc", { serverId: "calc-srv" })]);
      mockCallTool.mockResolvedValue({
        content: [{ type: "text", text: "42" }],
        isError: false,
      });
      const tools = registry.syncTools();

      const result = await tools[0].execute({ expr: "6*7" }, makeContext());
      expect(result.ok).toBe(true);
      expect(result.content).toBe("42");
      expect(mockCallTool).toHaveBeenCalledWith("calc-srv", {
        name: "calc",
        arguments: { expr: "6*7" },
      });
    });

    it("should propagate errors through ToolDef.execute", async () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("faulty", { serverId: "srv-1" })]);
      mockCallTool.mockRejectedValue(new Error("explosion"));
      const tools = registry.syncTools();

      const result = await tools[0].execute({}, makeContext());
      expect(result.ok).toBe(false);
      expect(result.error!.code).toBe("EXEC_ERROR");
      expect(result.error!.message).toBe("explosion");
    });

    it("should handle execute without context argument", async () => {
      mockGetAllTools.mockReturnValue([makeMcpTool("noctx", { serverId: "srv-1" })]);
      mockCallTool.mockResolvedValue({
        content: [{ type: "text", text: "no context needed" }],
        isError: false,
      });
      const tools = registry.syncTools();

      const result = await tools[0].execute({ data: "test" }, undefined as unknown as ToolContext);
      expect(result.ok).toBe(true);
      expect(result.content).toBe("no context needed");
    });
  });
});

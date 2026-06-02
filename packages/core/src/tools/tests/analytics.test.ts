import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

const {
  mockWriteToolCall,
  mockWriteToolResult,
  mockSessionStoreConstructor,
} = vi.hoisted(() => {
  const write = vi.fn();
  const result = vi.fn();

  // Stub constructable class whose instances share the mock fns above.
  class Store {
    writeToolCall = write;
    writeToolResult = result;
  }

  return {
    mockWriteToolCall: write,
    mockWriteToolResult: result,
    mockSessionStoreConstructor: Store,
  };
});

vi.mock("../../session/store.js", () => ({
  SessionStore: mockSessionStoreConstructor,
}));

import { AnalyticsPlugin } from "../analytics.js";
import type { ToolContext, ToolResult } from "../types.js";
import { SessionStore } from "../../session/store.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: "/workspace/project",
    sessionId: "test-session-1",
    ...overrides,
  };
}

function makeResult(overrides: Partial<ToolResult> = {}): ToolResult {
  return {
    ok: true,
    content: "tool output",
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("AnalyticsPlugin", () => {
  let plugin: AnalyticsPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteToolCall.mockReturnValue("mock-uuid-1");
    plugin = new AnalyticsPlugin(new SessionStore());
  });

  // ── onBeforeToolCall ─────────────────────────────────────────────────────

  describe("onBeforeToolCall", () => {
    it("generates a toolCallId in the format name-timestamp", async () => {
      const before = Date.now();
      const result = await plugin.onBeforeToolCall(
        "read_file",
        { path: "/foo.txt" },
        makeCtx()
      );
      const after = Date.now();

      // Should return null (never intercept)
      expect(result).toBeNull();

      // Verify writeToolCall was called with the right shape
      expect(mockWriteToolCall).toHaveBeenCalledTimes(1);
      const callArgs = mockWriteToolCall.mock.calls[0]![0] as {
        parentUuid: string;
        toolName: string;
        toolCallId: string;
        arguments: Record<string, unknown>;
      };
      expect(callArgs.parentUuid).toBe("test-session-1");
      expect(callArgs.toolName).toBe("read_file");
      expect(callArgs.arguments).toEqual({ path: "/foo.txt" });
      // toolCallId should match pattern read_file-<timestamp>
      expect(callArgs.toolCallId).toMatch(/^read_file-\d+$/);
      const idTimestamp = Number(callArgs.toolCallId.split("-").pop()!);
      expect(idTimestamp).toBeGreaterThanOrEqual(before);
      expect(idTimestamp).toBeLessThanOrEqual(after);
    });

    it("writes tool call to the SessionStore", async () => {
      mockWriteToolCall.mockReturnValue("generated-uuid-abc");

      await plugin.onBeforeToolCall("grep", { pattern: "foo" }, makeCtx());

      expect(mockWriteToolCall).toHaveBeenCalledWith({
        parentUuid: "test-session-1",
        toolName: "grep",
        toolCallId: expect.stringMatching(/^grep-\d+$/) as unknown as string,
        arguments: { pattern: "foo" },
      });
    });

    it("stores the returned uuid as a pending call", async () => {
      mockWriteToolCall.mockReturnValue("uuid-store-42");

      await plugin.onBeforeToolCall(
        "list_dir",
        { path: "/" },
        makeCtx({ sessionId: "sess-xyz" })
      );

      // Now call onAfterToolCall — should use the stored uuid as parentUuid
      await plugin.onAfterToolCall(
        "list_dir",
        { path: "/" },
        makeResult({ content: "ok" }),
        makeCtx({ sessionId: "sess-xyz" })
      );

      expect(mockWriteToolResult).toHaveBeenCalledWith({
        parentUuid: "uuid-store-42",
        toolCallId: "list_dir",
        content: "ok",
      });
    });

    it("returns null for every call (never intercepts execution)", async () => {
      const r1 = await plugin.onBeforeToolCall("a", {}, makeCtx());
      const r2 = await plugin.onBeforeToolCall("b", {}, makeCtx());
      const r3 = await plugin.onBeforeToolCall("c", {}, makeCtx());

      expect(r1).toBeNull();
      expect(r2).toBeNull();
      expect(r3).toBeNull();
    });

    it("tracks different session IDs separately", async () => {
      mockWriteToolCall
        .mockReturnValueOnce("uuid-session-a")
        .mockReturnValueOnce("uuid-session-b");

      const ctxA = makeCtx({ sessionId: "session-a" });
      const ctxB = makeCtx({ sessionId: "session-b" });

      await plugin.onBeforeToolCall("tool", { x: 1 }, ctxA);
      await plugin.onBeforeToolCall("tool", { x: 2 }, ctxB);

      // Verify both calls were made
      expect(mockWriteToolCall).toHaveBeenCalledTimes(2);

      // Now onAfterToolCall for session-a should use uuid-session-a
      await plugin.onAfterToolCall(
        "tool",
        { x: 1 },
        makeResult({ content: "result-a" }),
        ctxA
      );

      expect(mockWriteToolResult).toHaveBeenCalledWith({
        parentUuid: "uuid-session-a",
        toolCallId: "tool",
        content: "result-a",
      });
    });

    it("allows different tool names within the same session to be tracked independently", async () => {
      mockWriteToolCall
        .mockReturnValueOnce("uuid-read")
        .mockReturnValueOnce("uuid-write");

      const ctx = makeCtx({ sessionId: "sess" });

      await plugin.onBeforeToolCall("read_file", { path: "a" }, ctx);
      await plugin.onBeforeToolCall("write_file", { path: "b", content: "c" }, ctx);

      // Both afterToolCalls should get the correct parentUuid
      await plugin.onAfterToolCall(
        "read_file",
        { path: "a" },
        makeResult({ content: "read-ok" }),
        ctx
      );
      await plugin.onAfterToolCall(
        "write_file",
        { path: "b", content: "c" },
        makeResult({ content: "write-ok" }),
        ctx
      );

      expect(mockWriteToolResult).toHaveBeenCalledTimes(2);
      expect(mockWriteToolResult).toHaveBeenNthCalledWith(1, {
        parentUuid: "uuid-read",
        toolCallId: "read_file",
        content: "read-ok",
      });
      expect(mockWriteToolResult).toHaveBeenNthCalledWith(2, {
        parentUuid: "uuid-write",
        toolCallId: "write_file",
        content: "write-ok",
      });
    });
  });

  // ── onAfterToolCall ──────────────────────────────────────────────────────

  describe("onAfterToolCall", () => {
    it("writes the tool result to SessionStore", async () => {
      // Setup: register a pending call first
      mockWriteToolCall.mockReturnValue("parent-uuid-1");
      const ctx = makeCtx();
      await plugin.onBeforeToolCall("read_file", { path: "/a" }, ctx);

      // Now write the result
      await plugin.onAfterToolCall(
        "read_file",
        { path: "/a" },
        makeResult({ content: "file contents" }),
        ctx
      );

      expect(mockWriteToolResult).toHaveBeenCalledWith({
        parentUuid: "parent-uuid-1",
        toolCallId: "read_file",
        content: "file contents",
      });
    });

    it("cleans up the pending uuid after writing the result", async () => {
      mockWriteToolCall.mockReturnValue("uuid-to-clean");
      const ctx = makeCtx({ sessionId: "cleanup-session" });

      await plugin.onBeforeToolCall("edit_file", { path: "/x" }, ctx);

      // First onAfterToolCall should use the uuid
      await plugin.onAfterToolCall(
        "edit_file",
        { path: "/x" },
        makeResult({ content: "first" }),
        ctx
      );

      expect(mockWriteToolResult).toHaveBeenCalledWith({
        parentUuid: "uuid-to-clean",
        toolCallId: "edit_file",
        content: "first",
      });

      // Second onAfterToolCall for the same tool+session should fall back
      // (because pending uuid was deleted)
      mockWriteToolResult.mockClear();
      await plugin.onAfterToolCall(
        "edit_file",
        { path: "/x" },
        makeResult({ content: "second" }),
        ctx
      );

      expect(mockWriteToolResult).toHaveBeenCalledWith({
        parentUuid: "cleanup-session", // fallback to sessionId
        toolCallId: "edit_file",
        content: "second",
      });
    });

    it("falls back to ctx.sessionId when no pending uuid is found", async () => {
      // No onBeforeToolCall — call onAfterToolCall directly
      const ctx = makeCtx({ sessionId: "fallback-session" });

      await plugin.onAfterToolCall(
        "unknown_tool",
        {},
        makeResult({ content: "fallback result" }),
        ctx
      );

      expect(mockWriteToolResult).toHaveBeenCalledWith({
        parentUuid: "fallback-session",
        toolCallId: "unknown_tool",
        content: "fallback result",
      });
    });

    it("uses the fallback when a different tool name is queried than what was registered", async () => {
      mockWriteToolCall.mockReturnValue("uuid-grep");
      const ctx = makeCtx({ sessionId: "fallback-wrong-tool" });

      // Register "grep" as pending
      await plugin.onBeforeToolCall("grep", { pattern: "x" }, ctx);

      // Query onAfterToolCall for a different tool name "read_file"
      await plugin.onAfterToolCall(
        "read_file",
        { path: "/y" },
        makeResult({ content: "wrong match" }),
        ctx
      );

      expect(mockWriteToolResult).toHaveBeenCalledWith({
        parentUuid: "fallback-wrong-tool", // fallback
        toolCallId: "read_file",
        content: "wrong match",
      });
    });

    it("returns void (Promise<void>)", async () => {
      mockWriteToolCall.mockReturnValue("uuid-x");
      const ctx = makeCtx();
      await plugin.onBeforeToolCall("tool", {}, ctx);

      const result = await plugin.onAfterToolCall(
        "tool",
        {},
        makeResult({ content: "ok" }),
        ctx
      );

      expect(result).toBeUndefined();
    });

    it("correctly matches using the composite key toolName:sessionId", async () => {
      // Same tool name, different session → different pending uuids
      mockWriteToolCall
        .mockReturnValueOnce("uuid-s1")
        .mockReturnValueOnce("uuid-s2");

      const ctx1 = makeCtx({ sessionId: "s1" });
      const ctx2 = makeCtx({ sessionId: "s2" });

      await plugin.onBeforeToolCall("same_tool", { n: 1 }, ctx1);
      await plugin.onBeforeToolCall("same_tool", { n: 2 }, ctx2);

      // After for ctx1
      await plugin.onAfterToolCall(
        "same_tool",
        { n: 1 },
        makeResult({ content: "r1" }),
        ctx1
      );
      expect(mockWriteToolResult).toHaveBeenLastCalledWith({
        parentUuid: "uuid-s1",
        toolCallId: "same_tool",
        content: "r1",
      });

      // After for ctx2
      await plugin.onAfterToolCall(
        "same_tool",
        { n: 2 },
        makeResult({ content: "r2" }),
        ctx2
      );
      expect(mockWriteToolResult).toHaveBeenLastCalledWith({
        parentUuid: "uuid-s2",
        toolCallId: "same_tool",
        content: "r2",
      });
    });

    it("handles interleaved calls correctly", async () => {
      // Simulate: call A starts, call B starts, call A ends, call B ends
      mockWriteToolCall
        .mockReturnValueOnce("uuid-read")
        .mockReturnValueOnce("uuid-write");

      const ctx = makeCtx({ sessionId: "interleaved" });

      // Start read_file
      await plugin.onBeforeToolCall("read_file", { path: "a" }, ctx);
      // Start write_file
      await plugin.onBeforeToolCall("write_file", { path: "b", content: "c" }, ctx);

      // End read_file first
      await plugin.onAfterToolCall(
        "read_file",
        { path: "a" },
        makeResult({ content: "read-result" }),
        ctx
      );
      expect(mockWriteToolResult).toHaveBeenLastCalledWith({
        parentUuid: "uuid-read",
        toolCallId: "read_file",
        content: "read-result",
      });

      // End write_file second
      await plugin.onAfterToolCall(
        "write_file",
        { path: "b", content: "c" },
        makeResult({ content: "write-result" }),
        ctx
      );
      expect(mockWriteToolResult).toHaveBeenLastCalledWith({
        parentUuid: "uuid-write",
        toolCallId: "write_file",
        content: "write-result",
      });

      expect(mockWriteToolResult).toHaveBeenCalledTimes(2);
    });

    it("passes the correct arguments to writeToolResult including error results", async () => {
      mockWriteToolCall.mockReturnValue("uuid-err");
      const ctx = makeCtx();

      await plugin.onBeforeToolCall("failing_tool", { input: "bad" }, ctx);

      const errorResult: ToolResult = {
        ok: false,
        content: "Permission denied",
        error: {
          code: "PERMISSION_DENIED",
          message: "Cannot access path",
          retryable: false,
        },
      };

      await plugin.onAfterToolCall(
        "failing_tool",
        { input: "bad" },
        errorResult,
        ctx
      );

      expect(mockWriteToolResult).toHaveBeenCalledWith({
        parentUuid: "uuid-err",
        toolCallId: "failing_tool",
        content: "Permission denied",
      });
    });

    it("passes metadata in content correctly", async () => {
      mockWriteToolCall.mockReturnValue("uuid-meta");
      const ctx = makeCtx();

      await plugin.onBeforeToolCall("read_file", { path: "/big.txt" }, ctx);

      const resultWithMeta: ToolResult = {
        ok: true,
        content: "file content here",
        metadata: {
          bytesRead: 2048,
          linesRead: 100,
          renderHint: { type: "text" },
        },
      };

      await plugin.onAfterToolCall(
        "read_file",
        { path: "/big.txt" },
        resultWithMeta,
        ctx
      );

      expect(mockWriteToolResult).toHaveBeenCalledWith({
        parentUuid: "uuid-meta",
        toolCallId: "read_file",
        content: "file content here",
      });
    });
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles empty args", async () => {
      const ctx = makeCtx();
      const result = await plugin.onBeforeToolCall("noop", {}, ctx);

      expect(result).toBeNull();
      expect(mockWriteToolCall).toHaveBeenCalledWith({
        parentUuid: ctx.sessionId,
        toolName: "noop",
        toolCallId: expect.stringMatching(/^noop-\d+$/) as unknown as string,
        arguments: {},
      });
    });

    it("handles complex nested args", async () => {
      const ctx = makeCtx();
      const complexArgs = {
        path: "/deep/nested/file.ts",
        options: {
          recursive: true,
          ignore: ["*.log", "node_modules"],
          maxDepth: 5,
          filters: [{ type: "regex", pattern: "^test" }],
        },
      };

      await plugin.onBeforeToolCall("glob", complexArgs, ctx);

      expect(mockWriteToolCall).toHaveBeenCalledWith({
        parentUuid: ctx.sessionId,
        toolName: "glob",
        toolCallId: expect.stringMatching(/^glob-\d+$/) as unknown as string,
        arguments: complexArgs,
      });
    });

    it("generates unique toolCallIds for rapid successive calls", async () => {
      // Even with Date.now() having ms precision, rapid calls in the same
      // millisecond should produce distinct IDs because different tool names
      // produce different keys.

      const ctx = makeCtx();

      await plugin.onBeforeToolCall("tool_a", {}, ctx);
      await plugin.onBeforeToolCall("tool_b", {}, ctx);

      const calls = mockWriteToolCall.mock.calls;
      const idA = (calls[0]![0] as { toolCallId: string }).toolCallId;
      const idB = (calls[1]![0] as { toolCallId: string }).toolCallId;

      // Different tool names → different IDs
      expect(idA).not.toBe(idB);
    });

    it("onAfterToolCall with empty content", async () => {
      mockWriteToolCall.mockReturnValue("uuid-empty");
      const ctx = makeCtx();

      await plugin.onBeforeToolCall("empty_tool", {}, ctx);
      await plugin.onAfterToolCall(
        "empty_tool",
        {},
        makeResult({ content: "" }),
        ctx
      );

      expect(mockWriteToolResult).toHaveBeenCalledWith({
        parentUuid: "uuid-empty",
        toolCallId: "empty_tool",
        content: "",
      });
    });
  });
});

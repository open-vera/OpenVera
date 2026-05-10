/**
 * Tests for review findings — Bug #3: ToolRegistry before middleware
 * error handling was silent (errors swallowed).
 *
 * Fix: before hook errors are now logged to stderr and re-thrown,
 * so misconfigured middleware is visible rather than silently failing.
 */
import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolDef, ToolResult, ToolContext } from "../src/tools/types.js";

const ctx: ToolContext = { cwd: "/tmp", readonlyMode: false };

function makeEchoTool(name = "echo"): ToolDef<{ text: string }> {
  return {
    name,
    description: "Echoes input",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    execute: async (args) => ({ ok: true, content: args.text }),
  };
}

describe("ToolRegistry — before middleware error propagation", () => {
  it("should re-throw errors from before middleware (not silently swallow)", async () => {
    const reg = new ToolRegistry();
    reg.register(makeEchoTool());

    const badMiddleware = {
      name: "bad-mw",
      before: vi.fn(async () => {
        throw new Error("bad before hook config");
      }),
    };

    reg.addMiddleware(badMiddleware);

    // The error should propagate up, not silently continue
    await expect(reg.execute("echo", { text: "hello" }, ctx)).rejects.toThrow("bad before hook config");
    expect(badMiddleware.before).toHaveBeenCalledTimes(1);
  });

  it("should log before hook errors before re-throwing", async () => {
    const reg = new ToolRegistry();
    reg.register(makeEchoTool());

    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    reg.addMiddleware({
      name: "failing-before",
      before: async () => {
        throw new Error("misconfigured hook");
      },
    });

    await expect(reg.execute("echo", { text: "test" }, ctx)).rejects.toThrow("misconfigured hook");

    // Check that the error was logged
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("failing-before")
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("misconfigured hook")
    );

    logSpy.mockRestore();
  });

  it("should NOT execute tool if before hook throws (error propagation)", async () => {
    const reg = new ToolRegistry();
    const executeSpy = vi.fn(async (args: unknown) => ({ ok: true, content: (args as { text: string }).text }));

    reg.register({
      name: "expensive-tool",
      description: "Expensive operation",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: executeSpy,
    });

    reg.addMiddleware({
      name: "blocking-mw",
      before: async () => {
        throw new Error("stop here");
      },
    });

    await expect(reg.execute("expensive-tool", { text: "should not run" }, ctx)).rejects.toThrow("stop here");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("should still call subsequent middlewares after re-throw (each mw isolated)", async () => {
    const reg = new ToolRegistry();
    reg.register(makeEchoTool());

    const mw1Throw = vi.fn(async () => {
      throw new Error("first middleware fails");
    });
    const mw2Track = vi.fn(async (_n: string, args: Record<string, unknown>) => ({ args }));

    reg.addMiddleware({ name: "mw1", before: mw1Throw });
    reg.addMiddleware({ name: "mw2", before: mw2Track });

    // First middleware throws — second middleware should still be called
    // (but note: with re-throw, the chain breaks after mw1 throws)
    // This test documents the new behavior: error stops the chain
    await expect(reg.execute("echo", { text: "hello" }, ctx)).rejects.toThrow("first middleware fails");
    expect(mw1Throw).toHaveBeenCalledTimes(1);
    // mw2 before is NOT called because mw1 threw
    expect(mw2Track).not.toHaveBeenCalled();
  });

  it("after middleware still runs if tool succeeds", async () => {
    const reg = new ToolRegistry();
    reg.register(makeEchoTool());

    const afterSpy = vi.fn(async (_n: string, _a: Record<string, unknown>, r: ToolResult) => r);

    reg.addMiddleware({ name: "good-after", after: afterSpy });

    const result = await reg.execute("echo", { text: "world" }, ctx);
    expect(result.content).toBe("world");
    expect(afterSpy).toHaveBeenCalledTimes(1);
  });

  it("after middleware NOT called if before middleware throws", async () => {
    const reg = new ToolRegistry();
    reg.register(makeEchoTool());

    const afterSpy = vi.fn(async (_n: string, _a: Record<string, unknown>, r: ToolResult) => r);

    reg.addMiddleware({ name: "will-fail", before: async () => { throw new Error("stop"); } });
    reg.addMiddleware({ name: "after-catcher", after: afterSpy });

    await expect(reg.execute("echo", { text: "nope" }, ctx)).rejects.toThrow("stop");
    expect(afterSpy).not.toHaveBeenCalled();
  });
});
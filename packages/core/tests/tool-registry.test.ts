import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolDef, ToolResult, ToolContext, ToolLifecycleHook } from "../src/tools/types.js";

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

describe("ToolRegistry", () => {
  it("registers and retrieves tool schemas", () => {
    const reg = new ToolRegistry();
    reg.register(makeEchoTool());
    const schemas = reg.getSchemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0]?.name).toBe("echo");
  });

  it("executes a registered tool", async () => {
    const reg = new ToolRegistry();
    reg.register(makeEchoTool());
    const result = await reg.execute("echo", { text: "hello" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("hello");
  });

  it("returns error for unknown tool", async () => {
    const reg = new ToolRegistry();
    const result = await reg.execute("unknown", {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
  });

  it("calls onBeforeToolCall hook and short-circuits on non-null return", async () => {
    const reg = new ToolRegistry();
    reg.register(makeEchoTool());
    const blocked: ToolResult = { ok: false, content: "", error: { code: "BLOCKED", message: "blocked" } };
    const hook: ToolLifecycleHook = {
      onBeforeToolCall: vi.fn().mockResolvedValue(blocked),
    };
    reg.use(hook);
    const result = await reg.execute("echo", { text: "hi" }, ctx);
    expect(result).toEqual(blocked);
    expect(hook.onBeforeToolCall).toHaveBeenCalledWith("echo", { text: "hi" }, ctx);
  });

  it("calls onAfterToolCall hook with result", async () => {
    const reg = new ToolRegistry();
    reg.register(makeEchoTool());
    const afterFn = vi.fn();
    const hook: ToolLifecycleHook = { onAfterToolCall: afterFn };
    reg.use(hook);
    await reg.execute("echo", { text: "x" }, ctx);
    expect(afterFn).toHaveBeenCalledWith("echo", { text: "x" }, expect.objectContaining({ ok: true }), ctx);
  });

  it("onBeforeToolCall returning null does not block", async () => {
    const reg = new ToolRegistry();
    reg.register(makeEchoTool());
    const hook: ToolLifecycleHook = {
      onBeforeToolCall: vi.fn().mockResolvedValue(null),
    };
    reg.use(hook);
    const result = await reg.execute("echo", { text: "pass" }, ctx);
    expect(result.ok).toBe(true);
  });

  it("handles tool execution error gracefully", async () => {
    const failing: ToolDef<Record<string, never>> = {
      name: "fail",
      description: "Always throws",
      parameters: { type: "object", properties: {} },
      execute: async () => { throw new Error("boom"); },
    };
    const reg = new ToolRegistry();
    reg.register(failing);
    const result = await reg.execute("fail", {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("boom");
  });

  it("registers multiple tools independently", () => {
    const reg = new ToolRegistry();
    reg.register(makeEchoTool("a"));
    reg.register(makeEchoTool("b"));
    expect(reg.getSchemas()).toHaveLength(2);
  });
});

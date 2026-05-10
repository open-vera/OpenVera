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

describe("ToolRegistry middleware isolation", () => {
  it("runs all before/after hooks even if one before throws (isolated by default)", async () => {
    const reg = new ToolRegistry();
    reg.register(makeEchoTool());

    const mw1Before = vi.fn(() => {
      throw new Error("mw1 boom");
    });
    const mw2Before = vi.fn(async (_n: string, args: Record<string, unknown>) => ({
      args: { ...args, extra: true },
    }));

    const mw1After = vi.fn(async (_n: string, _a: Record<string, unknown>, r: ToolResult) => r);
    const mw2After = vi.fn(async (_n: string, _a: Record<string, unknown>, r: ToolResult) => r);

    reg.addMiddleware({ name: "mw1", before: mw1Before, after: mw1After });
    reg.addMiddleware({ name: "mw2", before: mw2Before, after: mw2After });

    const result = await reg.execute("echo", { text: "hi" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("hi");

    expect(mw1Before).toHaveBeenCalledTimes(1);
    expect(mw2Before).toHaveBeenCalledTimes(1);

    expect(mw1After).toHaveBeenCalledTimes(1);
    expect(mw2After).toHaveBeenCalledTimes(1);
  });

  it("onError recovery stops further onError calls (first recovery wins)", async () => {
    const reg = new ToolRegistry();

    const failTool: ToolDef<Record<string, never>> = {
      name: "fail",
      description: "Always throws",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        throw new Error("tool exploded");
      },
    };
    reg.register(failTool);

    const recovered: ToolResult = { ok: true, content: "recovered" };

    const mw1 = {
      name: "mw1",
      onError: vi.fn(async () => recovered),
    };
    const mw2 = {
      name: "mw2",
      onError: vi.fn(async () => ({ ok: true, content: "nope" })),
    };

    reg.addMiddleware(mw1);
    reg.addMiddleware(mw2);

    const result = await reg.execute("fail", {}, ctx);
    expect(result).toEqual(recovered);
    expect(mw1.onError).toHaveBeenCalledTimes(1);
    expect(mw2.onError).not.toHaveBeenCalled();
  });

  it("keeps middleware order for before/after across tools", async () => {
    const reg = new ToolRegistry();
    reg.register(makeEchoTool());

    const order: string[] = [];

    reg.addMiddleware({
      name: "a",
      before: async (_n, args) => {
        order.push("a-before");
        return { args };
      },
      after: async (_n, _a, r) => {
        order.push("a-after");
        return r;
      },
    });
    reg.addMiddleware({
      name: "b",
      before: async (_n, args) => {
        order.push("b-before");
        return { args };
      },
      after: async (_n, _a, r) => {
        order.push("b-after");
        return r;
      },
    });

    const result = await reg.execute("echo", { text: "x" }, ctx);
    expect(result.ok).toBe(true);
    expect(order).toEqual(["a-before", "b-before", "a-after", "b-after"]);
  });

  it("middleware before skip=true short-circuits execution and still runs after hooks", async () => {
    const reg = new ToolRegistry();
    const execute = vi.fn(async () => ({ ok: true, content: "original" }));
    reg.register({
      name: "skip",
      description: "skip",
      parameters: { type: "object", properties: {} },
      execute,
    });

    const afterFn = vi.fn(async (_n: string, _a: Record<string, unknown>, r: ToolResult) => r);
    reg.addMiddleware({
      name: "skipper",
      before: async () => ({
        skip: true,
        result: { ok: true, content: "skipped" },
        args: {},
      }),
      after: afterFn,
    });

    const result = await reg.execute("skip", {}, ctx);
    expect(result).toEqual({ ok: true, content: "skipped" });
    expect(execute).not.toHaveBeenCalled();
    expect(afterFn).toHaveBeenCalledTimes(1);
  });
});

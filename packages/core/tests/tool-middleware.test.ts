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
  it("before errors propagate and stop the chain (not silently swallowed)", async () => {
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

    // mw1 throws — error propagates, mw2 is NOT called
    await expect(reg.execute("echo", { text: "hi" }, ctx)).rejects.toThrow("mw1 boom");
    expect(mw1Before).toHaveBeenCalledTimes(1);
    expect(mw2Before).not.toHaveBeenCalled();
    // after hooks also not called
    expect(mw1After).not.toHaveBeenCalled();
    expect(mw2After).not.toHaveBeenCalled();
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

describe("D4: Tool Middleware full pipeline", () => {
  it("multiple middlewares chain arg transformations", async () => {
    const reg = new ToolRegistry();
    const execute = vi.fn(async (args: Record<string, unknown>) => ({
      ok: true,
      content: JSON.stringify(args),
    }));
    reg.register({
      name: "transform",
      description: "transform tool",
      parameters: { type: "object", properties: {} },
      execute,
    });

    reg.addMiddleware({
      name: "add-foo",
      before: async (_n, args) => ({ args: { ...args, foo: "bar" } }),
    });
    reg.addMiddleware({
      name: "add-baz",
      before: async (_n, args) => ({ args: { ...args, baz: 42 } }),
    });

    const result = await reg.execute("transform", { x: 1 }, ctx);
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.content!);
    expect(parsed).toMatchObject({ x: 1, foo: "bar", baz: 42 });
  });

  it("after hook can modify result", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "echo",
      description: "echo",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: async (args) => ({ ok: true, content: (args as { text: string }).text }),
    });

    reg.addMiddleware({
      name: "uppercaser",
      after: async (_n, _a, r) => ({
        ...r,
        content: r.content?.toUpperCase(),
      }),
    });

    const result = await reg.execute("echo", { text: "hello" }, ctx);
    expect(result.content).toBe("HELLO");
  });

  it("error from tool propagates to onError and after hooks", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "explode",
      description: "boom",
      parameters: { type: "object", properties: {} },
      execute: async () => { throw new Error("kaboom"); },
    });

    const callOrder: string[] = [];
    reg.addMiddleware({
      name: "logger",
      onError: async () => {
        callOrder.push("onError");
        return { ok: true, content: "recovered" };
      },
      after: async () => {
        callOrder.push("after");
        return { ok: true, content: "after" };
      },
    });

    const result = await reg.execute("explode", {}, ctx);
    expect(result.ok).toBe(true);
    // onError is called (after is NOT called when error + recovery happens)
    expect(callOrder).toContain("onError");
  });

  it("unhandled error falls through to error result when no onError", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "fail",
      description: "fail",
      parameters: { type: "object", properties: {} },
      execute: async () => { throw new Error("no recovery"); },
    });

    reg.addMiddleware({
      name: "pass-through",
      after: async (_n, _a, r) => r,
    });

    const result = await reg.execute("fail", {}, ctx);
    expect(result.ok).toBe(false);
  });

  it("non-existent tool returns error result", async () => {
    const reg = new ToolRegistry();
    reg.addMiddleware({
      name: "noop",
      after: async (_n, _a, r) => r,
    });

    const result = await reg.execute("nonexistent", {}, ctx);
    expect(result.ok).toBe(false);
  });

  it("no middlewares tool execution works correctly", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "bare",
      description: "bare tool",
      parameters: { type: "object", properties: { val: { type: "number" } }, required: ["val"] },
      execute: async (args) => ({ ok: true, content: String((args as { val: number }).val * 2) }),
    });

    const result = await reg.execute("bare", { val: 21 }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("42");
  });

  it("full pipeline: before→execute→after called in order with correct data", async () => {
    const reg = new ToolRegistry();
    const order: string[] = [];
    const capturedArgs: unknown[] = [];
    const capturedResults: unknown[] = [];

    reg.register({
      name: "pipeline",
      description: "pipeline tool",
      parameters: { type: "object", properties: {} },
      execute: async (args) => {
        order.push("execute");
        capturedArgs.push({ ...args });
        return { ok: true, content: "executed" };
      },
    });

    reg.addMiddleware({
      name: "tracer",
      before: async (_n, args) => {
        order.push("before");
        return { args: { ...args, injected: true } };
      },
      after: async (_n, _args, result) => {
        order.push("after");
        capturedResults.push({ ...result });
        return { ...result, content: result.content + "+after" };
      },
    });

    const result = await reg.execute("pipeline", { orig: 1 }, ctx);
    expect(order).toEqual(["before", "execute", "after"]);
    expect(capturedArgs[0]).toMatchObject({ orig: 1, injected: true });
    expect(result.content).toBe("executed+after");
  });

  it("ctx is propagated to all middleware phases", async () => {
    const reg = new ToolRegistry();
    const receivedCtxs: string[] = [];
    const testCtx: typeof ctx = { cwd: "/custom", readonlyMode: true };

    reg.register({
      name: "ctx-check",
      description: "ctx check",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        receivedCtxs.push("execute");
        return { ok: true, content: "ok" };
      },
    });

    reg.addMiddleware({
      name: "ctx-mw",
      before: async (_n, _args, c) => {
        receivedCtxs.push(`before:${c.cwd}:${c.readonlyMode}`);
        return null;
      },
      after: async (_n, _a, _r, c) => {
        receivedCtxs.push(`after:${c.cwd}:${c.readonlyMode}`);
        return { ok: true, content: "ok" };
      },
      onError: async (_n, _a, _err, c) => {
        receivedCtxs.push(`onError:${c.cwd}:${c.readonlyMode}`);
        return null;
      },
    });

    await reg.execute("ctx-check", {}, testCtx);
    expect(receivedCtxs).toContain("before:/custom:true");
    expect(receivedCtxs).toContain("after:/custom:true");
  });

  it("onError returning null falls through to error result", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "unrecoverable",
      description: "unrecoverable",
      parameters: { type: "object", properties: {} },
      execute: async () => { throw new Error("fatal"); },
    });

    reg.addMiddleware({
      name: "decline-recovery",
      onError: async () => null, // cannot recover
    });

    const result = await reg.execute("unrecoverable", {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe("fatal");
  });

  it("multiple after hooks transform result in registration order", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "chain",
      description: "chain tool",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true, content: "base" }),
    });

    reg.addMiddleware({
      name: "append-a",
      after: async (_n, _a, r) => ({ ...r, content: r.content + "+A" }),
    });
    reg.addMiddleware({
      name: "append-b",
      after: async (_n, _a, r) => ({ ...r, content: r.content + "+B" }),
    });

    const result = await reg.execute("chain", {}, ctx);
    expect(result.content).toBe("base+A+B");
  });
});

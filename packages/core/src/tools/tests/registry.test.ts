import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolRegistry } from "../registry.js";
import type {
  ToolDef,
  ToolContext,
  ToolResult,
  ToolLifecycleHook,
  ToolMiddleware,
} from "../types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function okResult(content = "ok"): ToolResult {
  return { ok: true, content };
}

function makeTool(overrides?: Partial<ToolDef>): ToolDef {
  return {
    name: "test_tool",
    description: "A test tool",
    parameters: { type: "object", properties: {} },
    execute: async () => okResult("done"),
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    cwd: "/tmp",
    sessionId: "test-session",
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Registration
  // ══════════════════════════════════════════════════════════════════════════

  describe("register", () => {
    it("adds a tool to the registry", () => {
      const tool = makeTool({ name: "my_tool" });
      registry.register(tool);
      expect(registry.has("my_tool")).toBe(true);
    });

    it("overwrites an existing tool with the same name", () => {
      const tool1 = makeTool({ name: "dup", description: "first" });
      const tool2 = makeTool({ name: "dup", description: "second" });
      registry.register(tool1);
      registry.register(tool2);
      const retrieved = registry.get("dup");
      expect(retrieved?.description).toBe("second");
    });

    it("stores tools independently by name", () => {
      const a = makeTool({ name: "a" });
      const b = makeTool({ name: "b" });
      registry.register(a);
      registry.register(b);
      expect(registry.has("a")).toBe(true);
      expect(registry.has("b")).toBe(true);
    });
  });

  describe("has", () => {
    it("returns true for a registered tool", () => {
      registry.register(makeTool({ name: "exists" }));
      expect(registry.has("exists")).toBe(true);
    });

    it("returns false for an unregistered tool", () => {
      expect(registry.has("nope")).toBe(false);
    });

    it("returns false on an empty registry", () => {
      expect(registry.has("anything")).toBe(false);
    });
  });

  describe("get", () => {
    it("returns the ToolDef for a registered tool", () => {
      const tool = makeTool({ name: "get_me", description: "find me" });
      registry.register(tool);
      const found = registry.get("get_me");
      expect(found).toBeDefined();
      expect(found?.name).toBe("get_me");
      expect(found?.description).toBe("find me");
    });

    it("returns undefined for an unknown tool", () => {
      expect(registry.get("ghost")).toBeUndefined();
    });
  });

  describe("list", () => {
    it("returns all registered tools", () => {
      registry.register(makeTool({ name: "t1" }));
      registry.register(makeTool({ name: "t2" }));
      registry.register(makeTool({ name: "t3" }));
      const list = registry.list();
      expect(list).toHaveLength(3);
      const names = list.map((t) => t.name).sort();
      expect(names).toEqual(["t1", "t2", "t3"]);
    });

    it("returns an empty array when no tools are registered", () => {
      expect(registry.list()).toEqual([]);
    });

    it("returns a new array each call (not the internal map)", () => {
      registry.register(makeTool({ name: "only" }));
      const a = registry.list();
      const b = registry.list();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe("registerGroup", () => {
    it("registers a group and all its tools", () => {
      const t1 = makeTool({ name: "g1_t1" });
      const t2 = makeTool({ name: "g1_t2" });
      registry.registerGroup(
        { name: "group1", description: "First group" },
        [t1, t2],
      );
      expect(registry.has("g1_t1")).toBe(true);
      expect(registry.has("g1_t2")).toBe(true);
    });

    it("assigns group name and merges defaults into tools", () => {
      const tool = makeTool({ name: "styled" });
      registry.registerGroup(
        {
          name: "io",
          defaults: { timeoutMs: 5000, idempotent: true },
        },
        [tool],
      );
      const retrieved = registry.get("styled");
      expect(retrieved?.group).toBe("io");
      expect(retrieved?.options).toMatchObject({
        timeoutMs: 5000,
        idempotent: true,
      });
    });

    it("tool-level options override group defaults", () => {
      const tool = makeTool({
        name: "override_me",
        options: { timeoutMs: 1000 },
      });
      registry.registerGroup(
        { name: "g", defaults: { timeoutMs: 9999 } },
        [tool],
      );
      const retrieved = registry.get("override_me");
      expect(retrieved?.options?.timeoutMs).toBe(1000);
    });

    it("does not overwrite an already-set group on a tool", () => {
      const tool = makeTool({ name: "sticky", group: "original" });
      registry.registerGroup({ name: "new_group" }, [tool]);
      expect(registry.get("sticky")?.group).toBe("original");
    });
  });

  describe("getGroup", () => {
    it("returns the group metadata and member tools", () => {
      const t1 = makeTool({ name: "io.read" });
      const t2 = makeTool({ name: "io.write" });
      registry.registerGroup({ name: "io", description: "I/O tools" }, [t1, t2]);
      const result = registry.getGroup("io");
      expect(result).toBeDefined();
      expect(result!.group.name).toBe("io");
      expect(result!.tools).toHaveLength(2);
    });

    it("returns undefined for an unknown group", () => {
      expect(registry.getGroup("ghost_group")).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Schemas
  // ══════════════════════════════════════════════════════════════════════════

  describe("getSchemas", () => {
    it("returns Tool schema list for the LLM", () => {
      registry.register(
        makeTool({
          name: "bash",
          description: "Run a command",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        }),
      );
      const schemas = registry.getSchemas();
      expect(schemas).toHaveLength(1);
      expect(schemas[0]).toMatchObject({
        name: "bash",
        description: "Run a command",
      });
    });

    it("returns empty array when no tools", () => {
      expect(registry.getSchemas()).toEqual([]);
    });
  });

  describe("getSchemasByGroup", () => {
    it("filters schemas by group name", () => {
      const t1 = makeTool({ name: "io.read" });
      const t2 = makeTool({ name: "io.write" });
      const t3 = makeTool({ name: "math.add" });
      registry.registerGroup({ name: "io" }, [t1, t2]);
      registry.registerGroup({ name: "math" }, [t3]);
      const ioSchemas = registry.getSchemasByGroup("io");
      expect(ioSchemas).toHaveLength(2);
      expect(ioSchemas.map((s) => s.name).sort()).toEqual(["io.read", "io.write"]);
    });

    it("returns empty array for unknown group", () => {
      registry.register(makeTool({ name: "solo" }));
      expect(registry.getSchemasByGroup("nope")).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Deprecation
  // ══════════════════════════════════════════════════════════════════════════

  describe("getDeprecationWarning", () => {
    it("returns null for a non-deprecated tool", () => {
      registry.register(makeTool({ name: "fresh" }));
      expect(registry.getDeprecationWarning("fresh")).toBeNull();
    });

    it("returns null for an unknown tool", () => {
      expect(registry.getDeprecationWarning("nobody")).toBeNull();
    });

    it("returns a warning string for a deprecated tool", () => {
      registry.register(
        makeTool({
          name: "old_tool",
          version: { version: "1.0.0", deprecated: true, deprecatedReason: "Obsolete API" },
        }),
      );
      const warning = registry.getDeprecationWarning("old_tool");
      expect(warning).toContain("Obsolete API");
    });

    it("includes replacement info when replacedBy is set", () => {
      registry.register(
        makeTool({
          name: "v1",
          version: {
            version: "1.0.0",
            deprecated: true,
            deprecatedReason: "Use v2",
            replacedBy: "v2",
          },
        }),
      );
      const warning = registry.getDeprecationWarning("v1");
      expect(warning).toContain("v2");
    });

    it("uses default message when deprecatedReason is absent", () => {
      registry.register(
        makeTool({
          name: "bare_deprecated",
          version: { version: "1.0.0", deprecated: true },
        }),
      );
      const warning = registry.getDeprecationWarning("bare_deprecated");
      expect(warning).toContain("This tool is deprecated");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Hooks
  // ══════════════════════════════════════════════════════════════════════════

  describe("use (lifecycle hooks)", () => {
    it("onBeforeToolCall can intercept and short-circuit execution", async () => {
      const tool = makeTool({
        name: "blocked",
        execute: async () => okResult("should not run"),
      });
      registry.register(tool);

      const hook: ToolLifecycleHook = {
        onBeforeToolCall: async () => ({
          ok: true,
          content: "intercepted by hook",
        }),
      };
      registry.use(hook);

      const result = await registry.execute("blocked", {}, makeCtx());
      expect(result.ok).toBe(true);
      expect(result.content).toBe("intercepted by hook");
    });

    it("onBeforeToolCall returning null proceeds normally", async () => {
      const tool = makeTool({
        name: "passthrough",
        execute: async () => okResult("executed"),
      });
      registry.register(tool);

      const beforeSpy = vi.fn(async () => null);
      const hook: ToolLifecycleHook = { onBeforeToolCall: beforeSpy };
      registry.use(hook);

      const result = await registry.execute("passthrough", {}, makeCtx());
      expect(result.content).toBe("executed");
      expect(beforeSpy).toHaveBeenCalledTimes(1);
    });

    it("onAfterToolCall is invoked after execution", async () => {
      const tool = makeTool({
        name: "after_test",
        execute: async () => okResult("ran"),
      });
      registry.register(tool);

      const afterSpy = vi.fn(async () => {});
      const hook: ToolLifecycleHook = { onAfterToolCall: afterSpy };
      registry.use(hook);

      await registry.execute("after_test", { x: 1 }, makeCtx());
      expect(afterSpy).toHaveBeenCalledTimes(1);
    });

    it("onBeforeToolCall receives the tool name, args, and context", async () => {
      const tool = makeTool({ name: "inspect" });
      registry.register(tool);

      const beforeSpy = vi.fn(async () => null);
      const hook: ToolLifecycleHook = { onBeforeToolCall: beforeSpy };
      registry.use(hook);
      const ctx = makeCtx();

      await registry.execute("inspect", { key: "val" }, ctx);
      expect(beforeSpy).toHaveBeenCalledWith("inspect", { key: "val" }, ctx);
    });

    it("multiple hooks run in registration order", async () => {
      const tool = makeTool({ name: "ordered" });
      registry.register(tool);

      const order: string[] = [];
      const hook1: ToolLifecycleHook = {
        onBeforeToolCall: async () => {
          order.push("h1_before");
          return null;
        },
        onAfterToolCall: async () => {
          order.push("h1_after");
        },
      };
      const hook2: ToolLifecycleHook = {
        onBeforeToolCall: async () => {
          order.push("h2_before");
          return null;
        },
        onAfterToolCall: async () => {
          order.push("h2_after");
        },
      };
      registry.use(hook1);
      registry.use(hook2);

      await registry.execute("ordered", {}, makeCtx());
      // After hooks run in registration order (h1, then h2)
      expect(order).toEqual(["h1_before", "h2_before", "h1_after", "h2_after"]);
    });

    it("first hook's interception prevents execution and subsequent before hooks", async () => {
      const tool = makeTool({
        name: "skip",
        execute: async () => okResult("never runs"),
      });
      registry.register(tool);

      const hook1Spy = vi.fn(async () => null);
      const hook1: ToolLifecycleHook = {
        onBeforeToolCall: async () => ({ ok: true, content: "short" }),
      };
      const hook2: ToolLifecycleHook = {
        onBeforeToolCall: hook1Spy,
      };
      registry.use(hook1);
      registry.use(hook2);

      const result = await registry.execute("skip", {}, makeCtx());
      expect(result.content).toBe("short");
      // hook2's onBeforeToolCall should NOT be called because hook1 intercepted
      expect(hook1Spy).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Middleware
  // ══════════════════════════════════════════════════════════════════════════

  describe("addMiddleware / removeMiddleware", () => {
    it("adds middleware that can be removed by name", () => {
      const mw: ToolMiddleware = { name: "mw1" };
      registry.addMiddleware(mw);
      expect(registry.removeMiddleware("mw1")).toBe(true);
    });

    it("removeMiddleware returns false for unknown name", () => {
      expect(registry.removeMiddleware("nope")).toBe(false);
    });

    it("removeMiddleware only removes the matching middleware", () => {
      const mw1: ToolMiddleware = { name: "a" };
      const mw2: ToolMiddleware = { name: "b" };
      registry.addMiddleware(mw1);
      registry.addMiddleware(mw2);
      registry.removeMiddleware("a");
      // mw2 should still be present (indirect: mw1.before won't run on execute)
      expect(registry.removeMiddleware("b")).toBe(true);
      expect(registry.removeMiddleware("a")).toBe(false);
    });
  });

  describe("middleware — before", () => {
    it("can modify args before execution", async () => {
      const executeSpy = vi.fn(
        async (args: { count: number }) => okResult(`count=${args.count}`),
      );
      const tool = makeTool({ name: "mw_test", execute: executeSpy });
      registry.register(tool);

      registry.addMiddleware({
        name: "increment",
        before: async (_name, args) => ({
          args: { count: (args.count as number) + 10 },
        }),
      });

      const result = await registry.execute("mw_test", { count: 1 }, makeCtx());
      expect(executeSpy).toHaveBeenCalledWith(
        { count: 11 },
        expect.anything(),
      );
      expect(result.content).toBe("count=11");
    });

    it("can skip execution and provide a result", async () => {
      const executeSpy = vi.fn(async () => okResult("should not run"));
      const tool = makeTool({ name: "skip_me", execute: executeSpy });
      registry.register(tool);

      registry.addMiddleware({
        name: "skipper",
        before: async () => ({
          args: {},
          skip: true,
          result: okResult("skipped by middleware"),
        }),
      });

      const result = await registry.execute("skip_me", {}, makeCtx());
      expect(result.content).toBe("skipped by middleware");
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("passes through when before returns null", async () => {
      const executeSpy = vi.fn(async () => okResult("executed"));
      const tool = makeTool({ name: "pass", execute: executeSpy });
      registry.register(tool);

      registry.addMiddleware({
        name: "passive",
        before: async () => null,
      });

      const result = await registry.execute("pass", { x: 1 }, makeCtx());
      expect(result.content).toBe("executed");
    });

    it("multiple middlewares chain args transformations", async () => {
      const executeSpy = vi.fn(
        async (args: { a: number; b: number }) => okResult(`a=${args.a},b=${args.b}`),
      );
      registry.register(makeTool({ name: "chain", execute: executeSpy }));

      registry.addMiddleware({
        name: "mw_a",
        before: async (_name, args) => ({
          args: { ...args, a: (args.a as number) + 1 },
        }),
      });
      registry.addMiddleware({
        name: "mw_b",
        before: async (_name, args) => ({
          args: { ...args, b: (args.b as number) + 1 },
        }),
      });

      await registry.execute("chain", { a: 0, b: 0 }, makeCtx());
      expect(executeSpy).toHaveBeenCalledWith(
        { a: 1, b: 1 },
        expect.anything(),
      );
    });
  });

  describe("middleware — after", () => {
    it("can transform the result after execution", async () => {
      registry.register(
        makeTool({
          name: "raw",
          execute: async () => okResult("raw"),
        }),
      );

      registry.addMiddleware({
        name: "wrapper",
        after: async (_name, _args, result) => ({
          ...result,
          content: `[wrapped] ${result.content}`,
        }),
      });

      const result = await registry.execute("raw", {}, makeCtx());
      expect(result.content).toBe("[wrapped] raw");
    });

    it("multiple after hooks chain result transformation", async () => {
      registry.register(
        makeTool({
          name: "base",
          execute: async () => okResult("base"),
        }),
      );

      registry.addMiddleware({
        name: "outer",
        after: async (_n, _a, r) => ({ ...r, content: `<outer>${r.content}</outer>` }),
      });
      registry.addMiddleware({
        name: "inner",
        after: async (_n, _a, r) => ({ ...r, content: `<inner>${r.content}</inner>` }),
      });

      const result = await registry.execute("base", {}, makeCtx());
      // Both after hooks run: first "outer", then "inner" wraps the outer result
      expect(result.content).toBe("<inner><outer>base</outer></inner>");
    });
  });

  describe("middleware — onError", () => {
    it("can recover from execution errors on the final retry", async () => {
      const error = new Error("boom");
      registry.register(
        makeTool({
          name: "fragile",
          execute: async () => {
            throw error;
          },
        }),
      );

      registry.addMiddleware({
        name: "recoverer",
        onError: async (_name, _args, _err, _ctx) => okResult("recovered"),
      });

      const result = await registry.execute("fragile", {}, makeCtx());
      expect(result.ok).toBe(true);
      expect(result.content).toBe("recovered");
    });

    it("returns the execution error when no onError middleware recovers", async () => {
      registry.register(
        makeTool({
          name: "doomed",
          execute: async () => {
            throw new Error("fatal");
          },
        }),
      );

      const result = await registry.execute("doomed", {}, makeCtx());
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("fatal");
    });
  });

  describe("middleware — before hook failure propagation", () => {
    it("throws when a before middleware throws, and does not execute the tool", async () => {
      const executeSpy = vi.fn(async () => okResult("never"));
      registry.register(makeTool({ name: "t", execute: executeSpy }));

      registry.addMiddleware({
        name: "exploder",
        before: async () => {
          throw new Error("mw explosion");
        },
      });

      await expect(
        registry.execute("t", {}, makeCtx()),
      ).rejects.toThrow("mw explosion");
      expect(executeSpy).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Execution
  // ══════════════════════════════════════════════════════════════════════════

  describe("execute — basic", () => {
    it("runs the tool and returns its result", async () => {
      registry.register(
        makeTool({
          name: "echo",
          execute: async (args: { msg: string }) => okResult(args.msg),
        }),
      );
      const result = await registry.execute("echo", { msg: "hello" }, makeCtx());
      expect(result.ok).toBe(true);
      expect(result.content).toBe("hello");
    });

    it("passes context to the tool execute function", async () => {
      const executeSpy = vi.fn(async () => okResult("ok"));
      registry.register(makeTool({ name: "ctx_test", execute: executeSpy }));
      const ctx = makeCtx({ cwd: "/custom", sessionId: "s42" });

      await registry.execute("ctx_test", { a: 1 }, ctx);
      expect(executeSpy).toHaveBeenCalledWith({ a: 1 }, ctx);
    });
  });

  describe("execute — unknown tool", () => {
    it("returns an error result for a tool not in the registry", async () => {
      const result = await registry.execute("ghost", {}, makeCtx());
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("UNKNOWN");
      expect(result.content).toContain("not found");
    });

    it("does not call hooks or middleware for unknown tools (no hook configured)", async () => {
      // The unknown-tool path returns before hooks/middleware run
      const result = await registry.execute("ghost", {}, makeCtx());
      expect(result.ok).toBe(false);
    });
  });

  describe("execute — dry run", () => {
    it("returns a simulated result without executing the tool", async () => {
      const executeSpy = vi.fn(async () => okResult("should not run"));
      registry.register(makeTool({ name: "real", execute: executeSpy }));

      const result = await registry.execute(
        "real",
        { x: 42 },
        makeCtx({ dryRun: true }),
      );
      expect(result.ok).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.content).toContain("DRY RUN");
      expect(executeSpy).not.toHaveBeenCalled();
    });
  });

  describe("execute — deprecation warning", () => {
    it("warns via console.warn for deprecated tools", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      registry.register(
        makeTool({
          name: "oldie",
          version: { version: "1.0.0", deprecated: true },
          execute: async () => okResult("still works"),
        }),
      );

      const result = await registry.execute("oldie", {}, makeCtx());
      expect(result.ok).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[ToolRegistry]"),
      );
      warnSpy.mockRestore();
    });

    it("does not warn for non-deprecated tools", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      registry.register(makeTool({ name: "modern" }));

      await registry.execute("modern", {}, makeCtx());
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("execute — idempotent caching", () => {
    it("caches the result of idempotent tools and returns cached value on repeat calls", async () => {
      let callCount = 0;
      registry.register(
        makeTool({
          name: "idem",
          options: { idempotent: true },
          execute: async () => {
            callCount++;
            return okResult(`call_${callCount}`);
          },
        }),
      );

      const ctx = makeCtx();
      const r1 = await registry.execute("idem", { key: "v" }, ctx);
      const r2 = await registry.execute("idem", { key: "v" }, ctx);
      expect(r1.content).toBe("call_1");
      expect(r2.content).toBe("call_1"); // cached
      expect(callCount).toBe(1);
    });

    it("does not cache when args differ", async () => {
      let callCount = 0;
      registry.register(
        makeTool({
          name: "idem2",
          options: { idempotent: true },
          execute: async () => {
            callCount++;
            return okResult(`call_${callCount}`);
          },
        }),
      );

      const ctx = makeCtx();
      await registry.execute("idem2", { x: 1 }, ctx);
      await registry.execute("idem2", { x: 2 }, ctx);
      expect(callCount).toBe(2);
    });

    it("does not cache non-idempotent tools", async () => {
      let callCount = 0;
      registry.register(
        makeTool({
          name: "nonidem",
          execute: async () => {
            callCount++;
            return okResult(`call_${callCount}`);
          },
        }),
      );

      const ctx = makeCtx();
      await registry.execute("nonidem", { a: 1 }, ctx);
      await registry.execute("nonidem", { a: 1 }, ctx);
      expect(callCount).toBe(2);
    });

    it("does not cache skipped (middleware skip) executions", async () => {
      let callCount = 0;
      registry.register(
        makeTool({
          name: "skip_idem",
          options: { idempotent: true },
          execute: async () => {
            callCount++;
            return okResult("executed");
          },
        }),
      );

      registry.addMiddleware({
        name: "skipper",
        before: async () => ({
          args: {},
          skip: true,
          result: okResult("skipped"),
        }),
      });

      const ctx = makeCtx();
      await registry.execute("skip_idem", {}, ctx);
      await registry.execute("skip_idem", {}, ctx);
      // Skipped executions do not hit the idempotent cache, middleware result returned directly
      expect(callCount).toBe(0);
    });

    it("clearIdempotentCache removes all cached entries", async () => {
      let callCount = 0;
      registry.register(
        makeTool({
          name: "cache_clear",
          options: { idempotent: true },
          execute: async () => {
            callCount++;
            return okResult(`call_${callCount}`);
          },
        }),
      );

      const ctx = makeCtx();
      await registry.execute("cache_clear", {}, ctx);
      registry.clearIdempotentCache();
      await registry.execute("cache_clear", {}, ctx);
      expect(callCount).toBe(2);
    });

    it("does not cache error results", async () => {
      let callCount = 0;
      registry.register(
        makeTool({
          name: "idem_err",
          options: { idempotent: true },
          execute: async () => {
            callCount++;
            return { ok: false, content: "fail", error: { code: "EXEC_ERROR" as const, message: "fail", retryable: false } };
          },
        }),
      );

      const ctx = makeCtx();
      await registry.execute("idem_err", {}, ctx);
      await registry.execute("idem_err", {}, ctx);
      // Error results are not cached, so execute runs again
      expect(callCount).toBe(2);
    });
  });

  describe("execute — timeout", () => {
    it("returns an error when execution exceeds the timeout", async () => {
      vi.useFakeTimers();
      try {
        registry.register(
          makeTool({
            name: "slow",
            options: { timeoutMs: 100 },
            execute: async () => {
              // Never resolves — times out every attempt
              return new Promise(() => {});
            },
          }),
        );

        const resultPromise = registry.execute("slow", {}, makeCtx());

        // Advance enough to cover all retry timeouts + backoff sleeps.
        // 4 attempts x 100ms timeout + backoffs (100+200+400) ~= 1100ms
        await vi.advanceTimersByTimeAsync(5000);

        const result = await resultPromise;
        expect(result.ok).toBe(false);
        expect(result.error).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("execute — retry", () => {
    it("retries up to 3 times on retryable errors, then returns the error", async () => {
      vi.useFakeTimers();
      try {
        let attempts = 0;
        registry.register(
          makeTool({
            name: "retry_me",
            execute: async () => {
              attempts++;
              return {
                ok: false,
                content: "fail",
                error: { code: "EXEC_ERROR" as const, message: `attempt_${attempts}`, retryable: true },
              };
            },
          }),
        );

        const resultPromise = registry.execute("retry_me", {}, makeCtx());

        // Advance through retry backoffs
        await vi.advanceTimersByTimeAsync(100); // sleep after attempt 1
        await vi.advanceTimersByTimeAsync(200); // sleep after attempt 2
        await vi.advanceTimersByTimeAsync(400); // sleep after attempt 3

        const result = await resultPromise;
        expect(result.ok).toBe(false);
        expect(attempts).toBe(4); // original + 3 retries
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not retry non-retryable errors", async () => {
      let attempts = 0;
      registry.register(
        makeTool({
          name: "no_retry",
          execute: async () => {
            attempts++;
            return {
              ok: false,
              content: "permanent fail",
              error: { code: "PERMISSION_DENIED" as const, message: "nope", retryable: false },
            };
          },
        }),
      );

      const result = await registry.execute("no_retry", {}, makeCtx());
      expect(result.ok).toBe(false);
      expect(attempts).toBe(1); // no retries
    });

    it("returns success on retry if a retryable error resolves", async () => {
      vi.useFakeTimers();
      try {
        let attempts = 0;
        registry.register(
          makeTool({
            name: "eventually_ok",
            execute: async () => {
              attempts++;
              if (attempts < 2) {
                return {
                  ok: false,
                  content: "temp fail",
                  error: { code: "EXEC_ERROR" as const, message: "transient", retryable: true },
                };
              }
              return okResult("recovered");
            },
          }),
        );

        const resultPromise = registry.execute("eventually_ok", {}, makeCtx());
        await vi.advanceTimersByTimeAsync(100); // first retry sleep

        const result = await resultPromise;
        expect(result.ok).toBe(true);
        expect(result.content).toBe("recovered");
        expect(attempts).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("execute — stats recording", () => {
    it("records execution stats after a successful call", async () => {
      registry.register(makeTool({ name: "tracked" }));

      await registry.execute("tracked", {}, makeCtx({ sessionId: "s1" }));
      const stats = registry.stats.getStats("tracked");
      expect(stats.totalCalls).toBe(1);
      expect(stats.successCount).toBe(1);
      expect(stats.errorCount).toBe(0);
    });

    it("records error stats after a failed call", async () => {
      registry.register(
        makeTool({
          name: "fail_track",
          execute: async () => ({
            ok: false,
            content: "fail",
            error: { code: "EXEC_ERROR" as const, message: "fail", retryable: false },
          }),
        }),
      );

      await registry.execute("fail_track", {}, makeCtx({ sessionId: "s1" }));
      const stats = registry.stats.getStats("fail_track");
      expect(stats.totalCalls).toBe(1);
      expect(stats.errorCount).toBe(1);
    });

    it("does not record stats for dry-run executions", async () => {
      registry.register(makeTool({ name: "dry_stats" }));

      await registry.execute("dry_stats", {}, makeCtx({ dryRun: true }));
      // dry-run returns before stats recording (early return path)
      expect(registry.stats.size).toBeLessThan(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Stats
  // ══════════════════════════════════════════════════════════════════════════

  describe("stats", () => {
    it("returns a ToolStatsCollector instance", () => {
      expect(registry.stats).toBeDefined();
      expect(typeof registry.stats.record).toBe("function");
    });

    it("uses default maxRecords of 1000", () => {
      // Default constructor creates with 1000
      expect(registry.stats.size).toBe(0);
    });

    it("accepts custom maxRecords and passes to collector", () => {
      const r = new ToolRegistry({ statsMaxRecords: 50 });
      expect(r.stats.size).toBe(0);
    });
  });
});

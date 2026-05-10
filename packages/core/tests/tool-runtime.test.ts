import { describe, expect, it, vi, beforeEach } from "vitest";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolStatsCollector } from "../src/tools/tool-stats.js";
import type { ToolDef, ToolResult, ToolContext, ToolMiddleware, ToolGroup } from "../src/tools/types.js";
import { errorResult } from "../src/tools/types.js";

function makeTool(name: string, opts?: Partial<ToolDef>): ToolDef {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object" as const, properties: {} },
    execute: opts?.execute ?? (async () => ({ ok: true, content: `${name} done` })),
    ...opts,
  };
}

function makeCtx(): ToolContext {
  return { cwd: "/tmp", sessionId: "test-session" };
}

describe("ToolStatsCollector", () => {
  it("records and retrieves stats for a specific tool", () => {
    const collector = new ToolStatsCollector();
    collector.record("read_file", {}, { ok: true, content: "ok" }, 100, "s1");
    collector.record("read_file", {}, { ok: true, content: "ok" }, 200, "s1");
    collector.record("read_file", {}, errorResult("UNKNOWN", "fail"), 50, "s1");

    const stats = collector.getStats("read_file");
    expect(stats.totalCalls).toBe(3);
    expect(stats.successCount).toBe(2);
    expect(stats.errorCount).toBe(1);
    expect(stats.errorRate).toBeCloseTo(1 / 3);
    expect(stats.avgDurationMs).toBeCloseTo(116.67, 0);
  });

  it("returns zero stats for unknown tool", () => {
    const collector = new ToolStatsCollector();
    const stats = collector.getStats("ghost");
    expect(stats.totalCalls).toBe(0);
    expect(stats.lastCalledAt).toBeNull();
  });

  it("computes percentiles correctly", () => {
    const collector = new ToolStatsCollector();
    // Add 100 records with durations 1..100
    for (let i = 1; i <= 100; i++) {
      collector.record("t", {}, { ok: true, content: "" }, i, "s");
    }

    const stats = collector.getStats("t");
    expect(stats.p50DurationMs).toBe(50);
    expect(stats.p95DurationMs).toBe(95);
    expect(stats.p99DurationMs).toBe(99);
  });

  it("evicts old records when maxRecords exceeded", () => {
    const collector = new ToolStatsCollector(5);
    for (let i = 0; i < 10; i++) {
      collector.record("t", {}, { ok: true, content: "" }, i, "s");
    }
    expect(collector.size).toBe(5);
    // Should have records 5..9
    const records = collector.getRecords();
    expect(records[0]!.durationMs).toBe(5);
  });

  it("topTools returns sorted by call count", () => {
    const collector = new ToolStatsCollector();
    for (let i = 0; i < 10; i++) collector.record("a", {}, { ok: true, content: "" }, 1, "s");
    for (let i = 0; i < 5; i++) collector.record("b", {}, { ok: true, content: "" }, 1, "s");
    for (let i = 0; i < 3; i++) collector.record("c", {}, { ok: true, content: "" }, 1, "s");

    const top = collector.topTools(2);
    expect(top).toHaveLength(2);
    expect(top[0]!.name).toBe("a");
    expect(top[0]!.calls).toBe(10);
    expect(top[1]!.name).toBe("b");
  });

  it("clear resets all records", () => {
    const collector = new ToolStatsCollector();
    collector.record("t", {}, { ok: true, content: "" }, 1, "s");
    expect(collector.size).toBe(1);
    collector.clear();
    expect(collector.size).toBe(0);
  });
});

describe("ToolRegistry — Middleware", () => {
  it("middleware.before can modify args", async () => {
    const registry = new ToolRegistry();
    const spy = vi.fn(async () => ({ ok: true, content: "done" }));
    registry.register(makeTool("t", { execute: spy }));

    registry.addMiddleware({
      name: "arg-modifier",
      before: async (_name, args) => {
        return { args: { ...args, added: true } };
      },
    });

    await registry.execute("t", { original: true }, makeCtx());
    expect(spy).toHaveBeenCalledWith({ original: true, added: true }, expect.anything());
  });

  it("middleware.before can short-circuit", async () => {
    const registry = new ToolRegistry();
    const spy = vi.fn(async () => ({ ok: true, content: "should not run" }));
    registry.register(makeTool("t", { execute: spy }));

    registry.addMiddleware({
      name: "blocker",
      before: async () => ({
        args: {},
        skip: true,
        result: { ok: false, content: "blocked by middleware" },
      }),
    });

    const result = await registry.execute("t", {}, makeCtx());
    expect(spy).not.toHaveBeenCalled();
    expect(result.content).toBe("blocked by middleware");
  });

  it("middleware.after can transform result", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("t"));

    registry.addMiddleware({
      name: "transformer",
      after: async (_name, _args, result) => ({
        ...result,
        content: result.content + " (transformed)",
      }),
    });

    const result = await registry.execute("t", {}, makeCtx());
    expect(result.content).toBe("t done (transformed)");
  });

  it("middleware.onError can recover from errors", async () => {
    const registry = new ToolRegistry();
    registry.register(
      makeTool("t", { execute: async () => { throw new Error("boom"); } })
    );

    registry.addMiddleware({
      name: "recoverer",
      onError: async () => ({ ok: true, content: "recovered" }),
    });

    const result = await registry.execute("t", {}, makeCtx());
    expect(result.ok).toBe(true);
    expect(result.content).toBe("recovered");
  });

  it("removeMiddleware works", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("t"));
    const mw: ToolMiddleware = {
      name: "removable",
      after: async (_n, _a, r) => ({ ...r, content: "modified" }),
    };
    registry.addMiddleware(mw);

    await registry.execute("t", {}, makeCtx());
    // Now remove
    expect(registry.removeMiddleware("removable")).toBe(true);
    expect(registry.removeMiddleware("nonexistent")).toBe(false);

    const result = await registry.execute("t", {}, makeCtx());
    expect(result.content).toBe("t done"); // not modified
  });

  it("multiple middlewares execute in order", async () => {
    const registry = new ToolRegistry();
    const order: string[] = [];
    registry.register(makeTool("t"));

    registry.addMiddleware({
      name: "first",
      before: async () => { order.push("first"); return null; },
    });
    registry.addMiddleware({
      name: "second",
      before: async () => { order.push("second"); return null; },
    });

    await registry.execute("t", {}, makeCtx());
    expect(order).toEqual(["first", "second"]);
  });
});

describe("ToolRegistry — Groups", () => {
  it("registerGroup registers all tools with group defaults", () => {
    const registry = new ToolRegistry();
    const group: ToolGroup = {
      name: "filesystem",
      description: "File system tools",
      defaults: { timeoutMs: 5000 },
    };
    const tools = [makeTool("read"), makeTool("write")];
    registry.registerGroup(group, tools);

    expect(registry.has("read")).toBe(true);
    expect(registry.has("write")).toBe(true);
    expect(registry.get("read")!.group).toBe("filesystem");
    expect(registry.get("read")!.options?.timeoutMs).toBe(5000);
  });

  it("tool options override group defaults", () => {
    const registry = new ToolRegistry();
    registry.registerGroup(
      { name: "g", defaults: { timeoutMs: 5000 } },
      [makeTool("t", { options: { timeoutMs: 1000 } })]
    );
    expect(registry.get("t")!.options?.timeoutMs).toBe(1000);
  });

  it("getGroup returns group and its tools", () => {
    const registry = new ToolRegistry();
    registry.registerGroup(
      { name: "git" },
      [makeTool("commit"), makeTool("push")]
    );
    registry.register(makeTool("other")); // not in group

    const result = registry.getGroup("git");
    expect(result).toBeDefined();
    expect(result!.tools).toHaveLength(2);
    expect(result!.group.name).toBe("git");
  });

  it("getSchemasByGroup returns only group schemas", () => {
    const registry = new ToolRegistry();
    registry.registerGroup({ name: "a" }, [makeTool("a1"), makeTool("a2")]);
    registry.register(makeTool("b1")); // no group

    const schemas = registry.getSchemasByGroup("a");
    expect(schemas).toHaveLength(2);
    expect(schemas.map((s) => s.name)).toEqual(["a1", "a2"]);
  });
});

describe("ToolRegistry — Versioning", () => {
  it("getDeprecationWarning returns null for non-deprecated tools", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("t"));
    expect(registry.getDeprecationWarning("t")).toBeNull();
  });

  it("getDeprecationWarning returns message for deprecated tools", () => {
    const registry = new ToolRegistry();
    registry.register(
      makeTool("old", {
        version: {
          version: "1.0.0",
          deprecated: true,
          deprecatedReason: "Use new API.",
          replacedBy: "new_tool",
        },
      })
    );

    const warning = registry.getDeprecationWarning("old");
    expect(warning).toContain("Use new API.");
    expect(warning).toContain('"new_tool"');
  });

  it("getDeprecationWarning uses default reason if not specified", () => {
    const registry = new ToolRegistry();
    registry.register(
      makeTool("old", {
        version: { version: "1.0.0", deprecated: true },
      })
    );
    expect(registry.getDeprecationWarning("old")).toContain("deprecated");
  });
});

describe("ToolStatsCollector — Memory Control", () => {
  it("default maxRecords is 1000 (reasonable memory bound)", () => {
    const collector = new ToolStatsCollector();
    // Record 1500 entries — only 1000 should remain
    for (let i = 0; i < 1500; i++) {
      collector.record("t", { i }, { ok: true, content: "ok" }, i, "s");
    }
    expect(collector.size).toBe(1000);
    // Oldest 500 were evicted
    const records = collector.getRecords();
    expect(records[0]!.durationMs).toBe(500);
    expect(records[999]!.durationMs).toBe(1499);
  });

  it("registry uses same default maxRecords", () => {
    const registry = new ToolRegistry();
    // Registry stats collector should use 1000 as default
    for (let i = 0; i < 1500; i++) {
      registry.stats.record("t", {}, { ok: true, content: "" }, i, "s");
    }
    expect(registry.stats.size).toBe(1000);
  });
});

describe("ToolRegistry — Stats Integration", () => {
  it("records stats after execution", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("t"));

    await registry.execute("t", {}, makeCtx());
    await registry.execute("t", {}, makeCtx());

    const stats = registry.stats.getStats("t");
    expect(stats.totalCalls).toBe(2);
    expect(stats.successCount).toBe(2);
  });

  it("records failed executions in stats", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("fail", { execute: async () => errorResult("UNKNOWN", "oops") }));

    await registry.execute("fail", {}, makeCtx());

    const stats = registry.stats.getStats("fail");
    expect(stats.totalCalls).toBe(1);
    expect(stats.errorCount).toBe(1);
  });
});

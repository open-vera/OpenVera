/**
 * Tests for Phase 5 subagent enhancements (SA1–SA4).
 *
 * SA1: Parallel fan-out (parallel option)
 * SA2: SharedContext layer
 * SA3: Permissions & usage tracking
 * SA4: Recursive subagent depth limiting
 */
import { describe, it, expect } from "vitest";
import { SharedContext } from "../src/agent/shared-context.js";
import {
  SubagentOrchestrator,
  type OrchestratorTask,
} from "../src/agent/subagent-orchestrator.js";
import { SubagentPool } from "../src/agent/subagent-pool.js";
import { MaxDepthExceededError } from "../src/errors.js";

// ─── SA1: Parallel fan-out ──────────────────────────────────────────────────

describe("SA1 — Parallel fan-out", () => {
  it("should launch all tasks in parallel when parallel=true, ignoring dependencies", async () => {
    const started: string[] = [];

    const orch = new SubagentOrchestrator([
      { id: "a", agentType: "coder", prompt: "A" },
      { id: "b", agentType: "coder", prompt: "B", dependsOn: ["a"] },
      { id: "c", agentType: "coder", prompt: "C", dependsOn: ["b"] },
    ]);

    const results = await orch.run({
      parallel: true,
      executeTask: async (task) => {
        started.push(task.id);
        // Small delay to let all tasks register as started
        await new Promise((r) => setTimeout(r, 10));
        return `out-${task.id}`;
      },
    });

    // All three should have started in the same batch
    expect(started).toHaveLength(3);
    expect(started.sort()).toEqual(["a", "b", "c"]);
    expect(results.size).toBe(3);
    expect(orch.getStatus()).toBe("completed");
  });

  it("should still respect dependencies when parallel is not set (default)", async () => {
    const executionOrder: string[] = [];

    const orch = new SubagentOrchestrator([
      { id: "a", agentType: "coder", prompt: "A" },
      { id: "b", agentType: "coder", prompt: "B", dependsOn: ["a"] },
      { id: "c", agentType: "coder", prompt: "C", dependsOn: ["b"] },
    ]);

    await orch.run({
      executeTask: async (task) => {
        executionOrder.push(task.id);
        return `out-${task.id}`;
      },
    });

    expect(executionOrder).toEqual(["a", "b", "c"]);
  });

  it("should still record failures in parallel mode", async () => {
    const orch = new SubagentOrchestrator([
      { id: "a", agentType: "coder", prompt: "fail" },
      { id: "b", agentType: "coder", prompt: "ok" },
    ]);

    const results = await orch.run({
      parallel: true,
      executeTask: async (task) => {
        if (task.id === "a") throw new Error("boom");
        return "ok";
      },
    });

    expect(results.get("a")?.status).toBe("failed");
    expect(results.get("a")?.error).toBe("boom");
    expect(results.get("b")?.status).toBe("completed");
    expect(orch.getStatus()).toBe("failed");
  });

  it("should respect abort signal in parallel mode", async () => {
    const controller = new AbortController();
    controller.abort();

    const orch = new SubagentOrchestrator([
      { id: "a", agentType: "coder", prompt: "A" },
      { id: "b", agentType: "coder", prompt: "B" },
    ]);

    const results = await orch.run({
      parallel: true,
      executeTask: async () => "should not run",
      signal: controller.signal,
    });

    expect(orch.getStatus()).toBe("cancelled");
    expect(results.size).toBe(0);
  });
});

// ─── SA2: SharedContext ─────────────────────────────────────────────────────

describe("SA2 — SharedContext", () => {
  describe("CRUD operations", () => {
    it("should set and get values", () => {
      const ctx = new SharedContext();
      ctx.set("key1", "value1");
      expect(ctx.get("key1")).toBe("value1");
    });

    it("should return undefined for missing keys", () => {
      const ctx = new SharedContext();
      expect(ctx.get("missing")).toBeUndefined();
    });

    it("should check key existence with has()", () => {
      const ctx = new SharedContext();
      expect(ctx.has("key")).toBe(false);
      ctx.set("key", 42);
      expect(ctx.has("key")).toBe(true);
    });

    it("should delete keys", () => {
      const ctx = new SharedContext();
      ctx.set("key", "val");
      expect(ctx.delete("key")).toBe(true);
      expect(ctx.has("key")).toBe(false);
      expect(ctx.delete("nonexistent")).toBe(false);
    });

    it("should list all keys", () => {
      const ctx = new SharedContext();
      ctx.set("a", 1);
      ctx.set("b", 2);
      ctx.set("c", 3);
      expect(ctx.keys().sort()).toEqual(["a", "b", "c"]);
    });

    it("should support generic type parameter on get", () => {
      const ctx = new SharedContext();
      ctx.set("num", 42);
      const val = ctx.get<number>("num");
      expect(val).toBe(42);
    });
  });

  describe("snapshot", () => {
    it("should return a shallow copy of all entries", () => {
      const ctx = new SharedContext();
      ctx.set("x", 10);
      ctx.set("y", "hello");

      const snap = ctx.snapshot();
      expect(snap).toEqual({ x: 10, y: "hello" });

      // Mutating the snapshot should not affect the context
      snap["z"] = 99;
      expect(ctx.has("z")).toBe(false);
    });

    it("should return empty object for empty context", () => {
      const ctx = new SharedContext();
      expect(ctx.snapshot()).toEqual({});
    });
  });

  describe("merge", () => {
    it("should bulk-merge entries from a plain object", () => {
      const ctx = new SharedContext();
      ctx.set("existing", "keep");
      ctx.merge({ a: 1, b: 2, existing: "overwritten" });

      expect(ctx.get("a")).toBe(1);
      expect(ctx.get("b")).toBe(2);
      expect(ctx.get("existing")).toBe("overwritten");
    });

    it("should handle empty merge", () => {
      const ctx = new SharedContext();
      ctx.set("k", "v");
      ctx.merge({});
      expect(ctx.get("k")).toBe("v");
    });
  });

  describe("orchestrator integration", () => {
    it("should expose SharedContext via getSharedContext()", () => {
      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "A" },
      ]);
      const ctx = orch.getSharedContext();
      expect(ctx).toBeInstanceOf(SharedContext);
    });

    it("should pass SharedContext to executeTask callback", async () => {
      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "A" },
      ]);

      let receivedCtx: SharedContext | undefined;
      await orch.run({
        executeTask: async (_task, _depCtx, sharedCtx) => {
          receivedCtx = sharedCtx;
          return "out";
        },
      });

      expect(receivedCtx).toBeInstanceOf(SharedContext);
      expect(receivedCtx).toBe(orch.getSharedContext());
    });

    it("should auto-write output to SharedContext when task has outputKey", async () => {
      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "generate data", outputKey: "data" },
      ]);

      await orch.run({
        executeTask: async () => "generated-value",
      });

      const ctx = orch.getSharedContext();
      expect(ctx.get("data")).toBe("generated-value");
    });

    it("should not write to SharedContext when task has no outputKey", async () => {
      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "no key" },
      ]);

      await orch.run({
        executeTask: async () => "result",
      });

      expect(orch.getSharedContext().keys()).toHaveLength(0);
    });

    it("should allow later tasks to read earlier task output via SharedContext", async () => {
      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "generate", outputKey: "step1" },
        { id: "b", agentType: "coder", prompt: "consume", dependsOn: ["a"] },
      ]);

      let consumed: unknown;
      await orch.run({
        executeTask: async (task, _depCtx, sharedCtx) => {
          if (task.id === "b") {
            consumed = sharedCtx.get("step1");
          }
          return `out-${task.id}`;
        },
      });

      expect(consumed).toBe("out-a");
    });
  });
});

// ─── SA3: Permissions & usage ───────────────────────────────────────────────

describe("SA3 — Permissions & usage", () => {
  describe("permissions", () => {
    it("should set and get permissions for a job", () => {
      const pool = new SubagentPool();
      pool.submit("j1", "coder", "task");
      pool.setPermissions("j1", ["read", "write", "execute"]);

      expect(pool.getPermissions("j1")).toEqual(["read", "write", "execute"]);
    });

    it("should return empty array for job without permissions", () => {
      const pool = new SubagentPool();
      pool.submit("j1", "coder", "task");
      expect(pool.getPermissions("j1")).toEqual([]);
    });

    it("should return empty array for unknown job", () => {
      const pool = new SubagentPool();
      expect(pool.getPermissions("unknown")).toEqual([]);
    });

    it("should overwrite permissions on subsequent setPermissions calls", () => {
      const pool = new SubagentPool();
      pool.submit("j1", "coder", "task");
      pool.setPermissions("j1", ["read"]);
      pool.setPermissions("j1", ["read", "write"]);
      expect(pool.getPermissions("j1")).toEqual(["read", "write"]);
    });

    it("should be a no-op for unknown job", () => {
      const pool = new SubagentPool();
      pool.setPermissions("nonexistent", ["read"]);
      // Should not throw
    });
  });

  describe("usage", () => {
    it("should return zero usage when no jobs have usage set", () => {
      const pool = new SubagentPool();
      pool.submit("j1", "coder", "task");
      pool.submit("j2", "coder", "task");

      const total = pool.getTotalUsage();
      expect(total).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    });

    it("should aggregate usage from multiple jobs", () => {
      const pool = new SubagentPool();
      const j1 = pool.submit("j1", "coder", "task 1");
      const j2 = pool.submit("j2", "coder", "task 2");

      j1.usage = { promptTokens: 100, completionTokens: 50, totalTokens: 150 };
      j2.usage = { promptTokens: 200, completionTokens: 80, totalTokens: 280 };

      const total = pool.getTotalUsage();
      expect(total).toEqual({ promptTokens: 300, completionTokens: 130, totalTokens: 430 });
    });

    it("should handle mixed jobs with and without usage", () => {
      const pool = new SubagentPool();
      const j1 = pool.submit("j1", "coder", "task 1");
      pool.submit("j2", "coder", "task 2");

      j1.usage = { promptTokens: 50, completionTokens: 25, totalTokens: 75 };

      const total = pool.getTotalUsage();
      expect(total).toEqual({ promptTokens: 50, completionTokens: 25, totalTokens: 75 });
    });

    it("should return zero usage for empty pool", () => {
      const pool = new SubagentPool();
      expect(pool.getTotalUsage()).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    });
  });
});

// ─── SA4: Recursive subagent depth ──────────────────────────────────────────

describe("SA4 — Recursive subagent depth", () => {
  it("should default maxDepth to 3", () => {
    const pool = new SubagentPool();
    // depth 0, 1, 2 should succeed; depth 3 should throw
    pool.submit("j0", "coder", "task", { depth: 0 });
    pool.submit("j1", "coder", "task", { depth: 1 });
    pool.submit("j2", "coder", "task", { depth: 2 });
    expect(() => pool.submit("j3", "coder", "task", { depth: 3 })).toThrow(MaxDepthExceededError);
  });

  it("should throw MaxDepthExceededError when depth >= maxDepth", () => {
    const pool = new SubagentPool({ maxDepth: 2 });
    pool.submit("j0", "coder", "task", { depth: 0 });
    pool.submit("j1", "coder", "task", { depth: 1 });
    expect(() => pool.submit("j2", "coder", "task", { depth: 2 })).toThrow(MaxDepthExceededError);
  });

  it("should include depth info in MaxDepthExceededError", () => {
    const pool = new SubagentPool({ maxDepth: 1 });
    try {
      pool.submit("j1", "coder", "task", { depth: 1 });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MaxDepthExceededError);
      const e = err as MaxDepthExceededError;
      expect(e.code).toBe("MAX_DEPTH_EXCEEDED");
      expect(e.message).toContain("depth 1");
      expect(e.message).toContain("max depth 1");
    }
  });

  it("should allow depth 0 (top-level) by default", () => {
    const pool = new SubagentPool();
    const job = pool.submit("j1", "coder", "task", { depth: 0 });
    expect(job.depth).toBe(0);
  });

  it("should default depth to 0 when not specified", () => {
    const pool = new SubagentPool();
    const job = pool.submit("j1", "coder", "task");
    expect(job.depth).toBe(0);
  });

  it("should get depth of a submitted job", () => {
    const pool = new SubagentPool();
    pool.submit("j1", "coder", "task", { depth: 2 });
    expect(pool.getDepth("j1")).toBe(2);
  });

  it("should return 0 for getDepth on unknown job", () => {
    const pool = new SubagentPool();
    expect(pool.getDepth("unknown")).toBe(0);
  });

  it("should respect custom maxDepth", () => {
    const pool = new SubagentPool({ maxDepth: 5 });
    // depth 4 should be allowed
    pool.submit("j4", "coder", "task", { depth: 4 });
    // depth 5 should throw
    expect(() => pool.submit("j5", "coder", "task", { depth: 5 })).toThrow(MaxDepthExceededError);
  });

  it("should work with maxDepth=1 (only depth 0 allowed)", () => {
    const pool = new SubagentPool({ maxDepth: 1 });
    pool.submit("j0", "coder", "task", { depth: 0 });
    expect(() => pool.submit("j1", "coder", "task", { depth: 1 })).toThrow(MaxDepthExceededError);
  });
});

/**
 * Tests for SubagentOrchestrator — coordinate multiple subagents with patterns.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SubagentOrchestrator,
  fanOut,
  pipeline,
  mapReduce,
  type OrchestratorTask,
} from "../src/agent/subagent-orchestrator.js";

describe("SubagentOrchestrator", () => {
  describe("constructor", () => {
    it("should create orchestrator with valid tasks", () => {
      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "task A" },
        { id: "b", agentType: "coder", prompt: "task B", dependsOn: ["a"] },
      ]);
      expect(orch.getStatus()).toBe("pending");
      expect(orch.getResults().size).toBe(0);
    });

    it("should throw on missing dependency", () => {
      expect(
        () =>
          new SubagentOrchestrator([
            { id: "b", agentType: "coder", prompt: "task B", dependsOn: ["a"] },
          ])
      ).toThrow('depends on unknown task "a"');
    });

    it("should throw on circular dependency", () => {
      expect(
        () =>
          new SubagentOrchestrator([
            { id: "a", agentType: "coder", prompt: "A", dependsOn: ["b"] },
            { id: "b", agentType: "coder", prompt: "B", dependsOn: ["a"] },
          ])
      ).toThrow("Circular dependency");
    });

    it("should throw on multi-hop circular dependency", () => {
      expect(
        () =>
          new SubagentOrchestrator([
            { id: "a", agentType: "coder", prompt: "A", dependsOn: ["c"] },
            { id: "b", agentType: "coder", prompt: "B", dependsOn: ["a"] },
            { id: "c", agentType: "coder", prompt: "C", dependsOn: ["b"] },
          ])
      ).toThrow("Circular dependency");
    });
  });

  describe("run — no dependencies (parallel)", () => {
    it("should execute all independent tasks", async () => {
      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "task A" },
        { id: "b", agentType: "coder", prompt: "task B" },
        { id: "c", agentType: "coder", prompt: "task C" },
      ]);

      const executeTask = vi.fn(async (task: OrchestratorTask) => `result-${task.id}`);
      const results = await orch.run({ executeTask });

      expect(executeTask).toHaveBeenCalledTimes(3);
      expect(results.size).toBe(3);
      expect(results.get("a")?.status).toBe("completed");
      expect(results.get("a")?.output).toBe("result-a");
      expect(results.get("b")?.output).toBe("result-b");
      expect(results.get("c")?.output).toBe("result-c");
      expect(orch.getStatus()).toBe("completed");
    });

    it("should call onTaskComplete for each completed task", async () => {
      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "A" },
        { id: "b", agentType: "coder", prompt: "B" },
      ]);

      const completed: Array<{ id: string; output: string }> = [];
      await orch.run({
        executeTask: async (task) => `out-${task.id}`,
        onTaskComplete: (taskId, output) => completed.push({ id: taskId, output }),
      });

      expect(completed).toHaveLength(2);
      expect(completed.map((c) => c.id).sort()).toEqual(["a", "b"]);
    });
  });

  describe("run — sequential dependencies", () => {
    it("should execute tasks in dependency order", async () => {
      const executionOrder: string[] = [];

      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "first" },
        { id: "b", agentType: "coder", prompt: "second", dependsOn: ["a"] },
        { id: "c", agentType: "coder", prompt: "third", dependsOn: ["b"] },
      ]);

      await orch.run({
        executeTask: async (task) => {
          executionOrder.push(task.id);
          return `done-${task.id}`;
        },
      });

      expect(executionOrder).toEqual(["a", "b", "c"]);
    });

    it("should inject dependency context when injectResults is true", async () => {
      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "generate code" },
        {
          id: "b",
          agentType: "coder",
          prompt: "review code",
          dependsOn: ["a"],
          injectResults: true,
        },
      ]);

      const contexts: Record<string, string> = {};
      await orch.run({
        executeTask: async (task, context) => {
          contexts[task.id] = context;
          return `out-${task.id}`;
        },
      });

      expect(contexts["a"]).toBe("");
      expect(contexts["b"]).toContain("[a]: out-a");
    });

    it("should run independent tasks in parallel alongside dependent ones", async () => {
      const executionOrder: string[] = [];

      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "A" },
        { id: "b", agentType: "coder", prompt: "B" }, // independent
        { id: "c", agentType: "coder", prompt: "C", dependsOn: ["a"] }, // depends on a
      ]);

      await orch.run({
        executeTask: async (task, ctx) => {
          executionOrder.push(task.id);
          return `done`;
        },
      });

      // a and b should run in the first batch (order between them may vary)
      // c should run after a completes
      expect(executionOrder.indexOf("a")).toBeLessThan(executionOrder.indexOf("c"));
      expect(executionOrder.indexOf("b")).toBeLessThan(executionOrder.indexOf("c"));
    });
  });

  describe("run — error handling", () => {
    it("should mark failed tasks and continue with independent tasks", async () => {
      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "will fail" },
        { id: "b", agentType: "coder", prompt: "will succeed" },
      ]);

      const results = await orch.run({
        executeTask: async (task) => {
          if (task.id === "a") throw new Error("boom");
          return "ok";
        },
      });

      expect(results.get("a")?.status).toBe("failed");
      expect(results.get("a")?.error).toBe("boom");
      expect(results.get("b")?.status).toBe("completed");
      // Orchestrator should be "failed" because not all tasks completed
      expect(orch.getStatus()).toBe("failed");
    });

    it("should call onTaskFail for failed tasks", async () => {
      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "fail" },
      ]);

      const failures: Array<{ id: string; error: string }> = [];
      await orch.run({
        executeTask: async () => {
          throw new Error("oops");
        },
        onTaskFail: (taskId, error) => failures.push({ id: taskId, error }),
      });

      expect(failures).toHaveLength(1);
      expect(failures[0]).toEqual({ id: "a", error: "oops" });
    });

    it("should block dependent tasks when a dependency fails", async () => {
      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "will fail" },
        { id: "b", agentType: "coder", prompt: "depends on a", dependsOn: ["a"] },
      ]);

      const executed: string[] = [];
      await orch.run({
        executeTask: async (task) => {
          executed.push(task.id);
          if (task.id === "a") throw new Error("fail");
          return "ok";
        },
      });

      // b should NOT have been executed because a failed
      expect(executed).toEqual(["a"]);
      expect(orch.getStatus()).toBe("failed");
    });

    it("should handle non-Error throws gracefully", async () => {
      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "throws string" },
      ]);

      const results = await orch.run({
        executeTask: async () => {
          throw "string error"; // eslint-disable-line no-throw-literal
        },
      });

      expect(results.get("a")?.status).toBe("failed");
      expect(results.get("a")?.error).toBe("string error");
    });
  });

  describe("run — abort signal", () => {
    it("should stop when abort signal fires", async () => {
      const controller = new AbortController();

      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "A" },
        { id: "b", agentType: "coder", prompt: "B" },
        { id: "c", agentType: "coder", prompt: "C", dependsOn: ["b"] },
      ]);

      // Abort immediately
      controller.abort();

      const results = await orch.run({
        executeTask: async () => "should not run",
        signal: controller.signal,
      });

      expect(orch.getStatus()).toBe("cancelled");
      // No tasks should have been executed
      expect(results.size).toBe(0);
    });

    it("should stop mid-execution when signal aborts", async () => {
      const controller = new AbortController();

      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "A" },
        { id: "b", agentType: "coder", prompt: "B" },
      ]);

      let callCount = 0;
      const results = await orch.run({
        executeTask: async (task) => {
          callCount++;
          if (task.id === "b") controller.abort(); // abort during b
          return `done-${task.id}`;
        },
        signal: controller.signal,
      });

      // a completes, b may or may not complete depending on timing
      // But status should be cancelled
      expect(orch.getStatus()).toBe("cancelled");
    });
  });

  describe("getResults & getSummary", () => {
    it("should return a copy of results", async () => {
      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "A" },
      ]);

      await orch.run({ executeTask: async () => "out" });

      const r1 = orch.getResults();
      const r2 = orch.getResults();
      expect(r1).not.toBe(r2); // different references
      expect(r1.get("a")?.output).toBe("out");
    });

    it("should produce a summary with icons", async () => {
      const orch = new SubagentOrchestrator([
        { id: "ok", agentType: "coder", prompt: "good" },
        { id: "bad", agentType: "coder", prompt: "bad" },
        { id: "pending", agentType: "coder", prompt: "waiting", dependsOn: ["bad"] },
      ]);

      await orch.run({
        executeTask: async (task) => {
          if (task.id === "bad") throw new Error("fail");
          return "ok";
        },
      });

      const summary = orch.getSummary();
      expect(summary).toContain("✅ ok: completed");
      expect(summary).toContain("❌ bad: failed");
      expect(summary).toContain("Error: fail");
      // pending task should show as pending (blocked by failed dep)
      expect(summary).toContain("⏳ pending: pending");
    });

    it("should report initial status as pending", () => {
      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "A" },
      ]);
      expect(orch.getStatus()).toBe("pending");
    });
  });

  describe("run — duration tracking", () => {
    it("should record durationMs for completed tasks", async () => {
      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "A" },
      ]);

      const results = await orch.run({
        executeTask: async () => {
          // small delay to ensure duration > 0
          await new Promise((r) => setTimeout(r, 5));
          return "done";
        },
      });

      expect(results.get("a")?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should record durationMs for failed tasks", async () => {
      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "A" },
      ]);

      const results = await orch.run({
        executeTask: async () => {
          await new Promise((r) => setTimeout(r, 5));
          throw new Error("fail");
        },
      });

      expect(results.get("a")?.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("run — empty task list", () => {
    it("should complete immediately with no tasks", async () => {
      const orch = new SubagentOrchestrator([]);
      const results = await orch.run({
        executeTask: async () => "should not be called",
      });

      expect(results.size).toBe(0);
      expect(orch.getStatus()).toBe("completed");
    });
  });

  describe("run — diamond dependency", () => {
    it("should handle diamond dependency pattern (a → [b,c] → d)", async () => {
      const orch = new SubagentOrchestrator([
        { id: "a", agentType: "coder", prompt: "root" },
        { id: "b", agentType: "coder", prompt: "left", dependsOn: ["a"] },
        { id: "c", agentType: "coder", prompt: "right", dependsOn: ["a"] },
        { id: "d", agentType: "coder", prompt: "merge", dependsOn: ["b", "c"] },
      ]);

      const execOrder: string[] = [];
      const results = await orch.run({
        executeTask: async (task) => {
          execOrder.push(task.id);
          return `out-${task.id}`;
        },
      });

      // a must be first
      expect(execOrder[0]).toBe("a");
      // b and c must come after a
      expect(execOrder.indexOf("b")).toBeGreaterThan(execOrder.indexOf("a"));
      expect(execOrder.indexOf("c")).toBeGreaterThan(execOrder.indexOf("a"));
      // d must come after both b and c
      expect(execOrder.indexOf("d")).toBeGreaterThan(execOrder.indexOf("b"));
      expect(execOrder.indexOf("d")).toBeGreaterThan(execOrder.indexOf("c"));
      // d should have context from both b and c
      expect(results.get("d")?.status).toBe("completed");
      expect(orch.getStatus()).toBe("completed");
    });
  });
});

describe("pipeline", () => {
  it("should create sequential orchestrator", async () => {
    const orch = pipeline([
      { id: "step1", agentType: "coder", prompt: "first" },
      { id: "step2", agentType: "coder", prompt: "second" },
      { id: "step3", agentType: "coder", prompt: "third" },
    ]);

    const order: string[] = [];
    await orch.run({
      executeTask: async (task) => {
        order.push(task.id);
        return `out-${task.id}`;
      },
    });

    expect(order).toEqual(["step1", "step2", "step3"]);
  });

  it("should propagate results as context in pipeline", async () => {
    const orch = pipeline([
      { id: "gen", agentType: "coder", prompt: "generate" },
      { id: "review", agentType: "coder", prompt: "review" },
    ]);

    const contexts: Record<string, string> = {};
    await orch.run({
      executeTask: async (task, ctx) => {
        contexts[task.id] = ctx;
        return `out-${task.id}`;
      },
    });

    expect(contexts["gen"]).toBe("");
    expect(contexts["review"]).toContain("[gen]: out-gen");
  });

  it("should handle single-task pipeline", async () => {
    const orch = pipeline([
      { id: "only", agentType: "coder", prompt: "do it" },
    ]);

    const results = await orch.run({
      executeTask: async () => "done",
    });

    expect(results.get("only")?.output).toBe("done");
    expect(orch.getStatus()).toBe("completed");
  });
});

describe("mapReduce", () => {
  it("should run map tasks in parallel then reduce", async () => {
    const orch = mapReduce(
      [
        { id: "map1", agentType: "coder", prompt: "chunk 1" },
        { id: "map2", agentType: "coder", prompt: "chunk 2" },
        { id: "map3", agentType: "coder", prompt: "chunk 3" },
      ],
      { id: "reduce", agentType: "coder", prompt: "combine" }
    );

    const order: string[] = [];
    await orch.run({
      executeTask: async (task) => {
        order.push(task.id);
        return `out-${task.id}`;
      },
    });

    // All map tasks should run before reduce
    const reduceIdx = order.indexOf("reduce");
    expect(reduceIdx).toBe(3); // reduce runs 4th
    expect(order.slice(0, 3).sort()).toEqual(["map1", "map2", "map3"]);
  });

  it("should inject all map results into reduce context", async () => {
    const orch = mapReduce(
      [
        { id: "map1", agentType: "coder", prompt: "data A" },
        { id: "map2", agentType: "coder", prompt: "data B" },
      ],
      { id: "reduce", agentType: "coder", prompt: "combine" }
    );

    const reduceContext = await new Promise<string>((resolve) => {
      orch.run({
        executeTask: async (task, ctx) => {
          if (task.id === "reduce") resolve(ctx);
          return `out-${task.id}`;
        },
      });
    });

    expect(reduceContext).toContain("[map1]: out-map1");
    expect(reduceContext).toContain("[map2]: out-map2");
  });

  it("should fail reduce if a map task fails", async () => {
    const orch = mapReduce(
      [
        { id: "map1", agentType: "coder", prompt: "ok" },
        { id: "map2", agentType: "coder", prompt: "fail" },
      ],
      { id: "reduce", agentType: "coder", prompt: "combine" }
    );

    const executed: string[] = [];
    await orch.run({
      executeTask: async (task) => {
        executed.push(task.id);
        if (task.id === "map2") throw new Error("map failed");
        return `out-${task.id}`;
      },
    });

    // reduce should NOT have been executed because map2 failed
    expect(executed).not.toContain("reduce");
    expect(orch.getStatus()).toBe("failed");
  });
});

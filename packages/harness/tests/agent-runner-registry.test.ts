import { describe, expect, it, vi } from "vitest";
import type { AgentRunner, AgentRunnerCapabilities, RunnerReadiness } from "../src/agent/types.js";
import { AgentRunnerRegistry } from "../src/agent/types.js";
import type { AgentAssignment, StepResult } from "@open-vera/core/types";
import type { RunAssignmentOptions } from "../src/runtime/internal.js";

function makeRunner(opts: {
  caps?: AgentRunnerCapabilities;
  ready?: RunnerReadiness;
  name?: string;
} = {}): AgentRunner {
  return {
    name: opts.name,
    capabilities: opts.caps,
    isReady: opts.ready ? async () => opts.ready! : undefined,
    run: async (assignment: AgentAssignment, _options: RunAssignmentOptions): Promise<StepResult> => ({
      flowId: assignment.flowId,
      stepId: assignment.stepId,
      output: "done",
      toolCalls: [],
    }),
  };
}

describe("AgentRunnerRegistry", () => {
  // ─── Basic Registration ────────────────────────────────────────────────

  describe("register / get / has / list", () => {
    it("registers and retrieves runners by name", () => {
      const registry = new AgentRunnerRegistry();
      const runner = makeRunner({ name: "test-runner" });
      registry.register("alpha", runner);

      expect(registry.has("alpha")).toBe(true);
      expect(registry.get("alpha")).toBe(runner);
      expect(registry.has("beta")).toBe(false);
    });

    it("sets runner.name from register name if not set", () => {
      const registry = new AgentRunnerRegistry();
      const runner = makeRunner();
      registry.register("auto-named", runner);
      expect(runner.name).toBe("auto-named");
    });

    it("preserves runner.name if already set", () => {
      const registry = new AgentRunnerRegistry();
      const runner = makeRunner({ name: "custom-name" });
      registry.register("alias", runner);
      expect(runner.name).toBe("custom-name");
    });

    it("lists all registered runners", () => {
      const registry = new AgentRunnerRegistry();
      registry.register("a", makeRunner());
      registry.register("b", makeRunner());

      const list = registry.list();
      expect(list).toHaveLength(2);
      expect(list.map((r) => r.name)).toEqual(["a", "b"]);
    });
  });

  // ─── Fallback Chain ───────────────────────────────────────────────────

  describe("getAvailable", () => {
    it("returns primary runner when available", async () => {
      const registry = new AgentRunnerRegistry();
      const primary = makeRunner({ ready: { ready: true } });
      const fallback = makeRunner({ ready: { ready: true } });
      registry.register("primary", primary);
      registry.register("fallback", fallback);

      const result = await registry.getAvailable("primary", ["fallback"]);
      expect(result).toBe(primary);
    });

    it("falls back when primary is not ready", async () => {
      const registry = new AgentRunnerRegistry();
      const primary = makeRunner({ ready: { ready: false, reason: "offline" } });
      const fallback = makeRunner({ ready: { ready: true } });
      registry.register("primary", primary);
      registry.register("fallback", fallback);

      const result = await registry.getAvailable("primary", ["fallback"]);
      expect(result).toBe(fallback);
    });

    it("returns undefined when no runners are ready", async () => {
      const registry = new AgentRunnerRegistry();
      registry.register("a", makeRunner({ ready: { ready: false, reason: "down" } }));
      registry.register("b", makeRunner({ ready: { ready: false } }));

      const result = await registry.getAvailable("a", ["b"]);
      expect(result).toBeUndefined();
    });

    it("returns runner without isReady check as always ready", async () => {
      const registry = new AgentRunnerRegistry();
      const runner = makeRunner(); // no isReady
      registry.register("no-check", runner);

      const result = await registry.getAvailable("no-check");
      expect(result).toBe(runner);
    });

    it("returns undefined for non-existent runner with no fallbacks", async () => {
      const registry = new AgentRunnerRegistry();
      const result = await registry.getAvailable("ghost");
      expect(result).toBeUndefined();
    });
  });

  // ─── Capability Matching ──────────────────────────────────────────────

  describe("findByCapabilities", () => {
    it("finds runners that support tools", () => {
      const registry = new AgentRunnerRegistry();
      registry.register("with-tools", makeRunner({ caps: { supportsTools: true } }));
      registry.register("no-tools", makeRunner({ caps: { supportsTools: false } }));
      registry.register("no-caps", makeRunner());

      const results = registry.findByCapabilities({ supportsTools: true });
      expect(results).toHaveLength(1);
      expect(results[0]).toBe(registry.get("with-tools"));
    });

    it("finds runners by tags", () => {
      const registry = new AgentRunnerRegistry();
      registry.register("coder", makeRunner({ caps: { tags: ["coding", "review"] } }));
      registry.register("searcher", makeRunner({ caps: { tags: ["search"] } }));
      registry.register("general", makeRunner({ caps: { tags: ["coding"] } }));

      const coders = registry.findByCapabilities({ tags: ["coding"] });
      expect(coders).toHaveLength(2);

      const reviewers = registry.findByCapabilities({ tags: ["review"] });
      expect(reviewers).toHaveLength(1);
    });

    it("checks maxContextTokens", () => {
      const registry = new AgentRunnerRegistry();
      registry.register("small", makeRunner({ caps: { maxContextTokens: 4096 } }));
      registry.register("large", makeRunner({ caps: { maxContextTokens: 128000 } }));

      const results = registry.findByCapabilities({ maxContextTokens: 32000 });
      expect(results).toHaveLength(1);
      expect(results[0]).toBe(registry.get("large"));
    });

    it("checks longRunning", () => {
      const registry = new AgentRunnerRegistry();
      registry.register("quick", makeRunner({ caps: { longRunning: false } }));
      registry.register("heavy", makeRunner({ caps: { longRunning: true } }));

      const results = registry.findByCapabilities({ longRunning: true });
      expect(results).toHaveLength(1);
      expect(results[0]).toBe(registry.get("heavy"));
    });

    it("returns empty for runners without caps when filtering", () => {
      const registry = new AgentRunnerRegistry();
      registry.register("bare", makeRunner()); // no caps

      const results = registry.findByCapabilities({ supportsTools: true });
      expect(results).toHaveLength(0);
    });
  });

  // ─── toMap ────────────────────────────────────────────────────────────

  describe("toMap", () => {
    it("converts to AgentRunnerMap for backward compatibility", () => {
      const registry = new AgentRunnerRegistry();
      const runner = makeRunner();
      registry.register("key", runner);

      const map = registry.toMap();
      expect(map).toBeInstanceOf(Map);
      expect(map.get("key")).toBe(runner);
    });
  });

  // ─── Extended Fallback Chain ────────────────────────────────────────────

  describe("getAvailable (extended)", () => {
    it("skips multiple unavailable runners in chain", async () => {
      const registry = new AgentRunnerRegistry();
      registry.register("a", makeRunner({ ready: { ready: false, reason: "down" } }));
      registry.register("b", makeRunner({ ready: { ready: false, reason: "busy" } }));
      registry.register("c", makeRunner({ ready: { ready: true } }));

      const result = await registry.getAvailable("a", ["b", "c"]);
      expect(result).toBe(registry.get("c"));
    });

    it("handles fallback to non-existent runner gracefully", async () => {
      const registry = new AgentRunnerRegistry();
      registry.register("a", makeRunner({ ready: { ready: false } }));

      const result = await registry.getAvailable("a", ["ghost", "also-ghost"]);
      expect(result).toBeUndefined();
    });

    it("mixed: some ready, some missing, first available wins", async () => {
      const registry = new AgentRunnerRegistry();
      registry.register("a", makeRunner({ ready: { ready: false } }));
      // "b" not registered
      registry.register("c", makeRunner({ ready: { ready: true }, name: "runner-c" }));
      registry.register("d", makeRunner({ ready: { ready: true }, name: "runner-d" }));

      const result = await registry.getAvailable("a", ["b", "c", "d"]);
      expect(result).toBe(registry.get("c"));
    });

    it("empty fallback list returns undefined when primary not ready", async () => {
      const registry = new AgentRunnerRegistry();
      registry.register("a", makeRunner({ ready: { ready: false } }));

      const result = await registry.getAvailable("a", []);
      expect(result).toBeUndefined();
    });

    it("isReady throwing error treated as not ready", async () => {
      const registry = new AgentRunnerRegistry();
      const broken: AgentRunner = {
        isReady: async () => { throw new Error("connection failed"); },
        run: async (a) => ({ flowId: a.flowId, stepId: a.stepId, output: "", toolCalls: [] }),
      };
      const good = makeRunner({ ready: { ready: true } });
      registry.register("broken", broken);
      registry.register("good", good);

      // Should skip broken and use good
      const result = await registry.getAvailable("broken", ["good"]);
      expect(result).toBe(good);
    });
  });

  // ─── Hooks ────────────────────────────────────────────────────────────

  describe("AgentRunnerHooks", () => {
    it("calls onStart and onComplete hooks", async () => {
      const calls: string[] = [];
      const runner: AgentRunner = {
        hooks: {
          onStart: () => { calls.push("start"); },
          onComplete: () => { calls.push("complete"); },
        },
        run: async (a) => ({
          flowId: a.flowId, stepId: a.stepId, output: "ok", toolCalls: [],
        }),
      };

      // Simulate hook invocation
      await runner.hooks!.onStart!({} as AgentAssignment);
      const result = await runner.run({} as AgentAssignment, {} as RunAssignmentOptions);
      await runner.hooks!.onComplete!({} as AgentAssignment, result);

      expect(calls).toEqual(["start", "complete"]);
    });

    it("calls onError hook on failure", async () => {
      let caughtError: Error | undefined;
      const runner: AgentRunner = {
        hooks: {
          onError: (_a, err) => { caughtError = err; },
        },
        run: async () => { throw new Error("boom"); },
      };

      const error = new Error("boom");
      await runner.hooks!.onError!({} as AgentAssignment, error);
      expect(caughtError?.message).toBe("boom");
    });
  });

  // ─── Fallback Chain Deep Dive ──────────────────────────────────────────

  describe("getAvailable fallback chain", () => {
    it("returns primary even when it has no isReady (always ready)", async () => {
      const registry = new AgentRunnerRegistry();
      const runner = makeRunner(); // no isReady
      registry.register("primary", runner);

      const result = await registry.getAvailable("primary");
      expect(result).toBe(runner);
    });

    it("falls back through long chain: first ready wins", async () => {
      const registry = new AgentRunnerRegistry();
      registry.register("a", makeRunner({ ready: { ready: false } }));
      registry.register("b", makeRunner({ ready: { ready: false } }));
      registry.register("c", makeRunner({ ready: { ready: true } }));
      registry.register("d", makeRunner({ ready: { ready: true } }));

      const result = await registry.getAvailable("a", ["b", "c", "d"]);
      expect(result).toBe(registry.get("c"));
    });

    it("primary with no isReady is always returned regardless of fallbacks", async () => {
      const registry = new AgentRunnerRegistry();
      registry.register("primary", makeRunner()); // no isReady
      registry.register("fallback", makeRunner({ ready: { ready: true } }));

      const result = await registry.getAvailable("primary", ["fallback"]);
      expect(result).toBe(registry.get("primary"));
    });

    it("primary isReady returns undefined when no fallbacks exist", async () => {
      const registry = new AgentRunnerRegistry();
      registry.register("a", makeRunner({ ready: { ready: false, reason: "offline" } }));

      const result = await registry.getAvailable("a");
      expect(result).toBeUndefined();
    });

    it("isReady false treated as not ready (not throwing)", async () => {
      const registry = new AgentRunnerRegistry();
      registry.register("a", makeRunner({ ready: { ready: false } }));
      registry.register("b", makeRunner({ ready: { ready: true } }));

      const result = await registry.getAvailable("a", ["b"]);
      expect(result).toBe(registry.get("b"));
    });

    it("isReady reason is ignored in getAvailable (only .ready boolean matters)", async () => {
      const registry = new AgentRunnerRegistry();
      registry.register("a", makeRunner({ ready: { ready: false, reason: "just-busy" } }));
      registry.register("b", makeRunner({ ready: { ready: true } }));

      const result = await registry.getAvailable("a", ["b"]);
      expect(result).toBe(registry.get("b"));
    });

    it("skips primary when not ready, uses first ready fallback", async () => {
      const registry = new AgentRunnerRegistry();
      registry.register("primary", makeRunner({ ready: { ready: false } }));
      registry.register("fb1", makeRunner({ ready: { ready: false } }));
      registry.register("fb2", makeRunner({ ready: { ready: true } }));

      const result = await registry.getAvailable("primary", ["fb1", "fb2"]);
      expect(result).toBe(registry.get("fb2"));
    });

    it("capability-filtered fallback: primary ready always wins regardless of capabilities", async () => {
      const registry = new AgentRunnerRegistry();
      registry.register("primary", makeRunner({
        ready: { ready: true },
        caps: { supportsTools: false },
      }));
      registry.register("fallback", makeRunner({
        ready: { ready: true },
        caps: { supportsTools: true },
      }));

      // getAvailable checks readiness, not capability.
      const result = await registry.getAvailable("primary", ["fallback"]);
      expect(result).toBe(registry.get("primary"));
    });
  });

  // ─── register edge cases ────────────────────────────────────────────────

  describe("register edge cases", () => {
    it("registering same name twice overwrites previous runner", () => {
      const registry = new AgentRunnerRegistry();
      const runner1 = makeRunner({ name: "old-runner" });
      const runner2 = makeRunner({ name: "new-runner" });
      registry.register("runner", runner1);
      registry.register("runner", runner2);

      expect(registry.get("runner")).toBe(runner2);
      expect(registry.list()).toHaveLength(1);
    });

    it("register multiple distinct runners", () => {
      const registry = new AgentRunnerRegistry();
      registry.register("a", makeRunner());
      registry.register("b", makeRunner());
      registry.register("c", makeRunner());


      expect(registry.list()).toHaveLength(3);
      expect(registry.has("a")).toBe(true);
      expect(registry.has("b")).toBe(true);
      expect(registry.has("c")).toBe(true);
    });
  });

  // ─── get / has edge cases ──────────────────────────────────────────────

  describe("get / has edge cases", () => {
    it("get returns undefined for unregistered name", () => {
      const registry = new AgentRunnerRegistry();
      expect(registry.get("ghost")).toBeUndefined();
    });

    it("has returns false for unregistered name", () => {
      const registry = new AgentRunnerRegistry();
      expect(registry.has("ghost")).toBe(false);
    });

    it("list returns empty array for fresh registry", () => {
      const registry = new AgentRunnerRegistry();
      expect(registry.list()).toEqual([]);
    });
  });

  // ─── findByCapabilities edge cases ──────────────────────────────────────

  describe("findByCapabilities edge cases", () => {
    it("empty filter returns all runners with caps", () => {
      const registry = new AgentRunnerRegistry();
      registry.register("a", makeRunner({ caps: { supportsTools: true } }));
      registry.register("b", makeRunner({ caps: { supportsTools: false } }));

      const results = registry.findByCapabilities({});
      // Empty filter matches nothing specific, but runners with caps still return
      expect(results).toHaveLength(2);
    });

    it("no matches returns empty array", () => {
      const registry = new AgentRunnerRegistry();
      registry.register("a", makeRunner({ caps: { supportsTools: false } }));
      registry.register("b", makeRunner({ caps: { supportsTools: false } }));

      const results = registry.findByCapabilities({ supportsTools: true });
      expect(results).toHaveLength(0);
    });

    it("matches multiple tags (AND logic)", () => {
      const registry = new AgentRunnerRegistry();
      registry.register("full", makeRunner({ caps: { tags: ["coding", "review", "search"] } }));
      registry.register("partial", makeRunner({ caps: { tags: ["coding"] } }));
      registry.register("other", makeRunner({ caps: { tags: ["review"] } }));

      const results = registry.findByCapabilities({ tags: ["coding", "review"] });
      expect(results).toHaveLength(1);
      expect(results[0]).toBe(registry.get("full"));
    });

    it("maxContextTokens: runner with insufficient tokens is excluded", () => {
      const registry = new AgentRunnerRegistry();
      registry.register("small", makeRunner({ caps: { maxContextTokens: 4096 } }));
      registry.register("medium", makeRunner({ caps: { maxContextTokens: 32000 } }));
      registry.register("large", makeRunner({ caps: { maxContextTokens: 128000 } }));

      const results = registry.findByCapabilities({ maxContextTokens: 64000 });
      expect(results).toHaveLength(1);
      expect(results[0]).toBe(registry.get("large"));
    });

    it("maxContextTokens: runner with no limit matches any request", () => {
      const registry = new AgentRunnerRegistry();
      registry.register("unlimited", makeRunner({ caps: { maxContextTokens: undefined } }));
      registry.register("limited", makeRunner({ caps: { maxContextTokens: 4096 } }));

      const results = registry.findByCapabilities({ maxContextTokens: 100000 });
      expect(results).toHaveLength(1);
      expect(results[0]).toBe(registry.get("unlimited"));
    });

    it("longRunning: runner without longRunning flag matches when required", () => {
      const registry = new AgentRunnerRegistry();
      registry.register("unspecified", makeRunner({ caps: {} }));
      registry.register("long-running", makeRunner({ caps: { longRunning: true } }));

      const results = registry.findByCapabilities({ longRunning: true });
      expect(results).toHaveLength(1);
      expect(results[0]).toBe(registry.get("long-running"));
    });
  });

  // ─── toMap ──────────────────────────────────────────────────────────────

  describe("toMap", () => {
    it("toMap of empty registry returns empty Map", () => {
      const registry = new AgentRunnerRegistry();
      const map = registry.toMap();
      expect(map).toBeInstanceOf(Map);
      expect(map.size).toBe(0);
    });

    it("toMap preserves all runner entries", () => {
      const registry = new AgentRunnerRegistry();
      const r1 = makeRunner();
      const r2 = makeRunner();
      registry.register("runner1", r1);
      registry.register("runner2", r2);

      const map = registry.toMap();
      expect(map.size).toBe(2);
      expect(map.get("runner1")).toBe(r1);
      expect(map.get("runner2")).toBe(r2);
    });
  });
});

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
});

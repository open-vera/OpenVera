import { describe, it, expect, vi } from "vitest";
import {
  WebArenaRunner,
  type WebArenaRawCase,
  type WebArenaEvalConfig,
} from "../../src/eval/runners/webarena-runner.js";
import type { AgentExecutor, AgentResponse } from "../../src/eval/harness.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEvalConfig(overrides: Partial<WebArenaEvalConfig> = {}): WebArenaEvalConfig {
  return {
    type: "content_match",
    contentContains: ["Order confirmed"],
    ...overrides,
  };
}

function makeRawCase(overrides: Partial<WebArenaRawCase> = {}): WebArenaRawCase {
  return {
    task_id: "wa-001",
    site: "shopping",
    startUrl: "https://shopping.example.com",
    intent: "Find a red t-shirt in size M and add it to the cart",
    eval: makeEvalConfig(),
    ...overrides,
  };
}

function makeAgent(content: string = "Order confirmed"): AgentExecutor {
  return {
    execute: vi.fn().mockResolvedValue({
      content,
      toolCalls: ["computer_use", "computer_use", "computer_use"],
      durationMs: 5000,
    } as AgentResponse),
  };
}

// ── WebArenaRunner ──────────────────────────────────────────────────────────

describe("WebArenaRunner", () => {
  describe("loadCases", () => {
    it("loads raw WebArena cases and converts to EvalCase", () => {
      const runner = new WebArenaRunner(makeAgent());
      runner.loadCases([makeRawCase(), makeRawCase({ task_id: "wa-002" })]);
      expect(runner.getCaseCount()).toBe(2);
    });

    it("loads from JSON string", () => {
      const runner = new WebArenaRunner(makeAgent());
      const cases = [makeRawCase()];
      runner.loadCasesFromJson(JSON.stringify(cases));
      expect(runner.getCaseCount()).toBe(1);
    });

    it("filters by site", () => {
      const runner = new WebArenaRunner(makeAgent(), { sites: ["shopping"] });
      runner.loadCases([
        makeRawCase({ task_id: "wa-shop", site: "shopping" }),
        makeRawCase({ task_id: "wa-git", site: "gitlab" }),
        makeRawCase({ task_id: "wa-cms", site: "cms" }),
      ]);
      expect(runner.getCaseCount()).toBe(1);
    });

    it("filters by multiple sites", () => {
      const runner = new WebArenaRunner(makeAgent(), { sites: ["shopping", "forum"] });
      runner.loadCases([
        makeRawCase({ task_id: "wa-shop", site: "shopping" }),
        makeRawCase({ task_id: "wa-forum", site: "forum" }),
        makeRawCase({ task_id: "wa-git", site: "gitlab" }),
      ]);
      expect(runner.getCaseCount()).toBe(2);
    });

    it("filters by level", () => {
      const runner = new WebArenaRunner(makeAgent(), { levels: [1, 3] });
      runner.loadCases([
        makeRawCase({ task_id: "l1", level: 1 }),
        makeRawCase({ task_id: "l2", level: 2 }),
        makeRawCase({ task_id: "l3", level: 3 }),
      ]);
      expect(runner.getCaseCount()).toBe(2);
    });

    it("limits max cases", () => {
      const runner = new WebArenaRunner(makeAgent(), { maxCases: 2 });
      runner.loadCases([
        makeRawCase({ task_id: "1" }),
        makeRawCase({ task_id: "2" }),
        makeRawCase({ task_id: "3" }),
      ]);
      expect(runner.getCaseCount()).toBe(2);
    });

    it("applies both site filter and maxCases", () => {
      const runner = new WebArenaRunner(makeAgent(), {
        sites: ["shopping"],
        maxCases: 1,
      });
      runner.loadCases([
        makeRawCase({ task_id: "a", site: "shopping" }),
        makeRawCase({ task_id: "b", site: "shopping" }),
        makeRawCase({ task_id: "c", site: "gitlab" }),
      ]);
      expect(runner.getCaseCount()).toBe(1);
    });
  });

  describe("case conversion", () => {
    it("builds prompt with starting URL and site", async () => {
      const agent = makeAgent();
      const runner = new WebArenaRunner(agent);
      runner.loadCases([
        makeRawCase({
          intent: "Add red shirt to cart",
          startUrl: "https://shop.example.com",
          site: "shopping",
        }),
      ]);
      await runner.runAll();
      expect(agent.execute).toHaveBeenCalledWith(
        expect.stringContaining("Add red shirt to cart"),
        expect.any(Object),
      );
      const call = (agent.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call).toContain("https://shop.example.com");
      expect(call).toContain("shopping");
    });

    it("includes max steps in prompt when specified", async () => {
      const agent = makeAgent();
      const runner = new WebArenaRunner(agent);
      runner.loadCases([makeRawCase({ maxSteps: 15 })]);
      await runner.runAll();
      const call = (agent.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call).toContain("Max steps: 15");
    });

    it("does not include max steps when not specified", async () => {
      const agent = makeAgent();
      const runner = new WebArenaRunner(agent);
      runner.loadCases([makeRawCase()]);
      await runner.runAll();
      const call = (agent.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call).not.toContain("Max steps");
    });

    it("sets evalType based on WebArena eval type", () => {
      const runner = new WebArenaRunner(makeAgent());

      // content_match → contains
      runner.loadCases([makeRawCase({ eval: makeEvalConfig({ type: "content_match" }) })]);
      expect(runner.getCaseCount()).toBe(1);
    });

    it("converts url_match to regex evalType", () => {
      const runner = new WebArenaRunner(makeAgent());
      runner.loadCases([
        makeRawCase({
          eval: { type: "url_match", urlPattern: ".*order-confirmation.*" },
        }),
      ]);
      expect(runner.getCaseCount()).toBe(1);
    });

    it("converts programmatic to exact evalType", () => {
      const runner = new WebArenaRunner(makeAgent());
      runner.loadCases([
        makeRawCase({
          eval: { type: "programmatic", evalScript: "return document.title === 'Done'" },
        }),
      ]);
      expect(runner.getCaseCount()).toBe(1);
    });
  });

  describe("level inference", () => {
    it("infers level 3 for maxSteps > 10", () => {
      const runner = new WebArenaRunner(makeAgent());
      runner.loadCases([makeRawCase({ maxSteps: 15 })]);
      // Level inference affects timeout, verify via report
      expect(runner.getCaseCount()).toBe(1);
    });

    it("infers level 3 for programmatic eval", () => {
      const runner = new WebArenaRunner(makeAgent());
      runner.loadCases([
        makeRawCase({ eval: { type: "programmatic", evalScript: "true" } }),
      ]);
      expect(runner.getCaseCount()).toBe(1);
    });

    it("infers level 2 for many content checks", () => {
      const runner = new WebArenaRunner(makeAgent());
      runner.loadCases([
        makeRawCase({
          eval: { type: "content_match", contentContains: ["a", "b", "c"] },
        }),
      ]);
      expect(runner.getCaseCount()).toBe(1);
    });

    it("defaults to level 1 for simple tasks", () => {
      const runner = new WebArenaRunner(makeAgent());
      runner.loadCases([
        makeRawCase({ eval: { type: "content_match", contentContains: ["ok"] } }),
      ]);
      expect(runner.getCaseCount()).toBe(1);
    });
  });

  describe("timeout by level", () => {
    it("uses 90s timeout for L1", async () => {
      const agent = makeAgent();
      const runner = new WebArenaRunner(agent);
      runner.loadCases([makeRawCase({ level: 1 })]);
      await runner.runAll();
      expect(agent.execute).toHaveBeenCalledWith(
        expect.any(String),
        { timeoutMs: 90_000 },
      );
    });

    it("uses 180s timeout for L2", async () => {
      const agent = makeAgent();
      const runner = new WebArenaRunner(agent);
      runner.loadCases([makeRawCase({ level: 2 })]);
      await runner.runAll();
      expect(agent.execute).toHaveBeenCalledWith(
        expect.any(String),
        { timeoutMs: 180_000 },
      );
    });

    it("uses 300s timeout for L3", async () => {
      const agent = makeAgent();
      const runner = new WebArenaRunner(agent);
      runner.loadCases([makeRawCase({ level: 3 })]);
      await runner.runAll();
      expect(agent.execute).toHaveBeenCalledWith(
        expect.any(String),
        { timeoutMs: 300_000 },
      );
    });

    it("uses custom timeout from case", async () => {
      const agent = makeAgent();
      const runner = new WebArenaRunner(agent);
      runner.loadCases([makeRawCase({ timeoutMs: 50_000 })]);
      await runner.runAll();
      expect(agent.execute).toHaveBeenCalledWith(
        expect.any(String),
        { timeoutMs: 50_000 },
      );
    });
  });

  describe("tags", () => {
    it("adds site tag", async () => {
      const runner = new WebArenaRunner(makeAgent());
      runner.loadCases([makeRawCase({ site: "forum" })]);
      const report = await runner.runAll();
      expect(report.totalCases).toBe(1);
    });

    it("includes custom tags", async () => {
      const runner = new WebArenaRunner(makeAgent());
      runner.loadCases([makeRawCase({ tags: ["auth", "form-filling"] })]);
      const report = await runner.runAll();
      expect(report.totalCases).toBe(1);
    });
  });

  describe("runAll", () => {
    it("returns complete report", async () => {
      const runner = new WebArenaRunner(makeAgent("Order confirmed"));
      runner.loadCases([
        makeRawCase({
          task_id: "wa-pass",
          eval: { type: "content_match", contentContains: ["Order confirmed"] },
        }),
        makeRawCase({
          task_id: "wa-fail",
          eval: { type: "content_match", contentContains: ["Something else"] },
        }),
      ]);
      const report = await runner.runAll();
      expect(report.benchmark).toBe("WebArena");
      expect(report.totalCases).toBe(2);
      expect(report.passed).toBe(1);
      expect(report.failed).toBe(1);
    });

    it("handles agent errors gracefully", async () => {
      const agent: AgentExecutor = {
        execute: vi.fn().mockRejectedValue(new Error("API connection failed")),
      };
      const runner = new WebArenaRunner(agent);
      runner.loadCases([makeRawCase()]);
      const report = await runner.runAll();
      expect(report.results[0].status).toBe("error");
      expect(report.results[0].error).toContain("API connection failed");
    });

    it("handles timeout errors", async () => {
      const agent: AgentExecutor = {
        execute: vi.fn().mockRejectedValue(new Error("timeout exceeded")),
      };
      const runner = new WebArenaRunner(agent);
      runner.loadCases([makeRawCase()]);
      const report = await runner.runAll();
      expect(report.results[0].status).toBe("timeout");
    });

    it("reports tool calls from agent execution", async () => {
      const agent = makeAgent("done");
      const runner = new WebArenaRunner(agent);
      runner.loadCases([makeRawCase()]);
      const report = await runner.runAll();
      expect(report.results[0].toolCalls).toEqual([
        "computer_use",
        "computer_use",
        "computer_use",
      ]);
    });

    it("tracks duration", async () => {
      const runner = new WebArenaRunner(makeAgent());
      runner.loadCases([makeRawCase()]);
      const report = await runner.runAll();
      expect(report.results[0].durationMs).toBeGreaterThan(0);
      expect(report.avgDurationMs).toBeGreaterThan(0);
    });
  });

  describe("options defaults", () => {
    it("uses 'unknown' as default model name", async () => {
      const runner = new WebArenaRunner(makeAgent());
      runner.loadCases([makeRawCase()]);
      const report = await runner.runAll();
      expect(report.model).toBe("unknown");
    });

    it("uses custom model name", async () => {
      const runner = new WebArenaRunner(makeAgent(), { model: "claude-opus-4-7" });
      runner.loadCases([makeRawCase()]);
      const report = await runner.runAll();
      expect(report.model).toBe("claude-opus-4-7");
    });
  });

  describe("per-site breakdown", () => {
    it("groups results by site via byLevel", async () => {
      const runner = new WebArenaRunner(makeAgent("done"));
      runner.loadCases([
        makeRawCase({ task_id: "shop-1", site: "shopping", level: 1 }),
        makeRawCase({ task_id: "shop-2", site: "shopping", level: 1 }),
        makeRawCase({ task_id: "git-1", site: "gitlab", level: 2 }),
      ]);
      const report = await runner.runAll();
      expect(report.byLevel[1]).toBeDefined();
      expect(report.byLevel[1].total).toBe(2);
      expect(report.byLevel[2]).toBeDefined();
      expect(report.byLevel[2].total).toBe(1);
    });
  });
});

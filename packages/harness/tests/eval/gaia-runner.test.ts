import { describe, it, expect, vi } from "vitest";
import { GaiaRunner, type GaiaRawCase } from "../../src/eval/runners/gaia-runner.js";
import type { AgentExecutor, AgentResponse } from "../../src/eval/harness.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRawCase(overrides: Partial<GaiaRawCase> = {}): GaiaRawCase {
  return {
    task_id: "gaia-001",
    question: "What is the capital of France?",
    level: 1,
    final_answer: "Paris",
    ...overrides,
  };
}

function makeAgent(content: string = "Paris"): AgentExecutor {
  return {
    execute: vi.fn().mockResolvedValue({
      content,
      toolCalls: [],
      durationMs: 100,
    } as AgentResponse),
  };
}

// ── GaiaRunner ──────────────────────────────────────────────────────────────

describe("GaiaRunner", () => {
  describe("loadCases", () => {
    it("loads raw GAIA cases and converts to EvalCase", () => {
      const runner = new GaiaRunner(makeAgent());
      runner.loadCases([makeRawCase(), makeRawCase({ task_id: "gaia-002" })]);
      expect(runner.getCaseCount()).toBe(2);
    });

    it("loads from JSON string", () => {
      const runner = new GaiaRunner(makeAgent());
      const cases = [makeRawCase()];
      runner.loadCasesFromJson(JSON.stringify(cases));
      expect(runner.getCaseCount()).toBe(1);
    });

    it("filters by level", () => {
      const runner = new GaiaRunner(makeAgent(), { levels: [1, 3] });
      runner.loadCases([
        makeRawCase({ task_id: "l1", level: 1 }),
        makeRawCase({ task_id: "l2", level: 2 }),
        makeRawCase({ task_id: "l3", level: 3 }),
      ]);
      expect(runner.getCaseCount()).toBe(2);
    });

    it("limits max cases", () => {
      const runner = new GaiaRunner(makeAgent(), { maxCases: 2 });
      runner.loadCases([
        makeRawCase({ task_id: "1" }),
        makeRawCase({ task_id: "2" }),
        makeRawCase({ task_id: "3" }),
      ]);
      expect(runner.getCaseCount()).toBe(2);
    });

    it("applies both level filter and maxCases", () => {
      const runner = new GaiaRunner(makeAgent(), { levels: [1], maxCases: 1 });
      runner.loadCases([
        makeRawCase({ task_id: "a", level: 1 }),
        makeRawCase({ task_id: "b", level: 1 }),
        makeRawCase({ task_id: "c", level: 2 }),
      ]);
      expect(runner.getCaseCount()).toBe(1);
    });
  });

  describe("case conversion", () => {
    it("sets evalType to contains", () => {
      const runner = new GaiaRunner(makeAgent());
      runner.loadCases([makeRawCase()]);
      // We verify by running — contains match should pass
      return runner.runAll().then((report) => {
        expect(report.results[0].status).toBe("pass");
      });
    });

    it("builds prompt with file attachment note", async () => {
      const agent = makeAgent();
      const runner = new GaiaRunner(agent);
      runner.loadCases([makeRawCase({ file_name: "data.csv" })]);
      await runner.runAll();
      expect(agent.execute).toHaveBeenCalledWith(
        expect.stringContaining("[Attached file: data.csv]"),
        expect.any(Object),
      );
    });

    it("builds prompt without file note when no file", async () => {
      const agent = makeAgent();
      const runner = new GaiaRunner(agent);
      runner.loadCases([makeRawCase()]);
      await runner.runAll();
      expect(agent.execute).toHaveBeenCalledWith(
        "What is the capital of France?",
        expect.any(Object),
      );
    });

    it("adds level tag", async () => {
      const agent = makeAgent();
      const runner = new GaiaRunner(agent);
      runner.loadCases([makeRawCase({ level: 2 })]);
      // The tags are internal to EvalCase, but we can verify via the report structure
      const report = await runner.runAll();
      expect(report.byLevel[2]).toBeDefined();
    });

    it("adds has-file tag when file_name present", async () => {
      const agent = makeAgent();
      const runner = new GaiaRunner(agent);
      runner.loadCases([makeRawCase({ file_name: "test.pdf" })]);
      // Verify the case runs successfully — tags are internal
      const report = await runner.runAll();
      expect(report.totalCases).toBe(1);
    });
  });

  describe("timeout by level", () => {
    it("uses 60s timeout for L1", async () => {
      const agent = makeAgent();
      const runner = new GaiaRunner(agent);
      runner.loadCases([makeRawCase({ level: 1 })]);
      await runner.runAll();
      // Verify agent.execute was called with timeout 60000
      expect(agent.execute).toHaveBeenCalledWith(
        expect.any(String),
        { timeoutMs: 60_000 },
      );
    });

    it("uses 120s timeout for L2", async () => {
      const agent = makeAgent();
      const runner = new GaiaRunner(agent);
      runner.loadCases([makeRawCase({ level: 2 })]);
      await runner.runAll();
      expect(agent.execute).toHaveBeenCalledWith(
        expect.any(String),
        { timeoutMs: 120_000 },
      );
    });

    it("uses 300s timeout for L3", async () => {
      const agent = makeAgent();
      const runner = new GaiaRunner(agent);
      runner.loadCases([makeRawCase({ level: 3 })]);
      await runner.runAll();
      expect(agent.execute).toHaveBeenCalledWith(
        expect.any(String),
        { timeoutMs: 300_000 },
      );
    });
  });

  describe("runAll", () => {
    it("returns complete report", async () => {
      const runner = new GaiaRunner(makeAgent("Paris"));
      runner.loadCases([
        makeRawCase({ task_id: "g1", final_answer: "Paris" }),
        makeRawCase({ task_id: "g2", final_answer: "Berlin" }),
      ]);
      const report = await runner.runAll();
      expect(report.benchmark).toBe("GAIA");
      expect(report.totalCases).toBe(2);
      expect(report.passed).toBe(1);
      expect(report.failed).toBe(1);
    });

    it("handles agent errors gracefully", async () => {
      const agent: AgentExecutor = {
        execute: vi.fn().mockRejectedValue(new Error("API error")),
      };
      const runner = new GaiaRunner(agent);
      runner.loadCases([makeRawCase()]);
      const report = await runner.runAll();
      expect(report.results[0].status).toBe("error");
    });
  });

  describe("options defaults", () => {
    it("uses 'unknown' as default model name", async () => {
      const runner = new GaiaRunner(makeAgent());
      runner.loadCases([makeRawCase()]);
      const report = await runner.runAll();
      expect(report.model).toBe("unknown");
    });

    it("uses custom model name", async () => {
      const runner = new GaiaRunner(makeAgent(), { model: "gpt-4" });
      runner.loadCases([makeRawCase()]);
      const report = await runner.runAll();
      expect(report.model).toBe("gpt-4");
    });
  });
});

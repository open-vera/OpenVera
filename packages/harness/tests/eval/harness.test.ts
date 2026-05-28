import { describe, it, expect, vi } from "vitest";
import { EvalHarness, type EvalCase, type AgentExecutor, type AgentResponse } from "../../src/eval/harness.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "test-1",
    description: "test case",
    level: 1,
    prompt: "What is 2+2?",
    expected: "4",
    evalType: "exact",
    ...overrides,
  };
}

function makeResponse(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    content: "4",
    toolCalls: [],
    durationMs: 100,
    ...overrides,
  };
}

function makeAgent(response: AgentResponse): AgentExecutor {
  return {
    execute: vi.fn().mockResolvedValue(response),
  };
}

// ── EvalHarness ─────────────────────────────────────────────────────────────

describe("EvalHarness", () => {
  describe("loadCases", () => {
    it("loads cases from array", () => {
      const harness = new EvalHarness(makeAgent(makeResponse()), { name: "test" });
      harness.loadCases([makeCase(), makeCase({ id: "test-2" })]);
      expect(harness.getCaseCount()).toBe(2);
    });

    it("loads cases from JSON string", () => {
      const harness = new EvalHarness(makeAgent(makeResponse()), { name: "test" });
      const cases = [makeCase(), makeCase({ id: "test-2" })];
      harness.loadCasesFromJson(JSON.stringify(cases));
      expect(harness.getCaseCount()).toBe(2);
    });

    it("replaces existing cases on reload", () => {
      const harness = new EvalHarness(makeAgent(makeResponse()), { name: "test" });
      harness.loadCases([makeCase()]);
      harness.loadCases([makeCase({ id: "a" }), makeCase({ id: "b" })]);
      expect(harness.getCaseCount()).toBe(2);
    });
  });

  describe("evalExact", () => {
    it("passes when exact match (case-insensitive, trimmed)", async () => {
      const harness = new EvalHarness(makeAgent(makeResponse({ content: "  4  " })), { name: "test" });
      harness.loadCases([makeCase({ evalType: "exact", expected: "4" })]);
      const report = await harness.runAll();
      expect(report.results[0].status).toBe("pass");
      expect(report.results[0].score).toBe(1);
    });

    it("fails when not matching", async () => {
      const harness = new EvalHarness(makeAgent(makeResponse({ content: "5" })), { name: "test" });
      harness.loadCases([makeCase({ evalType: "exact" })]);
      const report = await harness.runAll();
      expect(report.results[0].status).toBe("fail");
      expect(report.results[0].score).toBe(0);
    });
  });

  describe("evalContains", () => {
    it("passes when response contains expected", async () => {
      const harness = new EvalHarness(makeAgent(makeResponse({ content: "The answer is 4." })), { name: "test" });
      harness.loadCases([makeCase({ evalType: "contains", expected: "4" })]);
      const report = await harness.runAll();
      expect(report.results[0].status).toBe("pass");
    });

    it("fails when response does not contain expected", async () => {
      const harness = new EvalHarness(makeAgent(makeResponse({ content: "The answer is 5." })), { name: "test" });
      harness.loadCases([makeCase({ evalType: "contains", expected: "4" })]);
      const report = await harness.runAll();
      expect(report.results[0].status).toBe("fail");
    });
  });

  describe("evalRegex", () => {
    it("passes when regex matches", async () => {
      const harness = new EvalHarness(makeAgent(makeResponse({ content: "Result: 42 items" })), { name: "test" });
      harness.loadCases([makeCase({ evalType: "regex", expected: "\\d+ items" })]);
      const report = await harness.runAll();
      expect(report.results[0].status).toBe("pass");
    });

    it("fails when regex does not match", async () => {
      const harness = new EvalHarness(makeAgent(makeResponse({ content: "no numbers here" })), { name: "test" });
      harness.loadCases([makeCase({ evalType: "regex", expected: "\\d+" })]);
      const report = await harness.runAll();
      expect(report.results[0].status).toBe("fail");
    });

    it("returns 0 for invalid regex", async () => {
      const harness = new EvalHarness(makeAgent(makeResponse({ content: "test" })), { name: "test" });
      harness.loadCases([makeCase({ evalType: "regex", expected: "[invalid" })]);
      const report = await harness.runAll();
      expect(report.results[0].score).toBe(0);
    });
  });

  describe("evalToolMatch", () => {
    it("passes when all expected tools are called", async () => {
      const harness = new EvalHarness(
        makeAgent(makeResponse({ toolCalls: ["read", "write", "bash"] })),
        { name: "test" },
      );
      harness.loadCases([makeCase({ evalType: "tool_match", expectedTools: ["read", "write"] })]);
      const report = await harness.runAll();
      expect(report.results[0].score).toBe(1);
    });

    it("partial score when some tools missing", async () => {
      const harness = new EvalHarness(
        makeAgent(makeResponse({ toolCalls: ["read"] })),
        { name: "test" },
      );
      harness.loadCases([makeCase({ evalType: "tool_match", expectedTools: ["read", "write"] })]);
      const report = await harness.runAll();
      expect(report.results[0].score).toBe(0.5);
    });

    it("returns 1 when no expected tools specified", async () => {
      const harness = new EvalHarness(
        makeAgent(makeResponse({ toolCalls: ["read"] })),
        { name: "test" },
      );
      harness.loadCases([makeCase({ evalType: "tool_match", expectedTools: [] })]);
      const report = await harness.runAll();
      expect(report.results[0].score).toBe(1);
    });
  });

  describe("evalLlmJudge", () => {
    it("returns 0.5 placeholder for llm_judge", async () => {
      const harness = new EvalHarness(makeAgent(makeResponse()), { name: "test" });
      harness.loadCases([makeCase({ evalType: "llm_judge" })]);
      const report = await harness.runAll();
      expect(report.results[0].score).toBe(0.5);
    });
  });

  describe("error handling", () => {
    it("returns error status when agent throws", async () => {
      const agent: AgentExecutor = {
        execute: vi.fn().mockRejectedValue(new Error("API failure")),
      };
      const harness = new EvalHarness(agent, { name: "test" });
      harness.loadCases([makeCase()]);
      const report = await harness.runAll();
      expect(report.results[0].status).toBe("error");
      expect(report.results[0].error).toBe("API failure");
      expect(report.results[0].score).toBe(0);
    });

    it("returns timeout status when error message contains timeout", async () => {
      const agent: AgentExecutor = {
        execute: vi.fn().mockRejectedValue(new Error("Request timeout after 60s")),
      };
      const harness = new EvalHarness(agent, { name: "test" });
      harness.loadCases([makeCase()]);
      const report = await harness.runAll();
      expect(report.results[0].status).toBe("timeout");
    });

    it("handles non-Error thrown values", async () => {
      const agent: AgentExecutor = {
        execute: vi.fn().mockRejectedValue("string error"),
      };
      const harness = new EvalHarness(agent, { name: "test" });
      harness.loadCases([makeCase()]);
      const report = await harness.runAll();
      expect(report.results[0].status).toBe("error");
      expect(report.results[0].error).toBe("string error");
    });
  });

  describe("report generation", () => {
    it("computes correct summary stats", async () => {
      const cases = [
        makeCase({ id: "c1", level: 1, evalType: "exact", expected: "4" }),
        makeCase({ id: "c2", level: 1, evalType: "exact", expected: "4" }),
        makeCase({ id: "c3", level: 2, evalType: "exact", expected: "4" }),
      ];
      let callCount = 0;
      const responses = [
        makeResponse({ content: "4", costUsd: 0.01 }),
        makeResponse({ content: "5", costUsd: 0.02 }),
        makeResponse({ content: "4", costUsd: 0.03 }),
      ];
      const agent: AgentExecutor = {
        execute: vi.fn().mockImplementation(() => Promise.resolve(responses[callCount++])),
      };
      const harness = new EvalHarness(agent, { name: "bench", model: "test-model" });
      harness.loadCases(cases);
      const report = await harness.runAll();

      expect(report.benchmark).toBe("bench");
      expect(report.model).toBe("test-model");
      expect(report.totalCases).toBe(3);
      expect(report.passed).toBe(2);
      expect(report.failed).toBe(1);
      expect(report.errors).toBe(0);
      expect(report.skipped).toBe(0);
      expect(report.passRate).toBeCloseTo(2 / 3);
      expect(report.totalCostUsd).toBeCloseTo(0.06);
      expect(report.byLevel[1].total).toBe(2);
      expect(report.byLevel[1].passed).toBe(1);
      expect(report.byLevel[2].total).toBe(1);
      expect(report.byLevel[2].passed).toBe(1);
    });

    it("handles empty case list", async () => {
      const harness = new EvalHarness(makeAgent(makeResponse()), { name: "test" });
      harness.loadCases([]);
      const report = await harness.runAll();
      expect(report.totalCases).toBe(0);
      expect(report.passRate).toBe(0);
      expect(report.avgScore).toBe(0);
      expect(report.avgDurationMs).toBe(0);
    });
  });

  describe("score threshold", () => {
    it("passes with score >= 0.8", async () => {
      // tool_match with 4/5 = 0.8 should pass
      const harness = new EvalHarness(
        makeAgent(makeResponse({ toolCalls: ["a", "b", "c", "d"] })),
        { name: "test" },
      );
      harness.loadCases([makeCase({
        evalType: "tool_match",
        expectedTools: ["a", "b", "c", "d", "e"],
      })]);
      const report = await harness.runAll();
      expect(report.results[0].score).toBe(0.8);
      expect(report.results[0].status).toBe("pass");
    });

    it("fails with score < 0.8", async () => {
      // tool_match with 3/5 = 0.6 should fail
      const harness = new EvalHarness(
        makeAgent(makeResponse({ toolCalls: ["a", "b", "c"] })),
        { name: "test" },
      );
      harness.loadCases([makeCase({
        evalType: "tool_match",
        expectedTools: ["a", "b", "c", "d", "e"],
      })]);
      const report = await harness.runAll();
      expect(report.results[0].score).toBe(0.6);
      expect(report.results[0].status).toBe("fail");
    });
  });

  describe("default options", () => {
    it("uses default timeout of 60s", () => {
      const harness = new EvalHarness(makeAgent(makeResponse()), { name: "test" });
      // Just verify it doesn't throw with minimal options
      expect(harness.getCaseCount()).toBe(0);
    });
  });
});

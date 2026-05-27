/**
 * Tests for EvalHarness and EvalReporter — agent evaluation framework.
 */
import { describe, it, expect } from "vitest";
import { EvalHarness } from "../harness.js";
import { EvalReporter } from "../reporter.js";
import type { EvalCase, AgentExecutor, AgentResponse, EvalReport } from "../harness.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Mock Agent ───────────────────────────────────────────────────────────────

function createMockAgent(responses: Map<string, AgentResponse>): AgentExecutor {
  return {
    async execute(prompt: string): Promise<AgentResponse> {
      // Find matching response by checking if prompt contains key
      for (const [key, response] of responses) {
        if (prompt.toLowerCase().includes(key.toLowerCase())) {
          return response;
        }
      }
      return {
        content: "I don't know",
        toolCalls: [],
        durationMs: 100,
      };
    },
  };
}

function okResponse(content: string, tools: string[] = []): AgentResponse {
  return { content, toolCalls: tools, durationMs: 100, costUsd: 0.001 };
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("EvalHarness", () => {
  const testCases: EvalCase[] = [
    {
      id: "test-1",
      description: "Simple contains check",
      level: 1,
      prompt: "What is TypeScript?",
      expected: "JavaScript",
      evalType: "contains",
    },
    {
      id: "test-2",
      description: "Tool match check",
      level: 1,
      prompt: "Read package.json",
      evalType: "tool_match",
      expectedTools: ["read_file"],
    },
    {
      id: "test-3",
      description: "Exact match check",
      level: 2,
      prompt: "What is 2+2?",
      expected: "4",
      evalType: "exact",
    },
    {
      id: "test-4",
      description: "Regex match check",
      level: 2,
      prompt: "What is today's date?",
      expected: "\\d{4}-\\d{2}-\\d{2}",
      evalType: "regex",
    },
  ];

  it("should load cases", () => {
    const agent = createMockAgent(new Map());
    const harness = new EvalHarness(agent, { name: "test" });
    harness.loadCases(testCases);
    expect(harness.getCaseCount()).toBe(4);
  });

  it("should load cases from JSON", () => {
    const agent = createMockAgent(new Map());
    const harness = new EvalHarness(agent, { name: "test" });
    harness.loadCasesFromJson(JSON.stringify(testCases));
    expect(harness.getCaseCount()).toBe(4);
  });

  it("should evaluate contains correctly", async () => {
    const responses = new Map([
      ["typescript", okResponse("TypeScript is a typed superset of JavaScript")],
    ]);
    const agent = createMockAgent(responses);
    const harness = new EvalHarness(agent, { name: "test" });
    harness.loadCases([testCases[0]]);

    const report = await harness.runAll();
    expect(report.results[0].status).toBe("pass");
    expect(report.results[0].score).toBe(1);
  });

  it("should evaluate tool_match correctly", async () => {
    const responses = new Map([
      ["package.json", okResponse("File contents", ["read_file"])],
    ]);
    const agent = createMockAgent(responses);
    const harness = new EvalHarness(agent, { name: "test" });
    harness.loadCases([testCases[1]]);

    const report = await harness.runAll();
    expect(report.results[0].status).toBe("pass");
  });

  it("should evaluate exact match correctly", async () => {
    const responses = new Map([
      ["2+2", okResponse("4")],
    ]);
    const agent = createMockAgent(responses);
    const harness = new EvalHarness(agent, { name: "test" });
    harness.loadCases([testCases[2]]);

    const report = await harness.runAll();
    expect(report.results[0].status).toBe("pass");
  });

  it("should evaluate regex correctly", async () => {
    const responses = new Map([
      ["date", okResponse("Today is 2026-05-27")],
    ]);
    const agent = createMockAgent(responses);
    const harness = new EvalHarness(agent, { name: "test" });
    harness.loadCases([testCases[3]]);

    const report = await harness.runAll();
    expect(report.results[0].status).toBe("pass");
  });

  it("should handle agent errors gracefully", async () => {
    const agent: AgentExecutor = {
      async execute() {
        throw new Error("Agent crashed");
      },
    };
    const harness = new EvalHarness(agent, { name: "test" });
    harness.loadCases([testCases[0]]);

    const report = await harness.runAll();
    expect(report.results[0].status).toBe("error");
    expect(report.results[0].error).toContain("Agent crashed");
  });

  it("should generate correct report statistics", async () => {
    const responses = new Map([
      ["typescript", okResponse("TypeScript is JavaScript with types")],
      ["package", okResponse("Contents", ["read_file"])],
    ]);
    const agent = createMockAgent(responses);
    const harness = new EvalHarness(agent, { name: "test", model: "test-model" });
    harness.loadCases(testCases.slice(0, 2));

    const report = await harness.runAll();
    expect(report.totalCases).toBe(2);
    expect(report.passed).toBe(2);
    expect(report.passRate).toBe(1);
    expect(report.benchmark).toBe("test");
    expect(report.model).toBe("test-model");
  });

  it("should calculate by-level statistics", async () => {
    const responses = new Map([
      ["typescript", okResponse("JavaScript")],
      ["2+2", okResponse("5")], // wrong answer
    ]);
    const agent = createMockAgent(responses);
    const harness = new EvalHarness(agent, { name: "test" });
    harness.loadCases([testCases[0], testCases[2]]); // L1 and L2

    const report = await harness.runAll();
    expect(report.byLevel[1]).toBeDefined();
    expect(report.byLevel[2]).toBeDefined();
    expect(report.byLevel[1].passed).toBe(1);
    expect(report.byLevel[2].passed).toBe(0);
  });
});

describe("EvalReporter", () => {
  const mockReport: EvalReport = {
    benchmark: "test-benchmark",
    model: "test-model",
    timestamp: "2026-05-27T10:00:00Z",
    totalCases: 3,
    passed: 2,
    failed: 1,
    errors: 0,
    skipped: 0,
    passRate: 2 / 3,
    avgScore: 0.8,
    avgDurationMs: 150,
    totalCostUsd: 0.003,
    byLevel: {
      1: { total: 2, passed: 2, passRate: 1 },
      2: { total: 1, passed: 0, passRate: 0 },
    },
    results: [
      { caseId: "t1", status: "pass", score: 1, durationMs: 100, response: "ok", toolCalls: ["read_file"] },
      { caseId: "t2", status: "pass", score: 1, durationMs: 200, response: "ok", toolCalls: ["bash"] },
      { caseId: "t3", status: "fail", score: 0.4, durationMs: 150, response: "wrong", toolCalls: [] },
    ],
  };

  it("should generate markdown report", () => {
    const md = EvalReporter.toMarkdown(mockReport);
    expect(md).toContain("Eval Report");
    expect(md).toContain("test-benchmark");
    expect(md).toContain("66.7%");
    expect(md).toContain("t3");
  });

  it("should generate comparison report", () => {
    const improved: EvalReport = {
      ...mockReport,
      passed: 3,
      passRate: 1,
      results: mockReport.results.map((r) => ({ ...r, status: "pass" as const, score: 1 })),
    };

    const md = EvalReporter.compareMarkdown(mockReport, improved);
    expect(md).toContain("Comparison");
    expect(md).toContain("Improvements");
  });
});

describe("Vera Custom Cases", () => {
  it("should load vera-custom.json", () => {
    const casesPath = join(__dirname, "..", "cases", "vera-custom.json");
    const content = readFileSync(casesPath, "utf-8");
    const cases = JSON.parse(content) as EvalCase[];

    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(cases.every((c) => c.id && c.description && c.prompt)).toBe(true);

    // Check level distribution
    const l1 = cases.filter((c) => c.level === 1).length;
    const l2 = cases.filter((c) => c.level === 2).length;
    const l3 = cases.filter((c) => c.level === 3).length;
    expect(l1).toBeGreaterThan(0);
    expect(l2).toBeGreaterThan(0);
    expect(l3).toBeGreaterThan(0);
  });
});

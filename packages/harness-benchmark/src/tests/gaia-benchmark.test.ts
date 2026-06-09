/**
 * Tests for GAIA Benchmark Runner (B3).
 * Covers: GaiaBenchmarkRunner — GAIA case loading, level filtering,
 * per-level timeouts, BenchmarkHarness integration.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { GaiaBenchmarkRunner } from "../gaia-benchmark-runner.js";
import type { GaiaBenchmarkRawCase } from "../gaia-benchmark-runner.js";
import type { AgentExecutor, AgentResponse } from "@open-vera/harness-eval";

// ── Helpers ──────────────────────────────────────────────────────────────────

function okResponse(content: string): AgentResponse {
  return { content, toolCalls: [], durationMs: 100, costUsd: 0.001 };
}

function mockAgent(answerMap: Map<string, string>): AgentExecutor {
  return {
    async execute(prompt: string): Promise<AgentResponse> {
      for (const [key, answer] of answerMap) {
        if (prompt.toLowerCase().includes(key.toLowerCase())) {
          return okResponse(answer);
        }
      }
      return okResponse("no match");
    },
  };
}

/** Resolve fixture path — works from both src/ and dist/ */
function fixturePath(name: string): string {
  // Try relative to current file (src layout: tests/ → ../cases/)
  const fromHere = resolve(import.meta.dirname ?? ".", "../cases", name);
  if (existsSync(fromHere)) return fromHere;
  // Fallback: from dist/benchmark/tests → ../../src/benchmark/cases
  const fromRoot = resolve(import.meta.dirname ?? ".", "../../../src/benchmark/cases", name);
  return fromRoot;
}

const sampleGaiaCases: GaiaBenchmarkRawCase[] = [
  { task_id: "g1", question: "What is the capital of France?", level: 1, final_answer: "Paris" },
  { task_id: "g2", question: "What is 2+2?", level: 1, final_answer: "4" },
  { task_id: "g3", question: "Explain quantum computing.", level: 2, final_answer: "qubit" },
  { task_id: "g4", question: "Solve this complex problem.", level: 3, final_answer: "42" },
];

// ── GaiaBenchmarkRunner Tests ────────────────────────────────────────────────

describe("GaiaBenchmarkRunner", () => {
  describe("case loading", () => {
    it("should load GAIA raw cases and default to L1 only", () => {
      const runner = new GaiaBenchmarkRunner();
      runner.loadCases(sampleGaiaCases);
      // Default filters to L1 only
      expect(runner.getCaseCount()).toBe(2);
    });

    it("should load cases from JSON string", () => {
      const runner = new GaiaBenchmarkRunner();
      runner.loadCasesFromJson(JSON.stringify(sampleGaiaCases));
      expect(runner.getCaseCount()).toBe(2);
    });

    it("should filter by multiple levels", () => {
      const runner = new GaiaBenchmarkRunner({ levels: [1, 2] });
      runner.loadCases(sampleGaiaCases);
      expect(runner.getCaseCount()).toBe(3);
    });

    it("should load all levels when specified", () => {
      const runner = new GaiaBenchmarkRunner({ levels: [1, 2, 3] });
      runner.loadCases(sampleGaiaCases);
      expect(runner.getCaseCount()).toBe(4);
    });

    it("should respect maxCases limit", () => {
      const runner = new GaiaBenchmarkRunner({ levels: [1, 2, 3], maxCases: 2 });
      runner.loadCases(sampleGaiaCases);
      expect(runner.getCaseCount()).toBe(2);
    });

    it("should load zero cases when no matching levels", () => {
      const runner = new GaiaBenchmarkRunner({ levels: [3] });
      runner.loadCases([sampleGaiaCases[0], sampleGaiaCases[1]]); // only L1
      expect(runner.getCaseCount()).toBe(0);
    });
  });

  describe("case conversion", () => {
    it("should convert GAIA fields to EvalCase format", () => {
      const runner = new GaiaBenchmarkRunner();
      const rawCases: GaiaBenchmarkRawCase[] = [
        {
          task_id: "test-001",
          question: "What is TypeScript?",
          level: 1,
          final_answer: "JavaScript superset",
          file_name: "readme.md",
        },
      ];
      runner.loadCases(rawCases);
      expect(runner.getCaseCount()).toBe(1);
    });

    it("should tag cases with gaia-level prefix", () => {
      const runner = new GaiaBenchmarkRunner({ levels: [1, 2] });
      runner.loadCases(sampleGaiaCases);
      // Just verify loading works with tags — internal EvalCase tags are not directly accessible
      expect(runner.getCaseCount()).toBe(3);
    });

    it("should handle cases with annotator_metadata", () => {
      const runner = new GaiaBenchmarkRunner({ levels: [1] });
      const rawCases: GaiaBenchmarkRawCase[] = [
        {
          task_id: "meta-001",
          question: "Test with metadata",
          level: 1,
          final_answer: "answer",
          annotator_metadata: { Category: "math" },
        },
      ];
      runner.loadCases(rawCases);
      expect(runner.getCaseCount()).toBe(1);
    });

    it("should handle cases with file_name", () => {
      const runner = new GaiaBenchmarkRunner({ levels: [1] });
      const rawCases: GaiaBenchmarkRawCase[] = [
        {
          task_id: "file-001",
          question: "Read the attached file.",
          level: 1,
          final_answer: "content",
          file_name: "data.csv",
        },
      ];
      runner.loadCases(rawCases);
      expect(runner.getCaseCount()).toBe(1);
    });
  });

  describe("benchmark execution", () => {
    it("should run benchmark and produce results", async () => {
      const runner = new GaiaBenchmarkRunner({ name: "gaia-l1-test" });
      runner.loadCases([
        { task_id: "r1", question: "What is the capital of France?", level: 1, final_answer: "Paris" },
        { task_id: "r2", question: "What is 2+2?", level: 1, final_answer: "4" },
      ]);

      const agent = mockAgent(new Map([
        ["capital", "Paris is the capital"],
        ["2+2", "The answer is 4"],
      ]));

      const result = await runner.run(agent);
      expect(result.benchmark).toBe("gaia-l1-test");
      expect(result.totalCases).toBe(2);
      expect(result.passed).toBe(2);
      expect(result.passRate).toBe(1);
    });

    it("should report failures correctly", async () => {
      const runner = new GaiaBenchmarkRunner();
      runner.loadCases([
        { task_id: "f1", question: "What is X?", level: 1, final_answer: "correct" },
      ]);

      const agent: AgentExecutor = {
        async execute(): Promise<AgentResponse> {
          return okResponse("wrong answer");
        },
      };

      const result = await runner.run(agent);
      expect(result.passed).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.passRate).toBe(0);
    });

    it("should calculate by-level statistics", async () => {
      const runner = new GaiaBenchmarkRunner({ levels: [1, 2] });
      runner.loadCases([
        { task_id: "l1-1", question: "Q1", level: 1, final_answer: "A1" },
        { task_id: "l1-2", question: "Q2", level: 1, final_answer: "A2" },
        { task_id: "l2-1", question: "Q3", level: 2, final_answer: "A3" },
      ]);

      const agent = mockAgent(new Map([
        ["q1", "A1"],
        ["q2", "wrong"],
        ["q3", "A3"],
      ]));

      const result = await runner.run(agent);
      expect(result.byLevel[1]).toBeDefined();
      expect(result.byLevel[1].total).toBe(2);
      expect(result.byLevel[1].passed).toBe(1);
      expect(result.byLevel[2]).toBeDefined();
      expect(result.byLevel[2].total).toBe(1);
      expect(result.byLevel[2].passed).toBe(1);
    });

    it("should track cost", async () => {
      const runner = new GaiaBenchmarkRunner();
      runner.loadCases([
        { task_id: "c1", question: "Q", level: 1, final_answer: "A" },
      ]);

      const agent = mockAgent(new Map([["q", "A"]]));
      const result = await runner.run(agent);
      expect(result.totalCostUsd).toBeGreaterThanOrEqual(0);
    });
  });

  describe("regression detection", () => {
    it("should detect no regression without baseline", async () => {
      const runner = new GaiaBenchmarkRunner();
      runner.loadCases([
        { task_id: "reg-1", question: "Q", level: 1, final_answer: "A" },
      ]);

      const agent = mockAgent(new Map([["q", "A"]]));
      const result = await runner.run(agent);
      const check = runner.checkRegression(result, null);
      expect(check.isRegression).toBe(false);
    });

    it("should detect regression when pass rate drops", async () => {
      const runner = new GaiaBenchmarkRunner();
      runner.loadCases([
        { task_id: "reg-1", question: "Q", level: 1, final_answer: "A" },
      ]);

      const agent = mockAgent(new Map([["q", "A"]]));
      const result = await runner.run(agent);

      const betterBaseline = { ...result, passRate: 1.0, passed: 1, failed: 0 };
      const check = runner.checkRegression(result, betterBaseline, 0.05);
      // Since result.passRate is 1.0 and baseline is 1.0, no regression
      expect(check.isRegression).toBe(false);

      // Now test with a worse current result
      const worseResult = { ...result, passRate: 0.5, passed: 0, failed: 1 };
      const check2 = runner.checkRegression(worseResult, betterBaseline, 0.05);
      expect(check2.isRegression).toBe(true);
    });
  });

  describe("configuration", () => {
    it("should use default name gaia-l1", () => {
      const runner = new GaiaBenchmarkRunner();
      runner.loadCases([{ task_id: "x", question: "Q", level: 1, final_answer: "A" }]);
      // Just verify it doesn't throw
      expect(runner.getCaseCount()).toBe(1);
    });

    it("should accept custom name", () => {
      const runner = new GaiaBenchmarkRunner({ name: "my-benchmark" });
      runner.loadCases([{ task_id: "x", question: "Q", level: 1, final_answer: "A" }]);
      expect(runner.getCaseCount()).toBe(1);
    });

    it("should accept custom model", () => {
      const runner = new GaiaBenchmarkRunner({ model: "gpt-4o" });
      runner.loadCases([{ task_id: "x", question: "Q", level: 1, final_answer: "A" }]);
      expect(runner.getCaseCount()).toBe(1);
    });

    it("should accept custom level timeouts", () => {
      const runner = new GaiaBenchmarkRunner({
        levels: [1],
        levelTimeouts: { 1: 5000 },
      });
      runner.loadCases([{ task_id: "x", question: "Q", level: 1, final_answer: "A" }]);
      expect(runner.getCaseCount()).toBe(1);
    });
  });

  describe("built-in fixture", () => {
    it("should load the gaia-l1.json fixture file", () => {
      const content = readFileSync(fixturePath("gaia-l1.json"), "utf-8");
      const cases = JSON.parse(content) as GaiaBenchmarkRawCase[];
      expect(cases.length).toBeGreaterThan(0);
      expect(cases.every((c) => c.level === 1)).toBe(true);

      const runner = new GaiaBenchmarkRunner();
      runner.loadCases(cases);
      expect(runner.getCaseCount()).toBe(cases.length);
    });

    it("should run fixture cases against a mock agent", async () => {
      const content = readFileSync(fixturePath("gaia-l1.json"), "utf-8");
      const cases = JSON.parse(content) as GaiaBenchmarkRawCase[];

      const runner = new GaiaBenchmarkRunner({ name: "gaia-l1-fixture" });
      runner.loadCases(cases);

      const agent: AgentExecutor = {
        async execute(prompt: string): Promise<AgentResponse> {
          // Simulate some passes and some failures
          const passes = prompt.includes("capital") || prompt.includes("echo") || prompt.includes("2 + 2");
          return okResponse(passes ? "Paris hello world 4" : "wrong");
        },
      };

      const result = await runner.run(agent);
      expect(result.totalCases).toBe(cases.length);
      expect(result.passRate).toBeGreaterThanOrEqual(0);
      expect(result.passRate).toBeLessThanOrEqual(1);
    });
  });
});

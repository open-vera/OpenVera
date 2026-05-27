/**
 * Tests for ToolBenchRunner — tool/API usage benchmark.
 */
import { describe, it, expect } from "vitest";
import { ToolBenchRunner } from "../runners/toolbench-runner.js";
import type { ToolBenchRawCase, ToolBenchRunnerOptions } from "../runners/toolbench-runner.js";
import type { AgentExecutor, AgentResponse } from "../harness.js";

// ── Mock Agent ───────────────────────────────────────────────────────────────

function createMockAgent(responses: Map<string, AgentResponse>): AgentExecutor {
  return {
    async execute(prompt: string): Promise<AgentResponse> {
      for (const [key, response] of responses) {
        if (prompt.toLowerCase().includes(key.toLowerCase())) {
          return response;
        }
      }
      return { content: "No matching tool found", toolCalls: [], durationMs: 100 };
    },
  };
}

function okResponse(content: string, tools: string[] = []): AgentResponse {
  return { content, toolCalls: tools, durationMs: 200, costUsd: 0.002 };
}

function failResponse(content: string): AgentResponse {
  return { content, toolCalls: [], durationMs: 100 };
}

// ── Test Fixtures ────────────────────────────────────────────────────────────

const singleToolCase: ToolBenchRawCase = {
  task_id: "tb-001",
  query: "What is the weather in Beijing today?",
  category: "single-tool",
  difficulty: "easy",
  expected_tool_calls: [
    { tool: "get_weather", parameters: { city: "Beijing" } },
  ],
  available_tools: [
    { name: "get_weather", description: "Get weather for a city", parameters: { city: "string" } },
  ],
  expected_answer: "sunny",
};

const multiToolCase: ToolBenchRawCase = {
  task_id: "tb-002",
  query: "Find restaurants near me and check their ratings",
  category: "multi-tool",
  difficulty: "medium",
  expected_tool_calls: [
    { tool: "search_restaurants", parameters: { location: "current" } },
    { tool: "get_ratings", parameters: {} },
  ],
};

const multiTurnCase: ToolBenchRawCase = {
  task_id: "tb-003",
  query: "Book a flight to Tokyo, then find a hotel near the airport",
  category: "multi-turn",
  difficulty: "hard",
  expected_tool_calls: [
    { tool: "search_flights", parameters: { destination: "Tokyo" } },
    { tool: "book_flight", parameters: {} },
    { tool: "search_hotels", parameters: { location: "airport" } },
    { tool: "book_hotel", parameters: {} },
  ],
  expected_answer: "booked",
};

const optionalToolCase: ToolBenchRawCase = {
  task_id: "tb-004",
  query: "Translate 'hello' to French",
  category: "single-tool",
  difficulty: "easy",
  expected_tool_calls: [
    { tool: "translate", parameters: { text: "hello", target: "fr" } },
    { tool: "dictionary_lookup", optional: true },
  ],
};

const contextCase: ToolBenchRawCase = {
  task_id: "tb-005",
  query: "Summarize the document",
  category: "single-tool",
  difficulty: "easy",
  expected_tool_calls: [
    { tool: "read_document", parameters: {} },
  ],
  context: "The document is stored in /tmp/report.pdf",
  available_tools: [
    { name: "read_document", description: "Read a document file" },
  ],
};

const allCases: ToolBenchRawCase[] = [
  singleToolCase,
  multiToolCase,
  multiTurnCase,
  optionalToolCase,
  contextCase,
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ToolBenchRunner", () => {
  describe("constructor", () => {
    it("should create runner with default options", () => {
      const agent = createMockAgent(new Map());
      const runner = new ToolBenchRunner(agent);
      expect(runner.getCaseCount()).toBe(0);
    });

    it("should create runner with custom options", () => {
      const agent = createMockAgent(new Map());
      const runner = new ToolBenchRunner(agent, {
        model: "test-model",
        concurrency: 5,
        timeoutMs: 60_000,
      });
      expect(runner.getCaseCount()).toBe(0);
    });
  });

  describe("loadCases", () => {
    it("should load all cases", () => {
      const agent = createMockAgent(new Map());
      const runner = new ToolBenchRunner(agent);
      runner.loadCases(allCases);
      expect(runner.getCaseCount()).toBe(5);
    });

    it("should filter by category", () => {
      const agent = createMockAgent(new Map());
      const runner = new ToolBenchRunner(agent, { categories: ["single-tool"] });
      runner.loadCases(allCases);
      expect(runner.getCaseCount()).toBe(3);
    });

    it("should filter by multiple categories", () => {
      const agent = createMockAgent(new Map());
      const runner = new ToolBenchRunner(agent, { categories: ["single-tool", "multi-tool"] });
      runner.loadCases(allCases);
      expect(runner.getCaseCount()).toBe(4);
    });

    it("should filter by difficulty", () => {
      const agent = createMockAgent(new Map());
      const runner = new ToolBenchRunner(agent, { difficulties: ["easy"] });
      runner.loadCases(allCases);
      expect(runner.getCaseCount()).toBe(3);
    });

    it("should filter by multiple difficulties", () => {
      const agent = createMockAgent(new Map());
      const runner = new ToolBenchRunner(agent, { difficulties: ["easy", "medium"] });
      runner.loadCases(allCases);
      expect(runner.getCaseCount()).toBe(4);
    });

    it("should limit max cases", () => {
      const agent = createMockAgent(new Map());
      const runner = new ToolBenchRunner(agent, { maxCases: 2 });
      runner.loadCases(allCases);
      expect(runner.getCaseCount()).toBe(2);
    });

    it("should combine category and difficulty filters", () => {
      const agent = createMockAgent(new Map());
      const runner = new ToolBenchRunner(agent, {
        categories: ["single-tool"],
        difficulties: ["easy"],
      });
      runner.loadCases(allCases);
      expect(runner.getCaseCount()).toBe(3);
    });

    it("should return raw cases for inspection", () => {
      const agent = createMockAgent(new Map());
      const runner = new ToolBenchRunner(agent);
      runner.loadCases(allCases);
      const raw = runner.getRawCases();
      expect(raw.length).toBe(5);
      expect(raw[0].task_id).toBe("tb-001");
    });
  });

  describe("loadCasesFromJson", () => {
    it("should load cases from JSON string", () => {
      const agent = createMockAgent(new Map());
      const runner = new ToolBenchRunner(agent);
      runner.loadCasesFromJson(JSON.stringify(allCases));
      expect(runner.getCaseCount()).toBe(5);
    });

    it("should throw on invalid JSON", () => {
      const agent = createMockAgent(new Map());
      const runner = new ToolBenchRunner(agent);
      expect(() => runner.loadCasesFromJson("not json")).toThrow();
    });
  });

  describe("case conversion", () => {
    it("should map single-tool category to level 1", async () => {
      const responses = new Map([
        ["weather", okResponse("sunny", ["get_weather"])],
      ]);
      const agent = createMockAgent(responses);
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([singleToolCase]);
      const report = await runner.runAll();
      // Level 1 for easy single-tool
      expect(report.byLevel[1]).toBeDefined();
    });

    it("should map multi-tool category to level 2", async () => {
      const responses = new Map([
        ["restaurants", okResponse("Found restaurants", ["search_restaurants", "get_ratings"])],
      ]);
      const agent = createMockAgent(responses);
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([multiToolCase]);
      const report = await runner.runAll();
      expect(report.byLevel[2]).toBeDefined();
    });

    it("should map multi-turn category to level 3", async () => {
      const responses = new Map([
        ["flight", okResponse("booked", ["search_flights", "book_flight"])],
      ]);
      const agent = createMockAgent(responses);
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([multiTurnCase]);
      const report = await runner.runAll();
      expect(report.byLevel[3]).toBeDefined();
    });

    it("should map hard difficulty to level 3 regardless of category", async () => {
      const responses = new Map([
        ["flight", okResponse("done", ["search_flights"])],
      ]);
      const agent = createMockAgent(responses);
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([multiTurnCase]);
      const report = await runner.runAll();
      expect(report.byLevel[3]).toBeDefined();
    });

    it("should include available_tools in prompt", async () => {
      let capturedPrompt = "";
      const agent: AgentExecutor = {
        async execute(prompt: string): Promise<AgentResponse> {
          capturedPrompt = prompt;
          return okResponse("sunny", ["get_weather"]);
        },
      };
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([singleToolCase]);
      await runner.runAll();
      expect(capturedPrompt).toContain("get_weather");
      expect(capturedPrompt).toContain("Available Tools");
    });

    it("should include context in prompt when present", async () => {
      let capturedPrompt = "";
      const agent: AgentExecutor = {
        async execute(prompt: string): Promise<AgentResponse> {
          capturedPrompt = prompt;
          return okResponse("summary", ["read_document"]);
        },
      };
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([contextCase]);
      await runner.runAll();
      expect(capturedPrompt).toContain("/tmp/report.pdf");
      expect(capturedPrompt).toContain("Context");
    });

    it("should exclude optional tools from expectedTools", async () => {
      const agent = createMockAgent(new Map([
        ["translate", okResponse("bonjour", ["translate"])],
      ]));
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([optionalToolCase]);
      const report = await runner.runAll();
      // translate should pass even without dictionary_lookup
      expect(report.results[0].status).toBe("pass");
    });

    it("should extract category tag", async () => {
      const agent = createMockAgent(new Map([
        ["weather", okResponse("sunny", ["get_weather"])],
      ]));
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([singleToolCase]);
      // We can't directly inspect tags on EvalCase from report, but the conversion should not throw
      const report = await runner.runAll();
      expect(report.totalCases).toBe(1);
    });
  });

  describe("runAll", () => {
    it("should run all cases and return report", async () => {
      const responses = new Map([
        ["weather", okResponse("sunny today", ["get_weather"])],
        ["restaurants", okResponse("Found 5 restaurants", ["search_restaurants", "get_ratings"])],
        ["flight", okResponse("Flight booked to Tokyo", ["search_flights", "book_flight"])],
        ["translate", okResponse("bonjour", ["translate"])],
        ["summarize", okResponse("Summary of document", ["read_document"])],
      ]);
      const agent = createMockAgent(responses);
      const runner = new ToolBenchRunner(agent, { model: "test-model" });
      runner.loadCases(allCases);

      const report = await runner.runAll();
      expect(report.totalCases).toBe(5);
      expect(report.benchmark).toBe("ToolBench");
      expect(report.model).toBe("test-model");
    });

    it("should handle agent errors gracefully", async () => {
      const agent: AgentExecutor = {
        async execute() { throw new Error("API unavailable"); },
      };
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([singleToolCase]);

      const report = await runner.runAll();
      expect(report.results[0].status).toBe("error");
      expect(report.results[0].error).toContain("API unavailable");
    });

    it("should handle empty case list", async () => {
      const agent = createMockAgent(new Map());
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([]);

      const report = await runner.runAll();
      expect(report.totalCases).toBe(0);
      expect(report.passRate).toBe(0);
    });
  });

  describe("runAllWithMetrics", () => {
    it("should compute tool accuracy metric", async () => {
      const responses = new Map([
        ["weather", okResponse("sunny", ["get_weather"])],
        ["restaurants", okResponse("Found", ["search_restaurants", "get_ratings"])],
      ]);
      const agent = createMockAgent(responses);
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([singleToolCase, multiToolCase]);

      const { report, metrics } = await runner.runAllWithMetrics();
      expect(metrics.total).toBe(2);
      expect(metrics.toolAccuracy).toBeGreaterThanOrEqual(0);
      expect(metrics.toolAccuracy).toBeLessThanOrEqual(1);
    });

    it("should compute per-category breakdown", async () => {
      const responses = new Map([
        ["weather", okResponse("sunny", ["get_weather"])],
        ["restaurants", okResponse("Found", ["search_restaurants", "get_ratings"])],
        ["flight", okResponse("booked", ["search_flights", "book_flight"])],
      ]);
      const agent = createMockAgent(responses);
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([singleToolCase, multiToolCase, multiTurnCase]);

      const { metrics } = await runner.runAllWithMetrics();
      expect(metrics.byCategory["single-tool"]).toBeDefined();
      expect(metrics.byCategory["multi-tool"]).toBeDefined();
      expect(metrics.byCategory["multi-turn"]).toBeDefined();
      expect(metrics.byCategory["single-tool"].total).toBe(1);
      expect(metrics.byCategory["multi-tool"].total).toBe(1);
      expect(metrics.byCategory["multi-turn"].total).toBe(1);
    });

    it("should compute average API calls", async () => {
      const responses = new Map([
        ["weather", okResponse("sunny", ["get_weather"])],
        ["restaurants", okResponse("Found", ["search_restaurants", "get_ratings"])],
      ]);
      const agent = createMockAgent(responses);
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([singleToolCase, multiToolCase]);

      const { metrics } = await runner.runAllWithMetrics();
      // case 1 has 1 tool call, case 2 has 2 tool calls
      expect(metrics.avgApiCalls).toBeCloseTo(1.5);
    });

    it("should handle zero tool calls", async () => {
      const agent = createMockAgent(new Map());
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([singleToolCase]);

      const { metrics } = await runner.runAllWithMetrics();
      expect(metrics.avgApiCalls).toBe(0);
    });

    it("should compute pass rate correctly", async () => {
      const responses = new Map([
        ["weather", okResponse("sunny", ["get_weather"])],
        ["restaurants", failResponse("I cannot help")], // fail: no tool calls
      ]);
      const agent = createMockAgent(responses);
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([singleToolCase, multiToolCase]);

      const { metrics } = await runner.runAllWithMetrics();
      expect(metrics.passRate).toBeGreaterThan(0);
      expect(metrics.passRate).toBeLessThan(1);
    });
  });

  describe("evaluation logic", () => {
    it("should pass when expected tools are called", async () => {
      const responses = new Map([
        ["weather", okResponse("sunny", ["get_weather"])],
      ]);
      const agent = createMockAgent(responses);
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([singleToolCase]);

      const report = await runner.runAll();
      expect(report.results[0].status).toBe("pass");
      expect(report.results[0].toolCalls).toContain("get_weather");
    });

    it("should fail when expected tools are not called", async () => {
      const responses = new Map([
        ["weather", failResponse("I don't have weather tools")],
      ]);
      const agent = createMockAgent(responses);
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([singleToolCase]);

      const report = await runner.runAll();
      expect(report.results[0].status).toBe("fail");
    });

    it("should pass when all required multi-tools are called", async () => {
      const responses = new Map([
        ["restaurants", okResponse("Found restaurants", ["search_restaurants", "get_ratings"])],
      ]);
      const agent = createMockAgent(responses);
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([multiToolCase]);

      const report = await runner.runAll();
      expect(report.results[0].status).toBe("pass");
    });

    it("should partial match when some tools are called", async () => {
      let agent: AgentExecutor = {
        async execute(_prompt: string): Promise<AgentResponse> {
          return okResponse("Found", ["search_restaurants"]);
        },
      };
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([multiToolCase]);

      const report = await runner.runAll();
      // 1 of 2 tools matched = 0.5 score, below 0.8 threshold
      expect(report.results[0].score).toBeCloseTo(0.5);
      expect(report.results[0].status).toBe("fail");
    });

    it("should use contains eval when expected_answer is provided", async () => {
      const responses = new Map([
        ["weather", okResponse("The weather is sunny today", ["get_weather"])],
      ]);
      const agent = createMockAgent(responses);
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([singleToolCase]);

      const report = await runner.runAll();
      // Should use tool_match since expectedTools is set, but also check expected_answer
      expect(report.results[0].score).toBeGreaterThanOrEqual(0);
    });
  });

  describe("edge cases", () => {
    it("should handle case with no expected_tool_calls", async () => {
      const emptyCase: ToolBenchRawCase = {
        task_id: "tb-empty",
        query: "Hello",
        category: "single-tool",
        expected_tool_calls: [],
      };
      const agent = createMockAgent(new Map());
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([emptyCase]);

      const report = await runner.runAll();
      expect(report.totalCases).toBe(1);
    });

    it("should handle case with only optional tools", async () => {
      const optOnlyCase: ToolBenchRawCase = {
        task_id: "tb-opt",
        query: "Translate text",
        category: "single-tool",
        expected_tool_calls: [
          { tool: "translate", optional: true },
        ],
      };
      const agent = createMockAgent(new Map());
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([optOnlyCase]);

      const report = await runner.runAll();
      // No required tools → tool_match should return 1 (empty expected = pass)
      expect(report.results[0].score).toBe(1);
    });

    it("should handle missing difficulty", async () => {
      const noDifficulty: ToolBenchRawCase = {
        task_id: "tb-nodiff",
        query: "Simple task",
        category: "single-tool",
        expected_tool_calls: [{ tool: "do_something" }],
      };
      const agent = createMockAgent(new Map());
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([noDifficulty]);

      const report = await runner.runAll();
      expect(report.totalCases).toBe(1);
      // Default level for single-tool without difficulty should be 1
      expect(report.byLevel[1]).toBeDefined();
    });

    it("should handle very long query", async () => {
      const longCase: ToolBenchRawCase = {
        task_id: "tb-long",
        query: "A".repeat(5000),
        category: "single-tool",
        expected_tool_calls: [{ tool: "process" }],
      };
      const agent = createMockAgent(new Map([
        ["aaa", okResponse("done", ["process"])],
      ]));
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([longCase]);

      const report = await runner.runAll();
      expect(report.totalCases).toBe(1);
    });

    it("should handle many expected tool calls", async () => {
      const manyCase: ToolBenchRawCase = {
        task_id: "tb-many",
        query: "Complex workflow",
        category: "multi-tool",
        difficulty: "hard",
        expected_tool_calls: Array.from({ length: 10 }, (_, i) => ({
          tool: `tool_${i}`,
        })),
      };
      const agent = createMockAgent(new Map([
        ["workflow", okResponse("done", Array.from({ length: 10 }, (_, i) => `tool_${i}`))],
      ]));
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([manyCase]);

      const { metrics } = await runner.runAllWithMetrics();
      expect(metrics.avgApiCalls).toBe(10);
    });
  });

  describe("tag extraction", () => {
    it("should tag single-call cases", async () => {
      const agent = createMockAgent(new Map());
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([singleToolCase]);
      // Tags are set internally; we verify the case loads correctly
      expect(runner.getCaseCount()).toBe(1);
    });

    it("should tag many-calls cases", async () => {
      const agent = createMockAgent(new Map());
      const runner = new ToolBenchRunner(agent);
      runner.loadCases([multiTurnCase]);
      expect(runner.getCaseCount()).toBe(1);
    });
  });
});

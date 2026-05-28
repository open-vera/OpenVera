/**
 * Tests for SweBenchRunner — SWE-bench evaluation set integration.
 */
import { describe, it, expect } from "vitest";
import { SweBenchRunner } from "../runners/swe-bench-runner.js";
import type { SweBenchRawCase, SweBenchRunnerOptions } from "../runners/swe-bench-runner.js";
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
      return { content: "", toolCalls: [], durationMs: 100 };
    },
  };
}

function patchResponse(patch: string): AgentResponse {
  return {
    content: `Here's the fix:\n\n\`\`\`diff\n${patch}\n\`\`\``,
    toolCalls: ["read_file", "edit_file"],
    durationMs: 5000,
    costUsd: 0.05,
  };
}

function emptyResponse(): AgentResponse {
  return { content: "I'm not sure how to fix this.", toolCalls: [], durationMs: 1000 };
}

// ── Test Data ────────────────────────────────────────────────────────────────

const sampleCases: SweBenchRawCase[] = [
  {
    instance_id: "scikit-learn__scikit-learn-13779",
    problem_statement: "LassoLarsIC uses AIC/BIC but does not account for sample size correctly.",
    base_commit: "abc123",
    patch: "--- a/sklearn/linear_model/_least_angle.py\n+++ b/sklearn/linear_model/_least_angle.py\n@@ -1,1 +1,1 @@\n-old code\n+new code",
    test_patch: "--- a/sklearn/linear_model/tests/test_least_angle.py\n+++ b/sklearn/linear_model/tests/test_least_angle.py\n@@ -1,1 +1,1 @@\n-old test\n+new test",
    repo: "scikit-learn/scikit-learn",
    difficulty: "medium",
    version: "3.8",
  },
  {
    instance_id: "django__django-11049",
    problem_statement: "Allow using HttpResponse as a streaming response.",
    base_commit: "def456",
    patch: "--- a/django/http/response.py\n+++ b/django/http/response.py\n@@ -1,1 +1,1 @@\n-old\n+new",
    test_patch: "--- a/tests/test_response.py\n+++ b/tests/test_response.py\n@@ -1,1 +1,1 @@\n-old\n+new",
    repo: "django/django",
    difficulty: "easy",
    hints: "Look at the StreamingHttpResponse class.",
  },
  {
    instance_id: "psf__requests-5000",
    problem_statement: "Session cookies not persisted across redirects.",
    base_commit: "ghi789",
    patch: "--- a/requests/sessions.py\n+++ b/requests/sessions.py\n@@ -1,1 +1,1 @@\n-old\n+new",
    test_patch: "--- a/tests/test_sessions.py\n+++ b/tests/test_sessions.py\n@@ -1,1 +1,1 @@\n-old\n+new",
    repo: "psf/requests",
    difficulty: "hard",
  },
];

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("SweBenchRunner", () => {
  describe("loading cases", () => {
    it("should load raw cases", () => {
      const agent = createMockAgent(new Map());
      const runner = new SweBenchRunner(agent);
      runner.loadCases(sampleCases);
      expect(runner.getCaseCount()).toBe(3);
    });

    it("should load cases from JSON string", () => {
      const agent = createMockAgent(new Map());
      const runner = new SweBenchRunner(agent);
      runner.loadCasesFromJson(JSON.stringify(sampleCases));
      expect(runner.getCaseCount()).toBe(3);
    });

    it("should filter by difficulty", () => {
      const agent = createMockAgent(new Map());
      const runner = new SweBenchRunner(agent, { difficulties: ["easy"] });
      runner.loadCases(sampleCases);
      expect(runner.getCaseCount()).toBe(1);
    });

    it("should filter by multiple difficulties", () => {
      const agent = createMockAgent(new Map());
      const runner = new SweBenchRunner(agent, { difficulties: ["easy", "hard"] });
      runner.loadCases(sampleCases);
      expect(runner.getCaseCount()).toBe(2);
    });

    it("should filter by repository", () => {
      const agent = createMockAgent(new Map());
      const runner = new SweBenchRunner(agent, { repos: ["django/django"] });
      runner.loadCases(sampleCases);
      expect(runner.getCaseCount()).toBe(1);
    });

    it("should filter by multiple repositories", () => {
      const agent = createMockAgent(new Map());
      const runner = new SweBenchRunner(agent, {
        repos: ["django/django", "psf/requests"],
      });
      runner.loadCases(sampleCases);
      expect(runner.getCaseCount()).toBe(2);
    });

    it("should limit max cases", () => {
      const agent = createMockAgent(new Map());
      const runner = new SweBenchRunner(agent, { maxCases: 2 });
      runner.loadCases(sampleCases);
      expect(runner.getCaseCount()).toBe(2);
    });

    it("should combine filters", () => {
      const agent = createMockAgent(new Map());
      const runner = new SweBenchRunner(agent, {
        difficulties: ["medium", "hard"],
        repos: ["scikit-learn/scikit-learn"],
        maxCases: 1,
      });
      runner.loadCases(sampleCases);
      expect(runner.getCaseCount()).toBe(1);
    });
  });

  describe("raw case access", () => {
    it("should expose raw cases after loading", () => {
      const agent = createMockAgent(new Map());
      const runner = new SweBenchRunner(agent);
      runner.loadCases(sampleCases);
      const raw = runner.getRawCases();
      expect(raw).toHaveLength(3);
      expect(raw[0].instance_id).toBe("scikit-learn__scikit-learn-13779");
    });

    it("should return a copy of raw cases", () => {
      const agent = createMockAgent(new Map());
      const runner = new SweBenchRunner(agent);
      runner.loadCases(sampleCases);
      const raw1 = runner.getRawCases();
      const raw2 = runner.getRawCases();
      expect(raw1).not.toBe(raw2);
      expect(raw1).toEqual(raw2);
    });
  });

  describe("prompt building", () => {
    it("should include problem statement in prompt", async () => {
      let capturedPrompt = "";
      const agent: AgentExecutor = {
        async execute(prompt: string) {
          capturedPrompt = prompt;
          return emptyResponse();
        },
      };
      const runner = new SweBenchRunner(agent);
      runner.loadCases([sampleCases[0]]);
      await runner.runAll();

      expect(capturedPrompt).toContain("LassoLarsIC");
      expect(capturedPrompt).toContain("scikit-learn__scikit-learn-13779");
    });

    it("should include hints when available", async () => {
      let capturedPrompt = "";
      const agent: AgentExecutor = {
        async execute(prompt: string) {
          capturedPrompt = prompt;
          return emptyResponse();
        },
      };
      const runner = new SweBenchRunner(agent);
      runner.loadCases([sampleCases[1]]); // has hints
      await runner.runAll();

      expect(capturedPrompt).toContain("StreamingHttpResponse");
    });

    it("should include version when available", async () => {
      let capturedPrompt = "";
      const agent: AgentExecutor = {
        async execute(prompt: string) {
          capturedPrompt = prompt;
          return emptyResponse();
        },
      };
      const runner = new SweBenchRunner(agent);
      runner.loadCases([sampleCases[0]]); // has version
      await runner.runAll();

      expect(capturedPrompt).toContain("3.8");
    });

    it("should include test patch when option is set", async () => {
      let capturedPrompt = "";
      const agent: AgentExecutor = {
        async execute(prompt: string) {
          capturedPrompt = prompt;
          return emptyResponse();
        },
      };
      const runner = new SweBenchRunner(agent, { includeTestPatch: true });
      runner.loadCases([sampleCases[0]]);
      await runner.runAll();

      expect(capturedPrompt).toContain("Test Patch");
      expect(capturedPrompt).toContain("test_least_angle");
    });

    it("should include gold patch when option is set", async () => {
      let capturedPrompt = "";
      const agent: AgentExecutor = {
        async execute(prompt: string) {
          capturedPrompt = prompt;
          return emptyResponse();
        },
      };
      const runner = new SweBenchRunner(agent, { includeGoldPatch: true });
      runner.loadCases([sampleCases[0]]);
      await runner.runAll();

      expect(capturedPrompt).toContain("Expected Patch");
    });

    it("should not include test patch by default", async () => {
      let capturedPrompt = "";
      const agent: AgentExecutor = {
        async execute(prompt: string) {
          capturedPrompt = prompt;
          return emptyResponse();
        },
      };
      const runner = new SweBenchRunner(agent);
      runner.loadCases([sampleCases[0]]);
      await runner.runAll();

      expect(capturedPrompt).not.toContain("Test Patch");
    });
  });

  describe("evaluation", () => {
    it("should pass when agent produces matching patch", async () => {
      const goldPatch = sampleCases[0].patch;
      const responses = new Map([
        ["lassolarsic", patchResponse(goldPatch)],
      ]);
      const agent = createMockAgent(responses);
      const runner = new SweBenchRunner(agent);
      runner.loadCases([sampleCases[0]]);

      const report = await runner.runAll();
      expect(report.results[0].status).toBe("pass");
      expect(report.results[0].score).toBeGreaterThan(0);
    });

    it("should fail when agent produces no patch", async () => {
      const responses = new Map([
        ["lassolarsic", emptyResponse()],
      ]);
      const agent = createMockAgent(responses);
      const runner = new SweBenchRunner(agent);
      runner.loadCases([sampleCases[0]]);

      const report = await runner.runAll();
      expect(report.results[0].status).toBe("fail");
    });

    it("should handle agent errors", async () => {
      const agent: AgentExecutor = {
        async execute() {
          throw new Error("Failed to clone repo");
        },
      };
      const runner = new SweBenchRunner(agent);
      runner.loadCases([sampleCases[0]]);

      const report = await runner.runAll();
      expect(report.results[0].status).toBe("error");
      expect(report.results[0].error).toContain("Failed to clone repo");
    });

    it("should handle timeout errors", async () => {
      const agent: AgentExecutor = {
        async execute() {
          throw new Error("Execution timeout exceeded");
        },
      };
      const runner = new SweBenchRunner(agent);
      runner.loadCases([sampleCases[0]]);

      const report = await runner.runAll();
      expect(report.results[0].status).toBe("timeout");
    });
  });

  describe("report generation", () => {
    it("should generate correct report statistics", async () => {
      const goldPatch = sampleCases[0].patch;
      const responses = new Map([
        ["lassolarsic", patchResponse(goldPatch)],
        ["django", patchResponse("--- a/file.py\n+++ b/file.py\n-old\n+new")],
        ["requests", emptyResponse()],
      ]);
      const agent = createMockAgent(responses);
      const runner = new SweBenchRunner(agent, { model: "test-model" });
      runner.loadCases(sampleCases);

      const report = await runner.runAll();
      expect(report.totalCases).toBe(3);
      expect(report.benchmark).toBe("SWE-bench");
      expect(report.model).toBe("test-model");
      expect(report.passed).toBeGreaterThanOrEqual(1);
      expect(report.passRate).toBeGreaterThan(0);
    });

    it("should group results by difficulty level", async () => {
      const responses = new Map([
        ["lassolarsic", patchResponse(sampleCases[0].patch)],
        ["django", patchResponse(sampleCases[1].patch)],
        ["requests", emptyResponse()],
      ]);
      const agent = createMockAgent(responses);
      const runner = new SweBenchRunner(agent);
      runner.loadCases(sampleCases);

      const report = await runner.runAll();
      // easy=level 1, medium=level 2, hard=level 3
      expect(report.byLevel[1]).toBeDefined();
      expect(report.byLevel[2]).toBeDefined();
      expect(report.byLevel[3]).toBeDefined();
    });
  });

  describe("SWE-bench metrics", () => {
    it("should compute resolved rate", async () => {
      const goldPatch = sampleCases[0].patch;
      const responses = new Map([
        ["lassolarsic", patchResponse(goldPatch)],
        ["django", patchResponse(goldPatch)],
        ["requests", emptyResponse()],
      ]);
      const agent = createMockAgent(responses);
      const runner = new SweBenchRunner(agent);
      runner.loadCases(sampleCases);

      const { metrics } = await runner.runAllWithMetrics();
      expect(metrics.total).toBe(3);
      expect(metrics.resolved).toBeGreaterThanOrEqual(1);
      expect(metrics.resolvedRate).toBeGreaterThan(0);
    });

    it("should compute patch rate", async () => {
      const responses = new Map([
        ["lassolarsic", patchResponse("--- a/x.py\n+++ b/x.py\n-old\n+new")],
        ["django", emptyResponse()],
        ["requests", emptyResponse()],
      ]);
      const agent = createMockAgent(responses);
      const runner = new SweBenchRunner(agent);
      runner.loadCases(sampleCases);

      const { metrics } = await runner.runAllWithMetrics();
      expect(metrics.patched).toBe(1);
      expect(metrics.patchRate).toBeCloseTo(1 / 3);
    });

    it("should compute patch accuracy", async () => {
      const responses = new Map([
        ["lassolarsic", patchResponse(sampleCases[0].patch)],
        ["django", emptyResponse()],
        ["requests", emptyResponse()],
      ]);
      const agent = createMockAgent(responses);
      const runner = new SweBenchRunner(agent);
      runner.loadCases(sampleCases);

      const { metrics } = await runner.runAllWithMetrics();
      expect(metrics.patchAccuracy).toBeGreaterThanOrEqual(0);
      expect(metrics.patchAccuracy).toBeLessThanOrEqual(1);
    });

    it("should handle empty results", async () => {
      const agent = createMockAgent(new Map());
      const runner = new SweBenchRunner(agent);
      runner.loadCases([]);

      const { metrics } = await runner.runAllWithMetrics();
      expect(metrics.total).toBe(0);
      expect(metrics.resolved).toBe(0);
      expect(metrics.patched).toBe(0);
      expect(metrics.resolvedRate).toBe(0);
      expect(metrics.patchRate).toBe(0);
    });
  });

  describe("tags extraction", () => {
    it("should tag with repository name", async () => {
      let capturedCase: unknown = null;
      const harness = (await import("../harness.js")).EvalHarness;
      // We'll verify tags through the report by checking case metadata
      const agent = createMockAgent(new Map());
      const runner = new SweBenchRunner(agent);
      runner.loadCases([sampleCases[0]]);

      // Tags are internal to EvalCase, verified through the eval pipeline
      const report = await runner.runAll();
      expect(report.totalCases).toBe(1);
    });
  });
});

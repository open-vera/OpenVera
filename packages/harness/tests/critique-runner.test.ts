import { describe, it, expect } from "vitest";
import type { LLMAdapter } from "@open-vera/core/adapters";
import type {
  CompletionResponse,
  StreamEvent,
} from "@open-vera/core/types";
import type { AgentAssignment, StepResult } from "@open-vera/core/types";
import { CritiqueRunner } from "../src/agent/critique-runner.js";
import type { StepCritiqueInput } from "../src/runtime/internal.js";

function mockAdapter(
  responseJson: unknown
): LLMAdapter {
  return {
    async complete() {
      return {
        message: {
          role: "assistant",
          content: JSON.stringify(responseJson),
        },
        stop_reason: "end_turn",
      } satisfies CompletionResponse;
    },
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text", text: JSON.stringify(responseJson) };
      yield { type: "done", stop_reason: "end_turn" };
    },
  };
}

function makeAssignment(
  overrides: Partial<AgentAssignment> = {}
): AgentAssignment {
  return {
    flowId: "flow-1",
    stepId: "step-review",
    goal: "Build a login page",
    instruction: "Implement the login form with validation",
    allowedTools: [],
    scope: { workdir: "/tmp" },
    contextSlices: [],
    ...overrides,
  };
}

const validCritiqueJson = {
  passed: false,
  score: 0.6,
  action: "reject",
  critiques: [
    {
      severity: "major",
      issue: "No error handling for network failures",
      suggestion: "Add try/catch around fetch calls",
    },
    {
      severity: "minor",
      issue: "Missing aria-label on submit button",
      suggestion: 'Add aria-label="Submit login form"',
    },
  ],
  verdict: "Mostly good but missing error handling",
  requiredFixes: [
    "Add error handling for network failures",
  ],
};

const cleanCritiqueJson = {
  passed: true,
  score: 1.0,
  action: "pass",
  critiques: [],
  verdict: "Looks great",
  requiredFixes: [],
};

describe("CritiqueRunner", () => {
  it("implements AgentRunner interface", () => {
    const runner = new CritiqueRunner(mockAdapter({}), "claude-haiku-4-5");
    expect(runner.run).toBeDefined();
    expect(typeof runner.run).toBe("function");
  });

  it("returns StepResult with critique output", async () => {
    const adapter = mockAdapter(validCritiqueJson);
    const runner = new CritiqueRunner(adapter, "claude-haiku-4-5");
    const assignment = makeAssignment({
      stepId: "step-login",
      contextSlices: ["<html>login form</html>"],
    });

    const result = await runner.run(assignment, {});

    expect(result.flowId).toBe("flow-1");
    expect(result.stepId).toBe("step-login");
    expect(result.toolCalls).toEqual([]);
    expect(result.output).toContain("# Critique: step-login");
    expect(result.output).toContain("**confidence**: 0.6");
    expect(result.output).toContain("**nextAction**: replan");
    expect(result.output).toContain("No error handling for network failures");
    expect(result.output).toContain("Missing aria-label on submit button");
  });

  it("handles clean critique with no issues", async () => {
    const adapter = mockAdapter(cleanCritiqueJson);
    const runner = new CritiqueRunner(adapter, "claude-haiku-4-5");
    const assignment = makeAssignment({
      contextSlices: ["perfect output"],
    });

    const result = await runner.run(assignment, {});

    expect(result.output).toContain("**confidence**: 1");
    expect(result.output).toContain("**nextAction**: complete");
    expect(result.output).toContain("(none)"); // no issues, no missing checks
  });

  it("works with empty contextSlices", async () => {
    const adapter = mockAdapter(cleanCritiqueJson);
    const runner = new CritiqueRunner(adapter, "claude-haiku-4-5");

    const result = await runner.run(makeAssignment(), {});

    expect(result.output).toBeDefined();
    expect(result.toolCalls).toEqual([]);
  });

  it("passes multiple contextSlices to critique outputs", async () => {
    let capturedPrompt = "";
    const adapter: LLMAdapter = {
      async complete(req) {
        capturedPrompt = req.messages[0]?.content as string;
        return {
          message: {
            role: "assistant",
            content: JSON.stringify(cleanCritiqueJson),
          },
          stop_reason: "end_turn",
        };
      },
      async *stream() {
        yield { type: "done", stop_reason: "end_turn" };
      },
    };

    const runner = new CritiqueRunner(adapter, "claude-haiku-4-5");
    await runner.run(
      makeAssignment({
        contextSlices: [
          "Main output text",
          "Extra context A",
          "Extra context B",
        ],
      }),
      {}
    );

    // All three contextSlices should appear in the prompt
    expect(capturedPrompt).toContain("Main output text");
    expect(capturedPrompt).toContain("Extra context A");
    expect(capturedPrompt).toContain("Extra context B");
  });

  it("uses custom challenge prompt from options", async () => {
    let capturedPrompt = "";
    const adapter: LLMAdapter = {
      async complete(req) {
        capturedPrompt = req.messages[0]?.content as string;
        return {
          message: {
            role: "assistant",
            content: JSON.stringify(cleanCritiqueJson),
          },
          stop_reason: "end_turn",
        };
      },
      async *stream() {
        yield { type: "done", stop_reason: "end_turn" };
      },
    };

    const runner = new CritiqueRunner(adapter, "claude-haiku-4-5", {
      defaultChallengePrompt: "Check for security vulnerabilities",
    });
    await runner.run(makeAssignment(), {});

    expect(capturedPrompt).toContain("Check for security vulnerabilities");
  });
});

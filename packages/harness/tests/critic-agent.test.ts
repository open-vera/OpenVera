import { describe, it, expect, vi, beforeEach } from "vitest";
import { CriticAgent, critiquePrompt, normalizeCriticResult } from "../src/critic/critic-agent.js";
import type { CriticResult, PlanContext, DebateResult } from "../src/critic/critic-agent.js";
import type { StepResult, ExecutionPlan } from "@open-vera/core/types";

// Mock the completeJson function
vi.mock("../src/runtime/json.js", () => ({
  completeJson: vi.fn(),
}));

import { completeJson } from "../src/runtime/json.js";
const mockCompleteJson = vi.mocked(completeJson);

function makePlan(overrides?: Partial<ExecutionPlan>): ExecutionPlan {
  return {
    goal: "Test goal",
    risk: "low",
    assumptions: ["assumption 1"],
    steps: [
      { id: "step-1", action: "do something", type: "tool", status: "completed" },
      { id: "step-2", action: "do something else", type: "agent", status: "completed" },
    ],
    ...overrides,
  } as ExecutionPlan;
}

function makeStepResult(overrides?: Partial<StepResult>): StepResult {
  return {
    flowId: "flow-1",
    stepId: "step-1",
    output: "step output",
    toolCalls: [],
    ...overrides,
  };
}

function makePlanContext(overrides?: Partial<PlanContext>): PlanContext {
  return {
    plan: makePlan(),
    ...overrides,
  };
}

function mockCriticResponse(overrides?: Partial<CriticResult>): Record<string, unknown> {
  return {
    issues: [],
    confidence: 0.9,
    nextAction: "continue",
    reasoning: "Looks good",
    ...overrides,
  };
}

describe("critiquePrompt", () => {
  it("includes plan goal and risk", () => {
    const prompt = critiquePrompt([], makePlanContext());
    expect(prompt).toContain("Test goal");
    expect(prompt).toContain("low");
  });

  it("includes step results", () => {
    const steps = [makeStepResult({ stepId: "step-1", output: "result text" })];
    const prompt = critiquePrompt(steps, makePlanContext());
    expect(prompt).toContain("step-1");
    expect(prompt).toContain("result text");
  });

  it("includes project context when provided", () => {
    const ctx = makePlanContext({ projectContext: "my project info" });
    const prompt = critiquePrompt([], ctx);
    expect(prompt).toContain("my project info");
  });

  it("includes main agent response", () => {
    const prompt = critiquePrompt([], makePlanContext(), "agent says hello");
    expect(prompt).toContain("agent says hello");
  });

  it("includes prior issues for dedup", () => {
    const prompt = critiquePrompt([], makePlanContext(), undefined, ["old issue"]);
    expect(prompt).toContain("old issue");
  });

  it("requests JSON output with correct fields", () => {
    const prompt = critiquePrompt([], makePlanContext());
    expect(prompt).toContain('"issues"');
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain('"nextAction"');
    expect(prompt).toContain('"reasoning"');
  });
});

describe("CriticAgent", () => {
  let agent: CriticAgent;
  const mockAdapter = {} as never;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new CriticAgent(mockAdapter, "test-model");
  });

  describe("critique()", () => {
    it("returns valid CriticResult", async () => {
      mockCompleteJson.mockResolvedValue({
        parsed: mockCriticResponse({ issues: ["issue 1"], confidence: 0.7, nextAction: "replan" }),
        raw: "",
      });

      const result = await agent.critique([makeStepResult()], makePlanContext());
      expect(result.issues).toEqual(["issue 1"]);
      expect(result.confidence).toBe(0.7);
      expect(result.nextAction).toBe("replan");
      expect(typeof result.reasoning).toBe("string");
    });

    it("handles empty step results", async () => {
      mockCompleteJson.mockResolvedValue({
        parsed: mockCriticResponse(),
        raw: "",
      });

      const result = await agent.critique([], makePlanContext());
      expect(result).toBeDefined();
      expect(result.issues).toBeDefined();
    });
  });

  describe("debate()", () => {
    it("stops early when confidence >= 0.8", async () => {
      mockCompleteJson.mockResolvedValue({
        parsed: mockCriticResponse({ confidence: 0.85, nextAction: "continue" }),
        raw: "",
      });

      const defend = vi.fn();
      const result = await agent.debate("initial", [makeStepResult()], makePlanContext(), defend);

      expect(result.totalRounds).toBe(1);
      expect(result.stopReason).toBe("high_confidence");
      expect(defend).not.toHaveBeenCalled();
    });

    it("respects maxRounds limit", async () => {
      let callCount = 0;
      mockCompleteJson.mockImplementation(async () => {
        callCount++;
        return {
          parsed: mockCriticResponse({ confidence: 0.3, issues: [`issue round ${callCount}`] }),
          raw: "",
        };
      });

      const defend = vi.fn().mockResolvedValue("my defense");
      const result = await agent.debate("initial", [makeStepResult()], makePlanContext(), defend);

      expect(result.totalRounds).toBe(3);
      expect(result.stopReason).toBe("max_rounds");
    });

    it("calls mainAgentDefend with critique", async () => {
      let callCount = 0;
      mockCompleteJson.mockImplementation(async () => {
        callCount++;
        return {
          parsed: mockCriticResponse({
            confidence: 0.3,
            issues: callCount === 1 ? ["issue A"] : ["issue A"],
          }),
          raw: "",
        };
      });

      const defend = vi.fn().mockResolvedValue("defense");
      await agent.debate("initial", [makeStepResult()], makePlanContext(), defend);

      expect(defend).toHaveBeenCalledWith(
        expect.objectContaining({ issues: expect.any(Array) })
      );
    });

    it("ends debate when mainAgentDefend returns undefined", async () => {
      mockCompleteJson.mockResolvedValue({
        parsed: mockCriticResponse({ confidence: 0.3, issues: ["issue"] }),
        raw: "",
      });

      const defend = vi.fn().mockResolvedValue(undefined);
      const result = await agent.debate("initial", [makeStepResult()], makePlanContext(), defend);

      expect(result.totalRounds).toBe(1);
    });

    it("stops on no new issues", async () => {
      let callCount = 0;
      mockCompleteJson.mockImplementation(async () => {
        callCount++;
        return {
          parsed: mockCriticResponse({
            confidence: 0.3,
            issues: ["same issue"],
          }),
          raw: "",
        };
      });

      const defend = vi.fn().mockResolvedValue("defense");
      const result = await agent.debate("initial", [makeStepResult()], makePlanContext(), defend);

      // Round 1: issues = ["same issue"], no prior issues → can't stop
      // Round 2: issues = ["same issue"], prior has ["same issue"] → stop (no_new_issues)
      expect(result.stopReason).toBe("no_new_issues");
      expect(result.totalRounds).toBe(2);
    });
  });
});

describe("normalizeCriticResult", () => {
  // Access via the module's internal function through critiquePrompt + completeJson
  // We test normalization indirectly through the CriticAgent mock results.
  // Direct testing would require exporting normalizeCriticResult.

  it("clamps confidence above 1 to 1", async () => {
    mockCompleteJson.mockResolvedValue({
      parsed: { issues: [], confidence: 1.5, nextAction: "continue", reasoning: "test" },
      raw: "",
    });

    const agent = new CriticAgent({} as never, "m");
    const result = await agent.critique([], makePlanContext());
    expect(result.confidence).toBe(1);
  });

  it("clamps confidence below 0 to 0", async () => {
    mockCompleteJson.mockResolvedValue({
      parsed: { issues: [], confidence: -0.5, nextAction: "continue", reasoning: "test" },
      raw: "",
    });

    const agent = new CriticAgent({} as never, "m");
    const result = await agent.critique([], makePlanContext());
    expect(result.confidence).toBe(0);
  });

  it("falls back invalid nextAction to continue", async () => {
    mockCompleteJson.mockResolvedValue({
      parsed: { issues: [], confidence: 0.5, nextAction: "invalid_action", reasoning: "test" },
      raw: "",
    });

    const agent = new CriticAgent({} as never, "m");
    const result = await agent.critique([], makePlanContext());
    expect(result.nextAction).toBe("continue");
  });

  it("falls back to rationale when reasoning is missing", async () => {
    mockCompleteJson.mockResolvedValue({
      parsed: { issues: [], confidence: 0.5, nextAction: "continue", rationale: "from rationale" },
      raw: "",
    });

    const agent = new CriticAgent({} as never, "m");
    const result = await agent.critique([], makePlanContext());
    expect(result.reasoning).toBe("from rationale");
  });

  it("filters non-string issues", async () => {
    mockCompleteJson.mockResolvedValue({
      parsed: { issues: ["valid", 123, null, "also valid"], confidence: 0.5, nextAction: "continue", reasoning: "test" },
      raw: "",
    });

    const agent = new CriticAgent({} as never, "m");
    const result = await agent.critique([], makePlanContext());
    expect(result.issues).toEqual(["valid", "also valid"]);
  });
});

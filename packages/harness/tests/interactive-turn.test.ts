import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMAdapter } from "@open-vera/core/adapters";
import type { ToolResult } from "@open-vera/core/tools";

const streamAgentMock = vi.fn();
const classifyIntentMock = vi.fn();
const shouldPlanMock = vi.fn();
const createHarnessPlanExecutorMock = vi.fn();

vi.mock("@open-vera/core/agent", () => ({
  streamAgent: (...args: unknown[]) => streamAgentMock(...args),
}));

vi.mock("@open-vera/core/intent", () => ({
  classifyIntent: (...args: unknown[]) => classifyIntentMock(...args),
  shouldPlan: (...args: unknown[]) => shouldPlanMock(...args),
}));

vi.mock("../src/runtime/plan-executor.js", () => ({
  createHarnessPlanExecutor: (...args: unknown[]) => createHarnessPlanExecutorMock(...args),
}));

const adapter = {} as LLMAdapter;
const toolResult: ToolResult = { ok: true, content: "tool ok" };

describe("runInteractiveTurn", () => {
  beforeEach(() => {
    streamAgentMock.mockReset();
    classifyIntentMock.mockReset();
    shouldPlanMock.mockReset();
    createHarnessPlanExecutorMock.mockReset();
  });

  it("classifies simple turns and streams them directly", async () => {
    const { runInteractiveTurn } = await import("../src/runtime/interactive-turn.js");
    const intent = {
      level: 0,
      needs_tools: false,
      needs_planning: false,
      domain: "chat",
      reason: "greeting",
    };
    classifyIntentMock.mockResolvedValue(intent);
    shouldPlanMock.mockReturnValue(false);
    streamAgentMock.mockImplementation(async (_message, _options, onDelta) => {
      onDelta("hi");
      return "hi";
    });
    const onRouting = vi.fn();
    const onDelta = vi.fn();

    const result = await runInteractiveTurn({
      message: "hello",
      adapter,
      model: "model",
      tools: [],
      system: "system",
      signal: new AbortController().signal,
      onDelta,
      onToolCall: vi.fn(async () => toolResult),
      onRouting,
    });

    expect(result).toEqual({
      text: "hi",
      routing: { intent, executionMode: "direct_stream" },
    });
    expect(onRouting).toHaveBeenCalledWith({ intent, executionMode: "direct_stream" });
    expect(onDelta).toHaveBeenCalledWith("hi");
    expect(createHarnessPlanExecutorMock).not.toHaveBeenCalled();
  });

  it("routes planning turns through the Harness plan executor", async () => {
    const { runInteractiveTurn } = await import("../src/runtime/interactive-turn.js");
    const intent = {
      level: 3,
      needs_tools: true,
      needs_planning: true,
      domain: "code",
      reason: "complex task",
    };
    classifyIntentMock.mockResolvedValue(intent);
    shouldPlanMock.mockReturnValue(true);
    const planExecutor = vi.fn(async (_message, _ctx, onEvent) => {
      onEvent({ type: "plan_ready", steps: [] });
      onEvent({ type: "step_text", delta: "planned" });
      onEvent({ type: "plan_done" });
    });
    createHarnessPlanExecutorMock.mockReturnValue(planExecutor);
    const onPlanEvent = vi.fn();

    const result = await runInteractiveTurn({
      message: "refactor this module",
      adapter,
      model: "model",
      tools: [],
      system: "system",
      signal: new AbortController().signal,
      onDelta: vi.fn(),
      onToolCall: vi.fn(async () => toolResult),
      onPlanEvent,
    });

    expect(result.routing).toEqual({ intent, executionMode: "harness_plan" });
    expect(result.text).toBe("planned");
    expect(planExecutor).toHaveBeenCalled();
    expect(streamAgentMock).not.toHaveBeenCalled();
    expect(onPlanEvent).toHaveBeenCalledWith({ type: "plan_done" });
  });
});

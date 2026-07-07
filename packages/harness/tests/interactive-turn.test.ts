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
      reason: "simple answer",
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
      message: "tell me a joke",
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

  it("uses a deterministic fast path for simple greetings", async () => {
    const { runInteractiveTurn } = await import("../src/runtime/interactive-turn.js");
    streamAgentMock.mockResolvedValue("hello there");
    const onRouting = vi.fn();

    const result = await runInteractiveTurn({
      message: "Hey boy",
      adapter,
      model: "model",
      tools: [],
      system: "system",
      signal: new AbortController().signal,
      onDelta: vi.fn(),
      onToolCall: vi.fn(async () => toolResult),
      onRouting,
    });

    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(createHarnessPlanExecutorMock).not.toHaveBeenCalled();
    expect(result.routing).toEqual({
      executionMode: "direct_stream",
      intent: {
        level: 0,
        needs_tools: false,
        needs_planning: false,
        domain: "chat",
        reason: "simple greeting",
      },
    });
    expect(onRouting).toHaveBeenCalledWith(result.routing);
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

  it("falls back to direct streaming when intent classification returns invalid JSON", async () => {
    const { runInteractiveTurn } = await import("../src/runtime/interactive-turn.js");
    classifyIntentMock.mockRejectedValue(new SyntaxError("Unexpected token 'b'"));
    shouldPlanMock.mockReturnValue(false);
    streamAgentMock.mockResolvedValue("fixed");
    const onRouting = vi.fn();

    const result = await runInteractiveTurn({
      message: "改下 ci\n#!/bin/bash\nset -euo pipefail",
      adapter,
      model: "model",
      tools: [],
      system: "system",
      signal: new AbortController().signal,
      onDelta: vi.fn(),
      onToolCall: vi.fn(async () => toolResult),
      onRouting,
    });

    expect(result.text).toBe("fixed");
    expect(result.routing).toEqual({
      executionMode: "direct_stream",
      intent: {
        level: 2,
        needs_tools: true,
        needs_planning: false,
        domain: "code",
        reason: "classification failed fallback",
      },
    });
    expect(onRouting).toHaveBeenCalledWith(result.routing);
    expect(streamAgentMock).toHaveBeenCalled();
    expect(createHarnessPlanExecutorMock).not.toHaveBeenCalled();
  });

  it("forces chat mode without tools", async () => {
    const { runInteractiveTurn } = await import("../src/runtime/interactive-turn.js");
    streamAgentMock.mockImplementation(async (_message, _options, onDelta) => {
      onDelta("hello");
      return "hello";
    });
    const onRouting = vi.fn();

    const result = await runInteractiveTurn({
      message: "explain this repo",
      adapter,
      model: "model",
      tools: [{ name: "read_file", description: "read", parameters: { type: "object", properties: {} } }],
      system: "system",
      signal: new AbortController().signal,
      runMode: "chat",
      onDelta: vi.fn(),
      onToolCall: vi.fn(async () => toolResult),
      onRouting,
    });

    expect(result.routing.executionMode).toBe("direct_stream");
    expect(result.routing.intent.reason).toBe("forced chat mode");
    expect(streamAgentMock).toHaveBeenCalledWith(
      "explain this repo",
      expect.objectContaining({ tools: [] }),
      expect.any(Function),
    );
    expect(classifyIntentMock).not.toHaveBeenCalled();
  });

  it("forces plan mode without classification", async () => {
    const { runInteractiveTurn } = await import("../src/runtime/interactive-turn.js");
    const planExecutor = vi.fn(async (_message, _options, onEvent) => {
      onEvent({ type: "step_text", delta: "planned" });
    });
    createHarnessPlanExecutorMock.mockReturnValue(planExecutor);
    shouldPlanMock.mockReturnValue(true);
    const onRouting = vi.fn();

    const result = await runInteractiveTurn({
      message: "refactor the auth module",
      adapter,
      model: "model",
      tools: [],
      system: "system",
      signal: new AbortController().signal,
      runMode: "plan",
      onDelta: vi.fn(),
      onToolCall: vi.fn(async () => toolResult),
      onRouting,
    });

    expect(result.text).toBe("planned");
    expect(result.routing.executionMode).toBe("harness_plan");
    expect(result.routing.intent.reason).toBe("forced plan mode");
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(planExecutor).toHaveBeenCalled();
  });
});

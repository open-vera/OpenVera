import { describe, expect, it, vi } from "vitest";
import type { streamAgent } from "../src/agent/loop.js";
import { runPlanRuntime, runStreamRuntime, isAbortError } from "../src/repl/ui/controller/runtimeBridge.js";
import type { UiEvent } from "../src/repl/ui/events.js";
import type { PlanExecutor } from "../src/plan/index.js";

function baseOptions(overrides: Partial<Parameters<typeof runStreamRuntime>[0]> = {}) {
  const events: UiEvent[] = [];
  const streamingBufferRef = { current: "" };
  const rafRef = { current: null as ReturnType<typeof setTimeout> | null };
  return {
    events,
    options: {
      line: "hello",
      agentOptions: { adapter: {} as never, model: "model" },
      onTextDelta: vi.fn(),
      dispatchUiEvent: (event: UiEvent) => events.push(event),
      streamingBufferRef,
      rafRef,
      toolCallHandler: vi.fn(async () => ({ ok: true, content: "tool result" })),
      formatError: (err: unknown) => `formatted:${err instanceof Error ? err.message : String(err)}`,
      ...overrides,
    },
  };
}

describe("runtimeBridge", () => {
  it("emits stream lifecycle events and completion callback", async () => {
    const onComplete = vi.fn();
    const streamAgentImpl: typeof streamAgent = async (_line, _options, onText) => {
      onText("hi");
      return "final";
    };
    const { events, options } = baseOptions({ streamAgentImpl, onComplete });

    await runStreamRuntime(options);

    expect(onComplete).toHaveBeenCalledWith("final");
    expect(options.streamingBufferRef.current).toBe("final");
    expect(events.map((event) => event.type)).toEqual([
      "assistant.started",
      "status.changed",
      "assistant.completed",
      "status.changed",
    ]);
  });

  it("bridges tool calls to UI events", async () => {
    const streamAgentImpl: typeof streamAgent = async (_line, options) => {
      options.onUsage?.({ input_tokens: 0, output_tokens: 0 });
      base.options.streamingBufferRef.current = "I will read.";
      const result = await options.onToolCall!("read_file", { path: "a.ts" });
      return `done:${result}`;
    };
    const base = baseOptions({ streamAgentImpl });
    const { events, options } = base;

    await runStreamRuntime(options);

    expect(options.toolCallHandler).toHaveBeenCalledWith("read_file", { path: "a.ts" });
    expect(events.map((event) => event.type)).toEqual([
      "assistant.started",
      "status.changed",
      "tool.started",
      "tool.completed",
      "assistant.completed",
      "status.changed",
    ]);
    expect(events[2]).toMatchObject({ type: "tool.started", preface: "I will read." });
  });

  it("emits failed event and error callback on runtime error", async () => {
    const onError = vi.fn();
    const streamAgentImpl: typeof streamAgent = async () => {
      throw new Error("boom");
    };
    const { events, options } = baseOptions({ streamAgentImpl, onError });

    await runStreamRuntime(options);

    expect(onError).toHaveBeenCalledWith("formatted:boom", expect.any(Error), false);
    expect(events.map((event) => event.type)).toEqual([
      "assistant.started",
      "status.changed",
      "assistant.failed",
      "status.changed",
    ]);
    expect(events[2]).toMatchObject({ type: "assistant.failed", message: "formatted:boom" });
  });

  it("normalizes abort errors to cancelled", async () => {
    expect(isAbortError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);

    const onError = vi.fn();
    const streamAgentImpl: typeof streamAgent = async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    const { events, options } = baseOptions({ streamAgentImpl, onError });

    await runStreamRuntime(options);

    expect(onError).toHaveBeenCalledWith("Cancelled.", expect.any(Error), true);
    expect(events[2]).toMatchObject({ type: "assistant.failed", message: "Cancelled." });
  });

  it("runs plan executor with planning status lifecycle", async () => {
    const events: UiEvent[] = [];
    const handlePlanEvent = vi.fn();
    const onComplete = vi.fn();
    const planExecutor: PlanExecutor = async (_goal, _ctx, onEvent, onUsage) => {
      onEvent({ type: "plan_done" });
      onUsage({ input_tokens: 1, output_tokens: 2 });
    };

    await runPlanRuntime({
      line: "plan",
      planExecutor,
      planContext: {
        adapter: {} as never,
        model: "model",
        tools: [],
        system: "system",
        signal: new AbortController().signal,
        onToolCall: async () => ({ ok: true, content: "" }),
      },
      handlePlanEvent,
      captureUsage: vi.fn(),
      dispatchUiEvent: (event) => events.push(event),
      clearPendingPlanFrame: vi.fn(),
      formatError: (err) => String(err),
      onComplete,
    });

    expect(onComplete).toHaveBeenCalled();
    expect(handlePlanEvent).toHaveBeenCalledWith({ type: "plan_done" });
    expect(events).toEqual([
      { type: "status.changed", status: "planning" },
      { type: "status.changed", status: "idle" },
    ]);
  });

  it("normalizes plan runtime errors", async () => {
    const events: UiEvent[] = [];
    const onError = vi.fn();
    const clearPendingPlanFrame = vi.fn();
    const planExecutor: PlanExecutor = async () => {
      throw new Error("plan failed");
    };

    await runPlanRuntime({
      line: "plan",
      planExecutor,
      planContext: {
        adapter: {} as never,
        model: "model",
        tools: [],
        system: "system",
        signal: new AbortController().signal,
        onToolCall: async () => ({ ok: true, content: "" }),
      },
      handlePlanEvent: vi.fn(),
      captureUsage: vi.fn(),
      dispatchUiEvent: (event) => events.push(event),
      clearPendingPlanFrame,
      formatError: () => "formatted plan failed",
      onError,
    });

    expect(clearPendingPlanFrame).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("formatted plan failed", expect.any(Error), false);
    expect(events).toEqual([
      { type: "status.changed", status: "planning" },
      { type: "status.changed", status: "idle" },
    ]);
  });
});

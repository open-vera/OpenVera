import { describe, expect, it, vi } from "vitest";
import type { streamAgent } from "../src/agent/loop.js";
import type { PlanExecutor, PlanStepUI } from "../src/plan/index.js";
import type { AccumulatedCost } from "../src/session/index.js";
import { runPreparedTurn } from "../src/repl/ui/controller/turnRunner.js";
import type { ChatMessage } from "../src/repl/ui/types.js";
import type { Message, Usage } from "../src/types/index.js";

function createStore() {
  return {
    writeAssistant: vi.fn(() => "assistant-uuid"),
    writeEnd: vi.fn(),
  };
}

function baseOptions(overrides: Partial<Parameters<typeof runPreparedTurn>[0]> = {}) {
  let messages: ChatMessage[] = [];
  const events: unknown[] = [];
  const store = createStore();
  const turnCountRef = { current: 0 };
  const historyRef = { current: [] as Message[] };
  const costRef = {
    current: {
      totalUsage: { input_tokens: 1, output_tokens: 2 },
      totalUsd: 0.1,
      byModel: {},
    } satisfies AccumulatedCost,
  };
  const planStepsRef = { current: [] as PlanStepUI[] };
  const planStepTextRef = { current: "" };
  const planRafRef = { current: null as ReturnType<typeof setTimeout> | null };
  const streamingBufferRef = { current: "" };
  const rafRef = { current: null as ReturnType<typeof setTimeout> | null };
  const clearAbort = vi.fn();
  const writeAiTitleIfNeeded = vi.fn();

  return {
    messagesRef: { get current() { return messages; } },
    events,
    store,
    turnCountRef,
    historyRef,
    costRef,
    planStepsRef,
    clearAbort,
    writeAiTitleIfNeeded,
    options: {
      line: "prompt",
      usePlanMode: false,
      routingFailed: false,
      activeModel: "model",
      activeProvider: "provider",
      userUuid: "user-uuid",
      turnStartMs: 100,
      store,
      turnCountRef,
      historyRef,
      costRef,
      turnToolCalls: ["read_file"],
      getTurnUsage: () => ({ input_tokens: 3, output_tokens: 4 } satisfies Usage),
      writeAiTitleIfNeeded,
      setMessages: (updater) => {
        messages = typeof updater === "function" ? updater(messages) : updater;
      },
      dispatchUiEvent: (event) => events.push(event),
      onTextDelta: vi.fn(),
      captureUsage: vi.fn(),
      clearAbort,
      plan: {
        executor: vi.fn(async () => {}) as unknown as PlanExecutor,
        context: {
          adapter: {} as never,
          model: "model",
          tools: [],
          system: "system",
          signal: new AbortController().signal,
          onToolCall: async () => ({ ok: true, content: "" }),
        },
        stepsRef: planStepsRef,
        stepTextRef: planStepTextRef,
        rafRef: planRafRef,
      },
      stream: {
        agentOptions: { adapter: {} as never, model: "model" },
        streamAgentImpl: (async () => "final answer") as typeof streamAgent,
        streamingBufferRef,
        rafRef,
        toolCallHandler: vi.fn(async () => ({ ok: true, content: "" })),
      },
      ...overrides,
    } satisfies Parameters<typeof runPreparedTurn>[0],
  };
}

describe("turnRunner", () => {
  it("runs stream turns and persists successful completion", async () => {
    const base = baseOptions();

    await runPreparedTurn(base.options);

    expect(base.store.writeAssistant).toHaveBeenCalledWith(expect.objectContaining({
      parentUuid: "user-uuid",
      content: "final answer",
      model: "model",
      provider: "provider",
      usage: { input_tokens: 3, output_tokens: 4 },
      turn: 1,
      toolCalls: ["read_file"],
      status: "ok",
    }));
    expect(base.turnCountRef.current).toBe(1);
    expect(base.writeAiTitleIfNeeded).toHaveBeenCalledWith("final answer");
    expect(base.clearAbort).toHaveBeenCalled();
  });

  it("runs stream turns and persists non-abort errors plus session end", async () => {
    const base = baseOptions({
      stream: {
        agentOptions: { adapter: {} as never, model: "model" },
        streamAgentImpl: (async () => { throw new Error("boom"); }) as typeof streamAgent,
        streamingBufferRef: { current: "" },
        rafRef: { current: null },
        toolCallHandler: vi.fn(async () => ({ ok: true, content: "" })),
      },
    });

    await runPreparedTurn(base.options);

    expect(base.store.writeAssistant).toHaveBeenCalledWith(expect.objectContaining({
      content: "Error: boom",
      status: "error",
    }));
    expect(base.store.writeEnd).toHaveBeenCalledWith({ input_tokens: 1, output_tokens: 2 }, 0.1, 0, "prompt");
    expect(base.clearAbort).toHaveBeenCalled();
  });

  it("does not persist assistant error for stream aborts", async () => {
    const base = baseOptions({
      stream: {
        agentOptions: { adapter: {} as never, model: "model" },
        streamAgentImpl: (async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }) as typeof streamAgent,
        streamingBufferRef: { current: "" },
        rafRef: { current: null },
        toolCallHandler: vi.fn(async () => ({ ok: true, content: "" })),
      },
    });

    await runPreparedTurn(base.options);

    expect(base.store.writeAssistant).not.toHaveBeenCalled();
    expect(base.store.writeEnd).toHaveBeenCalled();
  });

  it("runs plan turns and persists summarized steps into history", async () => {
    const planExecutor: PlanExecutor = async (_line, _ctx, onEvent) => {
      onEvent({ type: "plan_ready", steps: [{ id: "s1", description: "Do work" }] });
      onEvent({ type: "step_start", stepIndex: 0, total: 1 });
      onEvent({ type: "step_text", delta: "done" });
      onEvent({ type: "step_done", stepIndex: 0, output: "done" });
      onEvent({ type: "plan_done" });
    };
    const base = baseOptions({
      usePlanMode: true,
      routingFailed: true,
      plan: {
        ...baseOptions().options.plan,
        executor: planExecutor,
      },
    });

    await runPreparedTurn(base.options);

    expect(base.messagesRef.current[0]).toEqual({ role: "assistant", content: "⚠ routing failed — using default model" });
    expect(base.store.writeAssistant).toHaveBeenCalledWith(expect.objectContaining({
      content: "步骤 1：Do work\ndone",
      status: "ok",
    }));
    expect(base.historyRef.current).toEqual([
      { role: "user", content: "prompt" },
      { role: "assistant", content: "步骤 1：Do work\ndone" },
    ]);
    expect(base.turnCountRef.current).toBe(1);
  });

  it("reduces plan errors without persisting assistant turn", async () => {
    const planExecutor: PlanExecutor = async () => {
      throw new Error("plan failed");
    };
    const base = baseOptions({
      usePlanMode: true,
      plan: {
        ...baseOptions().options.plan,
        executor: planExecutor,
      },
    });

    await runPreparedTurn(base.options);

    expect(base.store.writeAssistant).not.toHaveBeenCalled();
    expect(base.messagesRef.current[0]).toMatchObject({
      role: "assistant",
      content: "Error: plan failed",
      streaming: false,
      planMode: false,
    });
    expect(base.clearAbort).toHaveBeenCalled();
  });
});

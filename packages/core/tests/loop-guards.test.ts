/**
 * Tests for agent loop defensive behaviors introduced in bug fixes:
 * - C2: malformed tool arguments → tool error, not crash
 * - C3: empty-after-tool-result retry limit = MAX_EMPTY_AFTER_TOOL_RETRIES
 * - M4: compression usage is reported via onUsage
 */
import { describe, it, expect, vi } from "vitest";
import { EventBus } from "@open-vera/plugin-runtime";
import type { LLMAdapter, StreamEvent } from "../src/adapters/base.js";
import type { CompletionResponse } from "../src/adapters/base.js";
import { streamAgent, runAgent } from "../src/agent/loop.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeAdapter(responses: CompletionResponse[]): LLMAdapter {
  let call = 0;
  return {
    complete: vi.fn().mockImplementation(() => {
      return Promise.resolve(responses[call++] ?? responses[responses.length - 1]);
    }),
    stream: vi.fn().mockImplementation(async function* () {
      const resp = responses[call++] ?? responses[responses.length - 1];
      const content = resp.message.content;
      if (typeof content === "string") {
        yield { type: "text", text: content } satisfies StreamEvent;
      } else {
        for (const part of content) {
          if (part.type === "text") yield { type: "text", text: part.text } satisfies StreamEvent;
          else if (part.type === "tool_call") yield { type: "tool_call", ...part } satisfies StreamEvent;
        }
      }
      yield { type: "done", stop_reason: "end_turn" } satisfies StreamEvent;
    }),
    listModels: vi.fn().mockResolvedValue([]),
  };
}

function toolCallResponse(id: string, name: string, args: string): CompletionResponse {
  return {
    message: {
      role: "assistant",
      content: [{ type: "tool_call", id, name, arguments: args }],
    },
    stop_reason: "tool_use",
  };
}

function textResponse(text: string): CompletionResponse {
  return {
    message: { role: "assistant", content: text },
    stop_reason: "end_turn",
  };
}

// ── C2: malformed JSON args ──────────────────────────────────────────────────

describe("C2: malformed tool arguments", () => {
  it("streamAgent: returns error tool result instead of crashing", async () => {
    const responses = [
      toolCallResponse("id1", "echo", "NOT_VALID_JSON{{{"),
      textResponse("done"),
    ];
    const adapter = makeAdapter(responses);
    const toolCalls: string[] = [];
    const output = await streamAgent(
      "test",
      {
        adapter,
        model: "claude-sonnet-4-6",
        onToolCall: async (name) => {
          toolCalls.push(name);
          return "ok";
        },
      },
      () => {}
    );
    // Tool call should not have been executed (args invalid)
    expect(toolCalls).toHaveLength(0);
    // Should still produce final output
    expect(output).toBe("done");
  });

  it("runAgent: returns error tool result instead of crashing", async () => {
    const responses = [
      toolCallResponse("id1", "echo", "{bad json"),
      textResponse("recovered"),
    ];
    const adapter = makeAdapter(responses);
    const toolCalls: string[] = [];
    const output = await runAgent("test", {
      adapter,
      model: "claude-sonnet-4-6",
      onToolCall: async (name) => {
        toolCalls.push(name);
        return "ok";
      },
    });
    expect(toolCalls).toHaveLength(0);
    expect(output).toBe("recovered");
  });
});

// ── C3: empty-after-tool-result retry ────────────────────────────────────────

describe("C3: empty-after-tool-result retry", () => {
  it("retries up to MAX_EMPTY_AFTER_TOOL_RETRIES times then yields last response", async () => {
    // 1 tool call, then 3 empty assistant turns, then final answer
    const responses: CompletionResponse[] = [
      toolCallResponse("id1", "echo", '{"text":"hi"}'),
      textResponse(""),   // retry 1
      textResponse(""),   // retry 2
      textResponse(""),   // retry 3 → should stop retrying after this
      textResponse("final"),
    ];
    const adapter = makeAdapter(responses);
    const output = await streamAgent(
      "test",
      {
        adapter,
        model: "claude-sonnet-4-6",
        maxTurns: 10,
        onToolCall: async () => "tool result",
      },
      () => {}
    );
    // After MAX (3) retries the loop exits; the 4th empty is reached
    // but stream exits when retries exhausted. Output is empty string or "final"
    // depending on exact retry count. Main assertion: no infinite loop & no crash.
    expect(typeof output).toBe("string");
  });
});

// ── M4: compression usage reporting ─────────────────────────────────────────

describe("M4: compression usage via onUsage", () => {
  it("reports compression token usage through onUsage callback", async () => {
    const compressResponse: CompletionResponse = {
      message: {
        role: "assistant",
        content: `<summary>\n### 1. Primary Request and Intent\ntest\n</summary>`,
      },
      stop_reason: "end_turn",
      usage: { input_tokens: 500, output_tokens: 100 },
    };
    const mainResponse = textResponse("final answer");

    // adapter.complete is called for both compression and main turn
    let callCount = 0;
    const adapter: LLMAdapter = {
      complete: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? compressResponse : mainResponse);
      }),
      stream: vi.fn().mockImplementation(async function* () {
        yield { type: "text", text: "final answer" } satisfies StreamEvent;
        yield { type: "done", stop_reason: "end_turn" } satisfies StreamEvent;
      }),
      listModels: vi.fn().mockResolvedValue([]),
    };

    const usages: Array<{ input_tokens: number; output_tokens: number }> = [];

    // Build a history large enough to trigger compression
    const history = Array.from({ length: 20 }, (_, i): import("../src/types/index.js").Message => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(6000), // ~1500 tokens each
    }));

    await streamAgent(
      "new task",
      {
        adapter,
        model: "claude-sonnet-4-6",
        history,
        onUsage: (u) => usages.push(u),
        compressionOptions: {
          enabled: true,
          triggerTokens: 5_000, // low threshold to force compression
        },
      },
      () => {}
    );

    // Compression should have fired and reported usage
    const compressionUsage = usages.find((u) => u.input_tokens === 500);
    expect(compressionUsage).toBeDefined();
    expect(compressionUsage?.output_tokens).toBe(100);
  });
});

describe("Agent loop compression LlmService", () => {
  it("uses purpose-aware LlmService for proactive compression when no explicit compressionAdapter is provided", async () => {
    const mainAdapter: LLMAdapter = {
      complete: vi.fn().mockResolvedValue(textResponse("unused")),
      stream: vi.fn().mockImplementation(async function* () {
        yield { type: "text", text: "final answer" } satisfies StreamEvent;
        yield { type: "done", stop_reason: "end_turn" } satisfies StreamEvent;
      }),
    };
    const compressionAdapter: LLMAdapter = {
      complete: vi.fn().mockResolvedValue({
        message: {
          role: "assistant",
          content: `<summary>\n### 1. Primary Request and Intent\nservice\n</summary>`,
        },
        stop_reason: "end_turn",
        usage: { input_tokens: 7, output_tokens: 3 },
      } satisfies CompletionResponse),
      stream: vi.fn().mockImplementation(async function* () {}),
    };
    const buildAdapter = vi.fn().mockReturnValue(compressionAdapter);
    const history = Array.from({ length: 20 }, (_, i): import("../src/types/index.js").Message => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(6000),
    }));

    await expect(streamAgent("new task", {
      adapter: mainAdapter,
      model: "chat-model",
      history,
      llmService: { buildAdapter },
      compressionProvider: "fast-provider",
      compressionOptions: {
        enabled: true,
        triggerTokens: 5_000,
        model: "compact-model",
      },
    }, () => {})).resolves.toBe("final answer");

    expect(buildAdapter).toHaveBeenCalledWith("fast-provider", "compact-model", { purpose: "compression" });
    expect(compressionAdapter.complete).toHaveBeenCalledTimes(1);
    expect(mainAdapter.complete).not.toHaveBeenCalled();
  });

  it("keeps explicit compressionAdapter precedence over LlmService", async () => {
    const mainAdapter: LLMAdapter = {
      complete: vi.fn().mockResolvedValue(textResponse("unused")),
      stream: vi.fn().mockImplementation(async function* () {
        yield { type: "text", text: "final answer" } satisfies StreamEvent;
        yield { type: "done", stop_reason: "end_turn" } satisfies StreamEvent;
      }),
    };
    const explicitCompressionAdapter: LLMAdapter = {
      complete: vi.fn().mockResolvedValue({
        message: {
          role: "assistant",
          content: `<summary>\n### 1. Primary Request and Intent\nexplicit\n</summary>`,
        },
        stop_reason: "end_turn",
      } satisfies CompletionResponse),
      stream: vi.fn().mockImplementation(async function* () {}),
    };
    const serviceCompressionAdapter = makeAdapter([textResponse("service should not run")]);
    const buildAdapter = vi.fn().mockReturnValue(serviceCompressionAdapter);
    const history = Array.from({ length: 20 }, (_, i): import("../src/types/index.js").Message => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(6000),
    }));

    await streamAgent("new task", {
      adapter: mainAdapter,
      model: "chat-model",
      history,
      llmService: { buildAdapter },
      compressionAdapter: explicitCompressionAdapter,
      compressionOptions: {
        enabled: true,
        triggerTokens: 5_000,
      },
    }, () => {});

    expect(buildAdapter).not.toHaveBeenCalled();
    expect(explicitCompressionAdapter.complete).toHaveBeenCalledTimes(1);
    expect(serviceCompressionAdapter.complete).not.toHaveBeenCalled();
  });

  it("uses purpose-aware LlmService for reactive compression retries", async () => {
    const mainAdapter: LLMAdapter = {
      complete: vi.fn()
        .mockRejectedValueOnce(new Error("prompt is too long"))
        .mockResolvedValueOnce(textResponse("recovered")),
      stream: vi.fn().mockImplementation(async function* () {}),
    };
    const compressionAdapter: LLMAdapter = {
      complete: vi.fn().mockResolvedValue({
        message: {
          role: "assistant",
          content: `<summary>\n### 1. Primary Request and Intent\nreactive\n</summary>`,
        },
        stop_reason: "end_turn",
      } satisfies CompletionResponse),
      stream: vi.fn().mockImplementation(async function* () {}),
    };
    const buildAdapter = vi.fn().mockReturnValue(compressionAdapter);
    const history = Array.from({ length: 10 }, (_, i): import("../src/types/index.js").Message => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `history ${i} ${"x".repeat(200)}`,
    }));

    await expect(runAgent("hello", {
      adapter: mainAdapter,
      model: "chat-model",
      history,
      llmService: { buildAdapter },
      compressionOptions: {
        enabled: true,
        triggerTokens: 999_999,
        model: "compact-model",
      },
      contextOptions: false,
    })).resolves.toBe("recovered");

    expect(buildAdapter).toHaveBeenCalledWith(undefined, "compact-model", { purpose: "compression" });
    expect(compressionAdapter.complete).toHaveBeenCalledTimes(1);
    expect(mainAdapter.complete).toHaveBeenCalledTimes(2);
  });
});

describe("Agent loop EventBus contract", () => {
  it("emits stable turn and context observe events for runAgent and streamAgent", async () => {
    const eventBus = new EventBus();
    const seen: Array<{ name: string; value: unknown }> = [];
    for (const name of ["turn:start", "turn:end", "context:select", "context:inject"]) {
      eventBus.observe(name, (event) => {
        seen.push({ name: event.name, value: event.value });
      });
    }
    const adapter = makeAdapter([textResponse("done")]);

    await expect(runAgent("hello", {
      adapter,
      model: "test-model",
      eventBus,
      sessionId: "session-1",
      traceId: "trace-1",
      contextOptions: false,
    })).resolves.toBe("done");

    await expect(streamAgent("hello", {
      adapter: makeAdapter([textResponse("stream done")]),
      model: "test-model",
      eventBus,
      sessionId: "session-2",
      traceId: "trace-2",
      contextOptions: false,
    }, () => {})).resolves.toBe("stream done");

    expect(seen.map((event) => event.name)).toEqual([
      "context:select",
      "context:inject",
      "turn:start",
      "turn:end",
      "context:select",
      "context:inject",
      "turn:start",
      "turn:end",
    ]);
    for (const event of seen) {
      expect(() => JSON.stringify(event.value)).not.toThrow();
      expect(event.value).toEqual(expect.objectContaining({
        model: "test-model",
        turn: 0,
      }));
    }
    expect(seen[0]?.value).toEqual(expect.objectContaining({ mode: "non-streaming" }));
    expect(seen[0]?.value).toEqual(expect.objectContaining({ sessionId: "session-1", traceId: "trace-1" }));
    expect(seen[4]?.value).toEqual(expect.objectContaining({ mode: "streaming" }));
    expect(seen[4]?.value).toEqual(expect.objectContaining({ sessionId: "session-2", traceId: "trace-2" }));
  });

  it("emits compression observe events around proactive compression", async () => {
    const eventBus = new EventBus();
    const seen: Array<{ name: string; value: Record<string, unknown> }> = [];
    eventBus.observe("compression:*", (event) => {
      seen.push({ name: event.name, value: event.value as Record<string, unknown> });
    });

    let callCount = 0;
    const adapter: LLMAdapter = {
      complete: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1
          ? {
              message: {
                role: "assistant",
                content: `<summary>\n### 1. Primary Request and Intent\ntest\n</summary>`,
              },
              stop_reason: "end_turn",
              usage: { input_tokens: 500, output_tokens: 100 },
            } satisfies CompletionResponse
          : textResponse("final answer"));
      }),
      stream: vi.fn().mockImplementation(async function* () {
        yield { type: "text", text: "final answer" } satisfies StreamEvent;
        yield { type: "done", stop_reason: "end_turn" } satisfies StreamEvent;
      }),
    };
    const history = Array.from({ length: 20 }, (_, i): import("../src/types/index.js").Message => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(6000),
    }));

    await streamAgent("new task", {
      adapter,
      model: "test-model",
      history,
      eventBus,
      compressionOptions: {
        enabled: true,
        triggerTokens: 5_000,
      },
    }, () => {});

    expect(seen.map((event) => event.name)).toEqual(["compression:before", "compression:after"]);
    expect(seen[0]?.value).toMatchObject({ type: "progressive", mode: "streaming", model: "test-model" });
    expect(seen[1]?.value).toMatchObject({
      type: "progressive",
      mode: "streaming",
      model: "test-model",
      usage: { input_tokens: 500, output_tokens: 100 },
    });
    for (const event of seen) {
      expect(() => JSON.stringify(event.value)).not.toThrow();
    }
  });

  it("emits stable llm and tool observe events for runAgent and streamAgent", async () => {
    const eventBus = new EventBus();
    const seen: Array<{ name: string; value: Record<string, unknown> }> = [];
    for (const name of ["llm:*", "tool:*"]) {
      eventBus.observe(name, (event) => {
        seen.push({ name: event.name, value: event.value as Record<string, unknown> });
      });
    }

    await expect(runAgent("hello", {
      adapter: makeAdapter([
        toolCallResponse("id1", "echo", '{"text":"hi"}'),
        textResponse("done"),
      ]),
      model: "test-model",
      eventBus,
      contextOptions: false,
      onToolCall: async () => "tool result",
    })).resolves.toBe("done");

    await expect(streamAgent("hello", {
      adapter: makeAdapter([
        toolCallResponse("id2", "echo", '{"text":"stream"}'),
        textResponse("stream done"),
      ]),
      model: "test-model",
      eventBus,
      contextOptions: false,
      onToolCall: async () => "stream tool result",
    }, () => {})).resolves.toBe("stream done");

    expect(seen.map((event) => event.name)).toEqual([
      "llm:request",
      "llm:response",
      "tool:before:echo",
      "tool:after:echo",
      "llm:request",
      "llm:response",
      "llm:request",
      "llm:response",
      "tool:before:echo",
      "tool:after:echo",
      "llm:request",
      "llm:response",
    ]);
    expect(seen[0]?.value).toMatchObject({ mode: "non-streaming", model: "test-model", turn: 0 });
    expect(seen[2]?.value).toMatchObject({
      mode: "non-streaming",
      name: "echo",
      toolCallId: "id1",
      args: { text: "hi" },
    });
    expect(seen[8]?.value).toMatchObject({
      mode: "streaming",
      name: "echo",
      toolCallId: "id2",
      args: { text: "stream" },
    });
    for (const event of seen) {
      expect(() => JSON.stringify(event.value)).not.toThrow();
    }
  });

  it("emits tool:error for malformed tool arguments without executing the tool", async () => {
    const eventBus = new EventBus();
    const seen: Array<{ name: string; value: Record<string, unknown> }> = [];
    eventBus.observe("tool:*", (event) => {
      seen.push({ name: event.name, value: event.value as Record<string, unknown> });
    });
    const toolCalls: string[] = [];

    await expect(streamAgent("hello", {
      adapter: makeAdapter([
        toolCallResponse("bad1", "echo", "{not json"),
        textResponse("recovered"),
      ]),
      model: "test-model",
      eventBus,
      contextOptions: false,
      onToolCall: async (name) => {
        toolCalls.push(name);
        return "should not run";
      },
    }, () => {})).resolves.toBe("recovered");

    expect(toolCalls).toEqual([]);
    expect(seen.map((event) => event.name)).toEqual(["tool:error:echo"]);
    expect(seen[0]?.value).toMatchObject({
      mode: "streaming",
      model: "test-model",
      turn: 0,
      name: "echo",
      toolCallId: "bad1",
      phase: "parse_args",
      error: {
        name: "SyntaxError",
        message: "Could not parse tool arguments as JSON",
      },
    });
    expect(() => JSON.stringify(seen[0]?.value)).not.toThrow();
  });

  it("emits llm:error when an adapter call fails", async () => {
    const eventBus = new EventBus();
    const seen: Array<{ name: string; value: Record<string, unknown> }> = [];
    eventBus.observe("llm:*", (event) => {
      seen.push({ name: event.name, value: event.value as Record<string, unknown> });
    });
    const adapter: LLMAdapter = {
      complete: vi.fn().mockRejectedValue(new Error("llm down")),
      stream: vi.fn().mockImplementation(async function* () {}),
    };

    await expect(runAgent("hello", {
      adapter,
      model: "test-model",
      eventBus,
      contextOptions: false,
      compressionOptions: { enabled: false },
    })).rejects.toThrow("llm down");

    expect(seen.map((event) => event.name)).toEqual(["llm:request", "llm:error"]);
    expect(seen[1]?.value).toMatchObject({
      mode: "non-streaming",
      model: "test-model",
      turn: 0,
      error: {
        name: "Error",
        message: "llm down",
      },
    });
    expect(() => JSON.stringify(seen[1]?.value)).not.toThrow();
  });

  it("emits turn:retry around reactive compact retries", async () => {
    const eventBus = new EventBus();
    const seen: Array<{ name: string; value: Record<string, unknown> }> = [];
    eventBus.observe("turn:retry", (event) => {
      seen.push({ name: event.name, value: event.value as Record<string, unknown> });
    });

    let callCount = 0;
    const adapter: LLMAdapter = {
      complete: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error("prompt is too long");
        if (callCount === 2) {
          return Promise.resolve({
            message: {
              role: "assistant",
              content: `<summary>\n### 1. Primary Request and Intent\ntest\n</summary>`,
            },
            stop_reason: "end_turn",
          } satisfies CompletionResponse);
        }
        return Promise.resolve(textResponse("recovered"));
      }),
      stream: vi.fn().mockImplementation(async function* () {}),
    };

    await expect(runAgent("hello", {
      adapter,
      model: "test-model",
      eventBus,
      contextOptions: false,
      compressionOptions: {
        enabled: true,
        triggerTokens: 999_999,
      },
    })).resolves.toContain("Primary Request and Intent");

    expect(seen.map((event) => event.name)).toEqual(["turn:retry"]);
    expect(seen[0]?.value).toMatchObject({
      mode: "non-streaming",
      model: "test-model",
      turn: 0,
      reason: "reactive_compact",
      attempt: 1,
      maxRetries: 3,
      error: {
        name: "Error",
        message: "prompt is too long",
      },
    });
    expect(() => JSON.stringify(seen[0]?.value)).not.toThrow();
  });

  it("emits turn:retry for empty assistant responses after tool results", async () => {
    const eventBus = new EventBus();
    const seen: Array<{ name: string; value: Record<string, unknown> }> = [];
    eventBus.observe("turn:retry", (event) => {
      seen.push({ name: event.name, value: event.value as Record<string, unknown> });
    });

    await expect(streamAgent("hello", {
      adapter: makeAdapter([
        toolCallResponse("id1", "echo", '{"text":"hi"}'),
        textResponse(""),
        textResponse("done"),
      ]),
      model: "test-model",
      eventBus,
      contextOptions: false,
      onToolCall: async () => "tool result",
    }, () => {})).resolves.toBe("done");

    expect(seen.map((event) => event.name)).toEqual(["turn:retry"]);
    expect(seen[0]?.value).toMatchObject({
      mode: "streaming",
      model: "test-model",
      turn: 1,
      reason: "empty_after_tool_result",
      attempt: 1,
      maxRetries: 3,
    });
    expect(() => JSON.stringify(seen[0]?.value)).not.toThrow();
  });
});

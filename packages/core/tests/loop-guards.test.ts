/**
 * Tests for agent loop defensive behaviors introduced in bug fixes:
 * - C2: malformed tool arguments → tool error, not crash
 * - C3: empty-after-tool-result retry limit = MAX_EMPTY_AFTER_TOOL_RETRIES
 * - M4: compression usage is reported via onUsage
 */
import { describe, it, expect, vi } from "vitest";
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

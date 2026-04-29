import { describe, expect, it, vi } from "vitest";
import type { LLMAdapter } from "../src/adapters/base.js";
import { streamAgent } from "../src/agent/loop.js";

/**
 * REPL loop smoke — verifies the agent tool-loop doesn't silently stop
 * at an empty assistant response after receiving tool results.
 *
 * Covers the empty-after-tool recovery path in loop.ts (lines 630-644):
 *   - MAX_EMPTY_AFTER_TOOL_RETRIES = 3
 *   - Synthetic user prompt is injected on each retry
 *   - Loop exits cleanly after retries are exhausted
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStreamAdapter(
  sequences: Array<Array<{ type: "text"; text: string } | { type: "tool_call"; id: string; name: string; arguments: string } | { type: "done"; stop_reason: string }>>,
): LLMAdapter {
  let callIndex = 0;
  return {
    complete: async () => {
      throw new Error("not used in streamAgent");
    },
    stream: async function* () {
      const events = sequences[callIndex] ?? [];
      callIndex++;
      for (const event of events) {
        yield event as never;
      }
    },
  };
}

function toolCallEvent(id: string, name: string, args: Record<string, unknown>) {
  return { type: "tool_call" as const, id, name, arguments: JSON.stringify(args) };
}

function textEvent(text: string) {
  return { type: "text" as const, text };
}

function doneEvent(stopReason: string) {
  return { type: "done" as const, stop_reason: stopReason };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("REPL loop smoke", () => {
  it("completes normally: tool call → tool result → text response", async () => {
    const adapter = makeStreamAdapter([
      // Turn 0: LLM calls a tool
      [toolCallEvent("tc-1", "echo", { value: "hello" }), doneEvent("tool_use")],
      // Turn 1: LLM responds with text (no more tools)
      [textEvent("echo result: hello"), doneEvent("end_turn")],
    ]);

    const result = await streamAgent(
      "say hello",
      {
        adapter,
        model: "test-model",
        tools: [],
        onToolCall: async (name, args) => {
          if (name === "echo") return String(args.value);
          return "ok";
        },
        contextOptions: false,
      },
      () => {},
    );

    expect(result).toBe("echo result: hello");
  });

  it("recovers from empty-after-tool via synthetic retry prompt", async () => {
    let emptyTurns = 0;

    const adapter: LLMAdapter = {
      complete: async () => {
        throw new Error("not used");
      },
      stream: async function* (request) {
        const msgCount = request.messages.length;
        // Turn 0: call a tool
        if (msgCount <= 2) {
          yield toolCallEvent("tc-1", "echo", { value: "hi" });
          yield doneEvent("tool_use");
          return;
        }
        // Subsequent turns: return empty text until we see the synthetic
        // retry prompt enough times, then respond with real text.
        emptyTurns++;
        if (emptyTurns >= 3) {
          yield textEvent("recovered after retries");
        }
        yield doneEvent("end_turn");
      },
    };

    const result = await streamAgent(
      "test empty recovery",
      {
        adapter,
        model: "test-model",
        tools: [],
        onToolCall: async () => "tool result",
        contextOptions: false,
      },
      () => {},
    );

    // The loop should have retried via synthetic prompt and eventually recovered
    expect(result).toBe("recovered after retries");
    expect(emptyTurns).toBeGreaterThanOrEqual(3);
  });

  it("exits cleanly after max empty-after-tool retries are exhausted", async () => {
    const adapter: LLMAdapter = {
      complete: async () => {
        throw new Error("not used");
      },
      stream: async function* (request) {
        const msgCount = request.messages.length;
        // Turn 0: call a tool
        if (msgCount <= 2) {
          yield toolCallEvent("tc-1", "echo", { value: "hi" });
          yield doneEvent("tool_use");
          return;
        }
        // All subsequent turns: empty text, no tool calls
        yield doneEvent("end_turn");
      },
    };

    const result = await streamAgent(
      "test exhaustion",
      {
        adapter,
        model: "test-model",
        tools: [],
        onToolCall: async () => "tool result",
        contextOptions: false,
      },
      () => {},
    );

    // After MAX_EMPTY_AFTER_TOOL_RETRIES (3) retries, loop exits with ""
    expect(result).toBe("");
  });

  it("does not retry empty response when there were no prior tool results", async () => {
    const adapter = makeStreamAdapter([
      // Single turn: empty text, no tools, no prior tool results
      [doneEvent("end_turn")],
    ]);

    const result = await streamAgent(
      "just empty",
      {
        adapter,
        model: "test-model",
        tools: [],
        contextOptions: false,
      },
      () => {},
    );

    // Should exit immediately — no retry since there were no tool results
    expect(result).toBe("");
  });
});

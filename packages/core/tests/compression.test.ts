import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMAdapter, CompletionResponse } from "../src/adapters/base.js";
import type { Message } from "../src/types/index.js";
import {
  compressMessages,
  createCompressionState,
  findRelevantSegments,
  expandSegment,
  microCompact,
  createMicroCompactState,
  isPromptTooLongError,
} from "../src/context/compression.js";
import type {
  CompressionOptions,
  CompressionState,
  MicroCompactState,
} from "../src/context/compression.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMockAdapter(
  responseText: string,
): LLMAdapter {
  const response: CompletionResponse = {
    message: { role: "assistant", content: responseText },
    stop_reason: "end_turn",
  };
  return {
    complete: vi.fn().mockResolvedValue(response),
    stream: vi.fn(),
  };
}

function makeMockAdapterFail(): LLMAdapter {
  return {
    complete: vi.fn().mockRejectedValue(new Error("API error")),
    stream: vi.fn(),
  };
}

const defaultOpts: CompressionOptions = {
  enabled: true,
  triggerTokens: 500,
  keepRecentTurns: 2,
};

/** Build a messages array with N user-assistant turn pairs. */
function makeTurnPair(userText: string, asstText: string): [Message, Message] {
  return [
    { role: "user", content: userText },
    { role: "assistant", content: asstText },
  ];
}

function longText(base: string, targetTokens: number): string {
  // ~4 chars per token => targetTokens * 4 chars
  return base.repeat(Math.ceil((targetTokens * 4) / base.length));
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("compressMessages", () => {
  let adapter: ReturnType<typeof makeMockAdapter>;

  const compressionJson = JSON.stringify({
    summary: "User asked to add auth. Created login.ts with OAuth flow. Tests passing.",
    decisions: ["Use OAuth 2.0 with PKCE", "Store tokens in secure cookie"],
    findings: ["Express middleware needed for token refresh"],
    pending: ["Add rate limiting", "Write integration tests"],
  });

  beforeEach(() => {
    adapter = makeMockAdapter(compressionJson);
  });

  it("does nothing when disabled", async () => {
    const messages: Message[] = [
      ...makeTurnPair("hello", "hi!"),
      ...makeTurnPair("do stuff", "ok"),
    ];
    const opts: CompressionOptions = { enabled: false, keepRecentTurns: 1, triggerTokens: 1 };
    const state = createCompressionState();

    const result = await compressMessages(messages, state, opts, adapter, "claude-sonnet-4-6");

    expect(result.messages).toBe(messages);
    expect(result.state.segments).toHaveLength(0);
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  it("does nothing when under token threshold", async () => {
    const messages: Message[] = [
      ...makeTurnPair("hi", "hello!"),
    ];
    const state = createCompressionState();

    const result = await compressMessages(messages, state, defaultOpts, adapter, "claude-sonnet-4-6");

    expect(result.messages).toBe(messages);
    expect(result.state.segments).toHaveLength(0);
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  it("does nothing when not enough turns to compress", async () => {
    // 4 total turns, keepRecentTurns=3 => only 1 turn to compress (needs 2+)
    const opts: CompressionOptions = { enabled: true, triggerTokens: 1, keepRecentTurns: 3 };
    const messages: Message[] = [
      ...makeTurnPair("turn 1 ask", "turn 1 answer"),
      ...makeTurnPair("turn 2 ask", "turn 2 answer"),
    ];
    const state = createCompressionState();

    const result = await compressMessages(messages, state, opts, adapter, "claude-sonnet-4-6");

    // 2 total turns, keepRecent=3 => 2 <= 3 => "Need at least keepRecentTurns + 2"
    expect(result.state.segments).toHaveLength(0);
  });

  it("compresses old turns when over threshold", async () => {
    // Create 5 turn pairs (10 messages). keepRecent=2 => 3 old turns compress, 2 kept.
    const longMsg = longText("Some long text to push token count up. ", 100);
    const messages: Message[] = [
      { role: "user", content: longMsg },
      { role: "assistant", content: longMsg },
      { role: "user", content: longMsg },
      { role: "assistant", content: longMsg },
      { role: "user", content: longMsg },
      { role: "assistant", content: longMsg },
      { role: "user", content: "recent question 1" },
      { role: "assistant", content: "recent answer 1" },
      { role: "user", content: "recent question 2" },
      { role: "assistant", content: "recent answer 2" },
    ];
    const state = createCompressionState();

    const result = await compressMessages(messages, state, defaultOpts, adapter, "claude-sonnet-4-6");

    // Should have called LLM for compression
    expect(adapter.complete).toHaveBeenCalledTimes(1);

    // Should have compressed the old turns
    expect(result.state.segments.length).toBe(1);
    expect(result.state.segments[0]!.summary).toContain("auth");
    expect(result.state.segments[0]!.decisions).toHaveLength(2);
    expect(result.state.segments[0]!.findings).toHaveLength(1);
    expect(result.state.segments[0]!.pending).toHaveLength(2);

    // Result should have fewer messages (compressed old + recent)
    expect(result.messages.length).toBeLessThan(messages.length);

    // First message should be the synthetic compressed context
    expect(result.messages[0]!.role).toBe("user");
    const firstContent = typeof result.messages[0]!.content === "string"
      ? (result.messages[0]!.content as string)
      : "";
    expect(firstContent).toContain("Compressed context");
    expect(firstContent).toContain("auth");

    // Recent turns should be preserved
    const lastFour = result.messages.slice(-4);
    expect(lastFour[0]!.role).toBe("user");
    expect(lastFour[1]!.role).toBe("assistant");
    expect(lastFour[2]!.role).toBe("user");
    expect(lastFour[3]!.role).toBe("assistant");
    expect(
      typeof lastFour[2]!.content === "string" ? lastFour[2]!.content : ""
    ).toBe("recent question 2");
  });

  it("falls back gracefully when LLM call fails", async () => {
    const failAdapter = makeMockAdapterFail();
    const longMsg = longText("data. ", 200);
    const messages: Message[] = [
      { role: "user", content: longMsg },
      { role: "assistant", content: longMsg },
      { role: "user", content: longMsg },
      { role: "assistant", content: longMsg },
      { role: "user", content: "recent q1" },
      { role: "assistant", content: "recent a1" },
      { role: "user", content: "recent q2" },
      { role: "assistant", content: "recent a2" },
    ];
    const state = createCompressionState();

    const result = await compressMessages(messages, state, defaultOpts, failAdapter, "claude-sonnet-4-6");

    // Should return original messages unchanged on failure
    expect(result.messages).toBe(messages);
    expect(result.state.segments).toHaveLength(0);
  });

  it("handles raw text fallback when JSON parse fails", async () => {
    const adapter2 = makeMockAdapter("This is just plain text, no JSON at all.");
    const longMsg = longText("x", 200);
    const messages: Message[] = [
      ...makeTurnPair(longMsg, longMsg),
      ...makeTurnPair(longMsg, longMsg),
      ...makeTurnPair("q1", "a1"),
      ...makeTurnPair("q2", "a2"),
    ];
    const state = createCompressionState();

    const result = await compressMessages(messages, state, defaultOpts, adapter2, "claude-sonnet-4-6");

    expect(result.state.segments.length).toBe(1);
    expect(result.state.segments[0]!.summary).toContain("plain text");
  });

  it("handles JSON inside markdown fence", async () => {
    const fencedJson = "```json\n" + JSON.stringify({
      summary: "Fenced summary",
      decisions: ["D1"],
      findings: [],
      pending: [],
    }) + "\n```";
    const adapter2 = makeMockAdapter(fencedJson);
    const longMsg = longText("y", 200);
    const messages: Message[] = [
      ...makeTurnPair(longMsg, longMsg),
      ...makeTurnPair(longMsg, longMsg),
      ...makeTurnPair("q1", "a1"),
      ...makeTurnPair("q2", "a2"),
    ];
    const state = createCompressionState();

    const result = await compressMessages(messages, state, defaultOpts, adapter2, "claude-sonnet-4-6");

    expect(result.state.segments.length).toBe(1);
    expect(result.state.segments[0]!.summary).toBe("Fenced summary");
  });

  it("tracks original token count in segment", async () => {
    const longMsg = longText("z", 100);
    const messages: Message[] = [
      ...makeTurnPair(longMsg, longMsg),
      ...makeTurnPair(longMsg, longMsg),
      ...makeTurnPair(longMsg, longMsg),
      ...makeTurnPair("keep1", "keep1"),
      ...makeTurnPair("keep2", "keep2"),
    ];
    const state = createCompressionState();

    const result = await compressMessages(messages, state, defaultOpts, adapter, "claude-sonnet-4-6");

    expect(result.state.segments[0]!.originalTokenCount).toBeGreaterThan(0);
  });
});

describe("findRelevantSegments", () => {
  it("finds segments matching query", () => {
    const state: CompressionState = {
      segments: [
        {
          summary: "Set up React project with Vite",
          decisions: ["Use TypeScript", "Use React Router v7"],
          findings: ["Vite HMR is fast", "CSS modules work"],
          pending: [],
          turnRange: { start: 0, end: 3 },
          originalTokenCount: 5000,
        },
        {
          summary: "Added authentication with OAuth",
          decisions: ["Use PKCE flow"],
          findings: ["Token refresh needed"],
          pending: ["Add logout"],
          turnRange: { start: 4, end: 7 },
          originalTokenCount: 3000,
        },
      ],
    };

    const results = findRelevantSegments(state, "auth");
    expect(results).toHaveLength(1);
    expect(results[0]!.summary).toContain("authentication");
  });

  it("returns empty when no match", () => {
    const state: CompressionState = {
      segments: [
        {
          summary: "Set up React project",
          decisions: ["Use TypeScript"],
          findings: [],
          pending: [],
          turnRange: { start: 0, end: 2 },
          originalTokenCount: 1000,
        },
      ],
    };

    expect(findRelevantSegments(state, "postgres")).toHaveLength(0);
  });

  it("sorts by relevance", () => {
    const state: CompressionState = {
      segments: [
        {
          summary: "Added tests for auth",
          decisions: ["Jest"],
          findings: [],
          pending: [],
          turnRange: { start: 0, end: 2 },
          originalTokenCount: 1000,
        },
        {
          summary: "Auth system with OAuth and tests",
          decisions: ["OAuth"],
          findings: [],
          pending: [],
          turnRange: { start: 3, end: 5 },
          originalTokenCount: 1000,
        },
      ],
    };

    const results = findRelevantSegments(state, "auth");
    expect(results).toHaveLength(2);
    // Second segment mentions "auth" twice, should be first
    expect(results[0]!.summary).toContain("Auth system");
  });
});

describe("expandSegment", () => {
  it("returns original messages for a segment", () => {
    const originalMessages: Message[] = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
      { role: "user", content: "msg3" },
      { role: "assistant", content: "msg4" },
    ];
    const state: CompressionState = {
      segments: [
        {
          summary: "First two turns",
          decisions: [],
          findings: [],
          pending: [],
          turnRange: { start: 0, end: 1 },
          originalTokenCount: 100,
        },
      ],
    };

    const expanded = expandSegment(state, 0, originalMessages);
    expect(expanded).toHaveLength(2);
    expect(expanded![0]!.content).toBe("msg1");
    expect(expanded![1]!.content).toBe("msg2");
  });

  it("returns null for out-of-bounds index", () => {
    const state: CompressionState = { segments: [] };
    expect(expandSegment(state, 0, [])).toBeNull();
  });
});

describe("createCompressionState", () => {
  it("returns empty state", () => {
    const state = createCompressionState();
    expect(state.segments).toEqual([]);
  });
});

// ── Micro-compact ─────────────────────────────────────────────────────────

describe("microCompact", () => {
  it("does nothing when disabled", () => {
    const messages: Message[] = [
      { role: "assistant", content: "did things" },
      { role: "tool", tool_call_id: "1", content: "large result" },
    ];
    const state = createMicroCompactState();
    const result = microCompact(messages, state, { enabled: false });
    expect(result.messages).toBe(messages);
  });

  it("does nothing when gap is below threshold", () => {
    const messages: Message[] = [
      { role: "assistant", content: "just happened" },
      { role: "tool", tool_call_id: "1", content: "result" },
    ];
    const state: MicroCompactState = {
      toolUseIds: ["1"],
      lastAssistantTs: Date.now(), // just now
    };
    const result = microCompact(messages, state, {
      enabled: true,
      gapThresholdMinutes: 60,
      keepRecent: 5,
    });
    expect(result.messages[1]!.content).toBe("result");
  });

  it("clears old tool results when gap exceeds threshold", () => {
    const messages: Message[] = [
      { role: "assistant", content: "old turn" },
      { role: "tool", tool_call_id: "old-1", content: "old result" },
      { role: "tool", tool_call_id: "old-2", content: "another old" },
    ];
    const state: MicroCompactState = {
      toolUseIds: ["old-1", "old-2"],
      // Timestamp from 90 minutes ago
      lastAssistantTs: Date.now() - 90 * 60 * 1000,
    };
    const result = microCompact(messages, state, {
      enabled: true,
      gapThresholdMinutes: 60,
      keepRecent: 0, // keep none
    });

    expect(result.messages[1]!.content).toBe("[Old tool result content cleared]");
    expect(result.messages[2]!.content).toBe("[Old tool result content cleared]");
  });

  it("keeps recent tool results", () => {
    const messages: Message[] = [
      { role: "assistant", content: "turn" },
      { role: "tool", tool_call_id: "old", content: "old" },
      { role: "tool", tool_call_id: "recent", content: "recent" },
    ];
    const state: MicroCompactState = {
      toolUseIds: ["old", "recent"],
      lastAssistantTs: Date.now() - 90 * 60 * 1000,
    };
    const result = microCompact(messages, state, {
      enabled: true,
      gapThresholdMinutes: 60,
      keepRecent: 1,
    });

    expect(result.messages[1]!.content).toBe("[Old tool result content cleared]");
    expect(result.messages[2]!.content).toBe("recent");
  });

  it("does not double-clear already cleared results", () => {
    const messages: Message[] = [
      { role: "assistant", content: "turn" },
      { role: "tool", tool_call_id: "a", content: "[Old tool result content cleared]" },
    ];
    const state: MicroCompactState = {
      toolUseIds: ["a"],
      lastAssistantTs: Date.now() - 90 * 60 * 1000,
    };
    const result = microCompact(messages, state, {
      enabled: true,
      gapThresholdMinutes: 60,
      keepRecent: 0,
    });
    // Should not have double-applied sentinel
    expect(result.messages[1]!.content).toBe("[Old tool result content cleared]");
  });
});

// ── Reactive compact ──────────────────────────────────────────────────────

describe("isPromptTooLongError", () => {
  it("matches Anthropic API error", () => {
    expect(isPromptTooLongError(new Error("Prompt is too long"))).toBe(true);
  });

  it("matches Vertex API error", () => {
    expect(isPromptTooLongError(new Error("PROMPT IS TOO LONG"))).toBe(true);
  });

  it("matches token count error", () => {
    expect(isPromptTooLongError(new Error("prompt is too long: 250000 tokens > 200000"))).toBe(true);
  });

  it("matches context length error", () => {
    expect(isPromptTooLongError(new Error("context length exceeds limit"))).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isPromptTooLongError(new Error("rate limit exceeded"))).toBe(false);
    expect(isPromptTooLongError(new Error("invalid API key"))).toBe(false);
  });

  it("rejects non-Error values", () => {
    expect(isPromptTooLongError("string error")).toBe(false);
    expect(isPromptTooLongError(null)).toBe(false);
    expect(isPromptTooLongError(undefined)).toBe(false);
  });
});

describe("createMicroCompactState", () => {
  it("returns empty state", () => {
    const state = createMicroCompactState();
    expect(state.toolUseIds).toEqual([]);
    expect(state.lastAssistantTs).toBe(0);
  });
});

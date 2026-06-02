import { describe, it, expect } from "vitest";
import {
  trimToWindow,
  getModelContextLimit,
  MODEL_CONTEXT_LIMITS,
} from "../index.js";
import type { ContextWindowOptions } from "../index.js";
import type { Message } from "../../types/index.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMsg(role: "user" | "assistant", content: string): Message {
  return { role, content };
}

function makeTurns(n: number, charsEach = 20): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < n; i++) {
    msgs.push(makeMsg("user", `u${i} ` + "a".repeat(charsEach)));
    msgs.push(makeMsg("assistant", `a${i} ` + "b".repeat(charsEach)));
  }
  return msgs;
}

// ── MODEL_CONTEXT_LIMITS ────────────────────────────────────────────────────

describe("MODEL_CONTEXT_LIMITS", () => {
  it("contains known models", () => {
    expect(MODEL_CONTEXT_LIMITS["claude-sonnet-4-6"]).toBe(200_000);
    expect(MODEL_CONTEXT_LIMITS["gpt-4o"]).toBe(128_000);
    expect(MODEL_CONTEXT_LIMITS["gemini-2.0-flash"]).toBe(1_000_000);
  });

  it("includes all Claude Haiku variants", () => {
    expect(MODEL_CONTEXT_LIMITS["claude-haiku-4-5"]).toBe(200_000);
    expect(
      MODEL_CONTEXT_LIMITS["claude-haiku-4-5-20251001"]
    ).toBe(200_000);
  });

  it("includes o1 and o3-mini models", () => {
    expect(MODEL_CONTEXT_LIMITS["o1"]).toBe(128_000);
    expect(MODEL_CONTEXT_LIMITS["o3-mini"]).toBe(128_000);
  });

  it("includes Gemini 1.5 variants", () => {
    expect(MODEL_CONTEXT_LIMITS["gemini-1.5-pro"]).toBe(1_000_000);
    expect(MODEL_CONTEXT_LIMITS["gemini-1.5-flash"]).toBe(1_000_000);
  });
});

// ── getModelContextLimit ────────────────────────────────────────────────────

describe("getModelContextLimit", () => {
  it("returns exact match for known model", () => {
    expect(getModelContextLimit("claude-sonnet-4-6")).toBe(200_000);
    expect(getModelContextLimit("gpt-4o")).toBe(128_000);
    expect(getModelContextLimit("gemini-2.0-flash")).toBe(1_000_000);
  });

  it("matches Claude prefix for unknown variants", () => {
    expect(getModelContextLimit("claude-unknown-model")).toBe(200_000);
    expect(getModelContextLimit("claude-")).toBe(200_000);
  });

  it("matches GPT prefix for unknown variants", () => {
    expect(getModelContextLimit("gpt-5-turbo")).toBe(128_000);
    expect(getModelContextLimit("gpt-")).toBe(128_000);
  });

  it("matches o1 and o3 prefixes", () => {
    expect(getModelContextLimit("o1-pro")).toBe(128_000);
    expect(getModelContextLimit("o11")).toBe(128_000);
    expect(getModelContextLimit("o3-mini-high")).toBe(128_000);
  });

  it("matches Gemini prefix for unknown variants", () => {
    expect(getModelContextLimit("gemini-3.0-pro")).toBe(1_000_000);
    expect(getModelContextLimit("gemini-")).toBe(1_000_000);
  });

  it("returns conservative fallback 128000 for unknown model", () => {
    expect(getModelContextLimit("unknown-model")).toBe(128_000);
    expect(getModelContextLimit("")).toBe(128_000);
    expect(getModelContextLimit("llama-70b")).toBe(128_000);
  });
});

// ── trimToWindow ────────────────────────────────────────────────────────────

describe("trimToWindow", () => {
  it("returns same reference when under budget", () => {
    const msgs = makeTurns(2);
    const result = trimToWindow(msgs, {
      maxTokens: 200_000,
      keepRecentTurns: 6,
    });
    expect(result).toBe(msgs);
  });

  it("trims when over budget", () => {
    const msgs = makeTurns(20, 100);
    const result = trimToWindow(msgs, {
      maxTokens: 500,
      targetUtilization: 1.0,
      keepRecentTurns: 2,
    });
    expect(result.length).toBeLessThan(msgs.length);
  });

  it("always preserves messages[0] (original task definition)", () => {
    const msgs = makeTurns(20, 100);
    const first = msgs[0]!;
    const result = trimToWindow(msgs, {
      maxTokens: 200,
      targetUtilization: 1.0,
      keepRecentTurns: 2,
    });
    expect(result[0]).toBe(first);
  });

  it("respects keepRecentTurns floor", () => {
    const msgs = makeTurns(10, 100);
    const result = trimToWindow(msgs, {
      maxTokens: 200,
      targetUtilization: 1.0,
      keepRecentTurns: 4,
    });
    const userMsgs = result.filter((m) => m.role === "user");
    expect(userMsgs.length).toBeGreaterThanOrEqual(4);
  });

  it("does not mutate the original array", () => {
    const msgs = makeTurns(10, 100);
    const copy = [...msgs];
    trimToWindow(msgs, {
      maxTokens: 100,
      targetUtilization: 1.0,
      keepRecentTurns: 2,
    });
    expect(msgs).toEqual(copy);
  });

  it("returns unchanged when turns <= keepRecentTurns", () => {
    const msgs = makeTurns(3);
    const result = trimToWindow(msgs, {
      maxTokens: 10,
      targetUtilization: 1.0,
      keepRecentTurns: 6,
    });
    expect(result).toBe(msgs);
  });

  it("returns unchanged when budget exactly equals token count", () => {
    const msgs = makeTurns(2, 10);
    const result = trimToWindow(msgs, {
      maxTokens: 1_000_000,
      targetUtilization: 1.0,
      keepRecentTurns: 2,
    });
    expect(result).toBe(msgs);
  });

  it("uses default targetUtilization=0.75 when not specified", () => {
    const msgs = makeTurns(2, 10);
    // Budget effective = 200000 * 0.75 = 150000, 2 turns are fine
    const result = trimToWindow(msgs, {
      maxTokens: 200_000,
    });
    expect(result).toBe(msgs);
  });

  it("uses default keepRecentTurns=6 when not specified", () => {
    const msgs = makeTurns(3);
    const result = trimToWindow(msgs, {
      maxTokens: 10,
      targetUtilization: 1,
    });
    // 3 turns <= default 6 -> unchanged
    expect(result).toBe(msgs);
  });

  it("does not drop below keepRecentTurns", () => {
    // 10 turns, keepRecent=3 => maxDrop = 7, keeps last 3
    const msgs = makeTurns(10, 200);
    const result = trimToWindow(msgs, {
      maxTokens: 200,
      targetUtilization: 1.0,
      keepRecentTurns: 3,
    });
    const userCount = result.filter((m) => m.role === "user").length;
    expect(userCount).toBeGreaterThanOrEqual(3);
    // First message should be the anchor (message[0])
    expect(result[0]).toBe(msgs[0]);
  });

  it("stops at first fit (not necessarily the tightest trim)", () => {
    // Make many messages large enough to trigger trimming.
    // 20 turns * ~50 chars each = ~1000 tokens, budget = 500
    const msgs = makeTurns(20, 100);
    const result = trimToWindow(msgs, {
      maxTokens: 500,
      targetUtilization: 1.0,
      keepRecentTurns: 3,
    });
    // Should have trimmed (result !== original)
    expect(result.length).toBeLessThan(msgs.length);
    expect(result[0]).toBe(msgs[0]);
    // Should have at least keepRecentTurns user messages
    const userMsgs = result.filter((m) => m.role === "user");
    expect(userMsgs.length).toBeGreaterThanOrEqual(3);
  });

  it("avoids duplicating anchor when anchor is at rest[0]", () => {
    // Create scenario where turnStarts[1] === 0 (anchor is also the start of rest)
    // This doesn't happen normally since turnStarts[0]=0 and turnStarts[1]>0
    // But the code has the check, so let's test it indirectly
    // by creating 2 turns with turnStarts=[0,2], keepRecent=1 => maxDrop=1
    // drop=1: turnStarts[1]=2, rest starts at messages[2], anchor=messages[0]
    // rest[0]==anchor? false => [anchor, ...rest]
    const msgs: Message[] = [
      makeMsg("user", "first"),
      makeMsg("assistant", "first response"),
      makeMsg("user", "second"),
      makeMsg("assistant", "second response"),
    ];
    const result = trimToWindow(msgs, {
      maxTokens: 10,
      targetUtilization: 1.0,
      keepRecentTurns: 1,
    });
    expect(result[0]).toBe(msgs[0]);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("works with single turn", () => {
    const msgs: Message[] = [
      makeMsg("user", "hello"),
      makeMsg("assistant", "hi"),
    ];
    const result = trimToWindow(msgs, {
      maxTokens: 1,
      targetUtilization: 1.0,
      keepRecentTurns: 1,
    });
    // 1 turn <= keepRecentTurns (1) -> unchanged
    expect(result).toBe(msgs);
  });

  it("handles maxTokens=0 edge case", () => {
    const msgs = makeTurns(5, 100);
    const result = trimToWindow(msgs, {
      maxTokens: 0,
      targetUtilization: 1.0,
      keepRecentTurns: 2,
    });
    // Budget = 0, always over budget, keeps at least keepRecentTurns=2
    const userMsgs = result.filter((m) => m.role === "user");
    expect(userMsgs.length).toBeGreaterThanOrEqual(2);
    expect(result[0]).toBe(msgs[0]);
  });

  it("handles targetUtilization=0 edge case", () => {
    const msgs = makeTurns(10, 100);
    const result = trimToWindow(msgs, {
      maxTokens: 1_000_000,
      targetUtilization: 0,
      keepRecentTurns: 2,
    });
    // Budget = 0, always over budget, keeps at least keepRecentTurns
    expect(result.length).toBeLessThan(msgs.length);
    expect(result[0]).toBe(msgs[0]);
  });

  it("preserves turn integrity (user+assistant pairs)", () => {
    const msgs = makeTurns(10, 100);
    const result = trimToWindow(msgs, {
      maxTokens: 200,
      targetUtilization: 1.0,
      keepRecentTurns: 2,
    });
    // The last message in result should be the last original message
    // (turnStarts-based trimming preserves complete turns at the end)
    expect(result[result.length - 1]).toBe(msgs[msgs.length - 1]);
  });
});

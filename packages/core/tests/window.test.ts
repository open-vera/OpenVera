import { describe, it, expect } from "vitest";
import { trimToWindow } from "../src/context/window.js";
import type { Message } from "../src/types/index.js";

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

describe("trimToWindow", () => {
  it("returns same reference when under budget", () => {
    const msgs = makeTurns(2);
    const result = trimToWindow(msgs, { maxTokens: 200_000, keepRecentTurns: 6 });
    expect(result).toBe(msgs);
  });

  it("trims when over budget", () => {
    // Make 20 turns, each ~50 chars → ~600 tokens total
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
    // Should have at least 4 recent turns (8 messages) + the anchor
    const userMsgs = result.filter((m) => m.role === "user");
    expect(userMsgs.length).toBeGreaterThanOrEqual(4);
  });

  it("does not mutate the original array", () => {
    const msgs = makeTurns(10, 100);
    const copy = [...msgs];
    trimToWindow(msgs, { maxTokens: 100, targetUtilization: 1.0, keepRecentTurns: 2 });
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
});

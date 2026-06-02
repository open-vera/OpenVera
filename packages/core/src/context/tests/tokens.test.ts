import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  estimateMessageTokens,
  BYTES_PER_TOKEN,
} from "../index.js";
import type { Message } from "../../types/index.js";

// ── estimateTokens ──────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates ~1 token per 4 chars", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });

  it("rounds up fractional tokens", () => {
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("handles long text", () => {
    const tokens = estimateTokens("a".repeat(10_000));
    expect(tokens).toBe(2_500);
  });

  it("handles single character", () => {
    expect(estimateTokens("x")).toBe(1);
  });
});

// ── BYTES_PER_TOKEN constant ───────────────────────────────────────────────

describe("BYTES_PER_TOKEN", () => {
  it("is 4", () => {
    expect(BYTES_PER_TOKEN).toBe(4);
  });
});

// ── estimateMessageTokens ──────────────────────────────────────────────────

describe("estimateMessageTokens", () => {
  it("returns 0 for empty array", () => {
    expect(estimateMessageTokens([])).toBe(0);
  });

  it("accounts for role overhead", () => {
    const singleMsg: Message[] = [{ role: "user", content: "" }];
    const overhead = estimateMessageTokens(singleMsg);
    expect(overhead).toBeGreaterThan(0);
  });

  it("tool role has higher overhead than user role", () => {
    const userMsg: Message[] = [{ role: "user", content: "x" }];
    const toolMsg: Message[] = [
      { role: "tool", tool_call_id: "id1", content: "x" },
    ];
    expect(estimateMessageTokens(toolMsg)).toBeGreaterThan(
      estimateMessageTokens(userMsg)
    );
  });

  it("uses default overhead 5 for unknown roles", () => {
    const msg: Message[] = [
      { role: "unknown_custom_role" as Message["role"], content: "hello" },
    ];
    const tokens = estimateMessageTokens(msg);
    // 5 chars / 4 = 2 + default overhead 5 = 7
    expect(tokens).toBe(7);
  });

  it("string content is estimated correctly", () => {
    const msg: Message[] = [{ role: "user", content: "a".repeat(400) }];
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBeGreaterThan(100);
    expect(tokens).toBeLessThan(130);
  });

  it("tool_call parts include structure overhead", () => {
    const withToolCall: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call_123",
            name: "read_file",
            arguments: '{"path":"a"}',
          },
        ],
      },
    ];
    const withText: Message[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "read_file" + '{"path":"a"}' }],
      },
    ];
    expect(estimateMessageTokens(withToolCall)).toBeGreaterThan(
      estimateMessageTokens(withText)
    );
  });

  it("tool_result parts estimate tokens from content", () => {
    const msg: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", content: "abcdefgh" }],
      },
    ];
    const tokens = estimateMessageTokens(msg);
    // 8 chars / 4 = 2 content tokens + 5 role overhead = 7
    expect(tokens).toBe(7);
  });

  it("tool_result with long content", () => {
    const msg: Message[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", content: "x".repeat(1_000) },
        ],
      },
    ];
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBe(255); // 1000/4=250 + 5 overhead
  });

  it("image_url defaults to 1000 tokens", () => {
    const withImage: Message[] = [
      {
        role: "user",
        content: [{ type: "image_url", url: "http://x" }],
      },
    ];
    const withText: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "x" }],
      },
    ];
    expect(
      estimateMessageTokens(withImage) - estimateMessageTokens(withText)
    ).toBe(1_000 - 1);
  });

  it("unknown content part type contributes 0 tokens", () => {
    const msg: Message[] = [
      {
        role: "user",
        content: [{ type: "unknown_type" as unknown as "text", foo: "bar" } as any],
      },
    ];
    // Only role overhead expected (unknown part yields 0)
    expect(estimateMessageTokens(msg)).toBe(5);
  });

  it("totals across multiple messages with mixed content types", () => {
    const messages: Message[] = [
      { role: "user", content: "a".repeat(40) }, // 10 tokens + 5 overhead
      {
        role: "assistant",
        content: [
          { type: "text", text: "b".repeat(16) }, // 4 tokens
          {
            type: "tool_call",
            id: "call_abc",
            name: "search",
            arguments: '{"q":"test"}', // 14 chars
          }, // 12 overhead + ceil(6/4) + ceil(14/4) = 12+2+4=18 tokens
        ], // total = 4+18 = 22 content + 5 overhead = 27
      },
      {
        role: "tool",
        tool_call_id: "call_abc",
        content: "c".repeat(80), // 20 tokens + 10 overhead = 30
      },
    ];
    const total = estimateMessageTokens(messages);
    // user: ceil(40/4)=10 + 5 overhead = 15
    // assistant: ceil(16/4)=4 text + 12 overhead + ceil(6/4)=2 name + ceil(12/4)=3 args = 21 content + 5 overhead = 26
    // tool: ceil(80/4)=20 + 10 overhead = 30
    // total = 15 + 26 + 30 = 71
    expect(total).toBe(71);
  });

  it("handles array content with multiple parts", () => {
    const msg: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Hello" }, // ceil(5/4)=2
          { type: "text", text: "World" }, // ceil(5/4)=2
          { type: "image_url", url: "http://img" }, // 1000
        ],
      },
    ];
    // 2+2+1000=1004 content + 5 overhead = 1009
    expect(estimateMessageTokens(msg)).toBe(1009);
  });

  it("multiple messages with only tool_result parts", () => {
    const messages: Message[] = [
      {
        role: "tool",
        tool_call_id: "id1",
        content: [
          { type: "tool_result", content: "result one" },
        ],
      },
      {
        role: "tool",
        tool_call_id: "id2",
        content: [
          { type: "tool_result", content: "result two" },
        ],
      },
    ];
    const total = estimateMessageTokens(messages);
    // msg1: ceil(10/4)=3 + 10 overhead = 13
    // msg2: ceil(10/4)=3 + 10 overhead = 13
    // total = 26
    expect(total).toBe(26);
  });
});

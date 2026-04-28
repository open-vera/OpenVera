import { describe, it, expect } from "vitest";
import { estimateTokens, estimateMessageTokens } from "../src/context/tokens.js";
import type { Message } from "../src/types/index.js";

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
});

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
    const toolMsg: Message[] = [{ role: "tool", tool_call_id: "id1", content: "x" }];
    expect(estimateMessageTokens(toolMsg)).toBeGreaterThan(estimateMessageTokens(userMsg));
  });

  it("string content is estimated correctly", () => {
    const msg: Message[] = [{ role: "user", content: "a".repeat(400) }];
    const tokens = estimateMessageTokens(msg);
    // 400 chars / 4 = 100 text tokens + role overhead
    expect(tokens).toBeGreaterThan(100);
    expect(tokens).toBeLessThan(130);
  });

  it("tool_call parts include structure overhead", () => {
    const withToolCall: Message[] = [{
      role: "assistant",
      content: [{
        type: "tool_call",
        id: "call_123",
        name: "read_file",
        arguments: '{"path":"a"}',
      }],
    }];
    const withText: Message[] = [{
      role: "assistant",
      content: [{
        type: "text",
        text: "read_file" + '{"path":"a"}', // same raw chars, no overhead
      }],
    }];
    // tool_call should cost more due to TOOL_CALL_STRUCT_OVERHEAD
    expect(estimateMessageTokens(withToolCall)).toBeGreaterThan(estimateMessageTokens(withText));
  });

  it("image_url defaults to 1000 tokens", () => {
    const withImage: Message[] = [{
      role: "user",
      content: [{ type: "image_url", url: "http://x" }],
    }];
    const withText: Message[] = [{
      role: "user",
      content: [{ type: "text", text: "x" }],
    }];
    expect(estimateMessageTokens(withImage) - estimateMessageTokens(withText)).toBe(1_000 - 1);
  });

  it("totals across multiple messages", () => {
    const messages: Message[] = [
      { role: "user", content: "a".repeat(40) },
      { role: "assistant", content: "b".repeat(40) },
    ];
    const total = estimateMessageTokens(messages);
    const single = estimateMessageTokens([{ role: "user", content: "a".repeat(40) }]);
    expect(total).toBeGreaterThan(single);
  });
});

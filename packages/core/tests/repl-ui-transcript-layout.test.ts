import { describe, expect, it } from "vitest";
import {
  estimateMessageLines,
  getEstimatedMessageLines,
  messageHeightCacheKey,
  wrapLineCount,
} from "../src/repl/ui/controller/transcriptLayout.js";
import type { ChatMessage } from "../src/repl/ui/types.js";

describe("transcriptLayout", () => {
  it("uses display width for CJK and emoji wrapping", () => {
    expect(wrapLineCount("abcd", 2)).toBe(2);
    expect(wrapLineCount("中文", 2)).toBe(2);
    expect(wrapLineCount("🙂🙂", 2)).toBe(2);
  });

  it("estimates message lines with streaming cursor and tools", () => {
    const msg: ChatMessage = {
      role: "assistant",
      content: "hello",
      streaming: true,
      toolUses: [{ name: "read_file", args: {}, result: { ok: true, content: "(2 lines)\nhi" } }],
    };

    expect(estimateMessageLines(msg, 10, false)).toBe(8);
  });

  it("estimates plan message lines", () => {
    const msg: ChatMessage = {
      role: "assistant",
      content: "",
      planMode: true,
      planSteps: [
        { id: "1", description: "step", status: "done", content: "a\nb", toolUses: [] },
      ],
    };

    expect(estimateMessageLines(msg, 10, false)).toBe(6);
  });

  it("caches message height by stable key inputs", () => {
    const cache = new Map<string, number>();
    const msg: ChatMessage = { role: "assistant", content: "hello" };
    const key = messageHeightCacheKey(msg, 0, 10, false);

    expect(getEstimatedMessageLines(cache, msg, 0, 10, false)).toBe(2);
    expect(cache.get(key)).toBe(2);
    cache.set(key, 42);
    expect(getEstimatedMessageLines(cache, msg, 0, 10, false)).toBe(42);
  });
});

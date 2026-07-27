import { describe, expect, it } from "vitest";
import {
  buildUserMessageAnchors,
  formatAnchorPreview,
  truncateAnchorPreview,
} from "@/utils/message-anchors";
import type { Message } from "@/types";

function msg(partial: Partial<Message> & Pick<Message, "id" | "role" | "content">): Message {
  return {
    timestamp: 1,
    ...partial,
  };
}

describe("message-anchors", () => {
  it("formats a multi-line preview for hover cards", () => {
    expect(formatAnchorPreview("你好\n世界")).toBe("你好\n世界");
    expect(formatAnchorPreview("a".repeat(300)).endsWith("…")).toBe(true);
    expect(formatAnchorPreview("   ")).toBe("(空消息)");
  });

  it("keeps single-line truncate helper for compact labels", () => {
    expect(truncateAnchorPreview("你好\n世界")).toBe("你好 世界");
  });

  it("keeps only user messages as anchors and appends the next assistant reply", () => {
    const anchors = buildUserMessageAnchors([
      msg({ id: "u1", role: "user", content: "第一条用户消息" }),
      msg({ id: "a1", role: "assistant", content: "助手回复" }),
      msg({ id: "u2", role: "user", content: "第二条\n换行" }),
    ]);
    expect(anchors).toEqual([
      { id: "u1", preview: "第一条用户消息\n\n助手回复" },
      { id: "u2", preview: "第二条\n换行" },
    ]);
  });

  it("includes a few lines of the LLM result in the hover preview", () => {
    const anchors = buildUserMessageAnchors([
      msg({ id: "u1", role: "user", content: "c + p" }),
      msg({
        id: "a1",
        role: "assistant",
        content: "已完成 commit + push。\n\n提交:\ndea44b70 fix: example",
      }),
    ]);
    expect(anchors[0]?.preview).toContain("c + p");
    expect(anchors[0]?.preview).toContain("已完成 commit + push。");
    expect(anchors[0]?.preview).toContain("dea44b70");
  });
});

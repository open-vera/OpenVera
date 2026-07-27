import { describe, expect, it } from "vitest";
import {
  buildChatDisplayItems,
  buildChatTimelineEntries,
  turnDurationMs,
  type ChatTurnEntry,
} from "@/utils/chat-timeline";
import type { Message } from "@/types";

const BASE = 1_700_000_000_000;

function user(id: string, content = "去装一下 playwright"): Message {
  return { id, role: "user", content, timestamp: BASE };
}

function narration(id: string, content: string, turnId?: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    role: "assistant",
    content,
    timestamp: BASE + 1,
    turnId,
    ...extra,
  };
}

function tools(
  id: string,
  names: string[],
  turnId?: string,
  extra: Partial<Message> = {},
): Message {
  return {
    id,
    role: "tool",
    content: names.join("\n"),
    timestamp: BASE + 2,
    turnId,
    toolCalls: names.map((name, index) => ({ id: `${id}-${index}`, name, input: {} })),
    ...extra,
  };
}

function firstTurn(entries: ReturnType<typeof buildChatTimelineEntries>): ChatTurnEntry {
  const turn = entries.find((entry) => entry.type === "turn");
  if (!turn || turn.type !== "turn") throw new Error("no turn entry");
  return turn;
}

describe("buildChatDisplayItems", () => {
  it("breaks the tool block when narration resumes", () => {
    const items = buildChatDisplayItems([
      user("u1"),
      tools("t1", ["bash"], "turn-1"),
      narration("a1", "先装依赖", "turn-1"),
      tools("t2", ["bash", "bash"], "turn-1"),
      narration("a2", "装好了", "turn-1"),
    ]);

    // A leading time separator is emitted for the first visible message.
    expect(items.map((item) => item.type)).toEqual([
      "time",
      "message",
      "tool-progress",
      "message",
      "tool-progress",
      "message",
    ]);
  });

  it("merges consecutive tool messages into one block", () => {
    const items = buildChatDisplayItems([
      user("u1"),
      tools("t1", ["read_file"], "turn-1"),
      tools("t2", ["write_file"], "turn-1"),
    ]);

    const blocks = items.filter((item) => item.type === "tool-progress");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type === "tool-progress" && blocks[0].toolCalls).toHaveLength(2);
  });

  it("skips assistant placeholders that have no text yet", () => {
    const items = buildChatDisplayItems([
      user("u1"),
      narration("a1", "", "turn-1", { isStreaming: true }),
    ]);
    expect(items.filter((item) => item.type !== "time").map((item) => item.key)).toEqual([
      "u1",
    ]);
  });
});

describe("buildChatTimelineEntries", () => {
  it("groups a run and lifts the last narration out as the answer", () => {
    const entries = buildChatTimelineEntries(
      buildChatDisplayItems([
        user("u1"),
        tools("t1", ["bash"], "turn-1"),
        narration("a1", "先装依赖", "turn-1"),
        tools("t2", ["bash"], "turn-1"),
        narration("a2", "装好了，结果如下", "turn-1"),
      ]),
    );

    expect(entries.map((entry) => entry.type)).toEqual(["item", "item", "turn"]);
    const turn = firstTurn(entries);
    expect(turn.finalMessage?.id).toBe("a2");
    // Process keeps the mid-run narration and both tool blocks, minus the answer.
    expect(turn.processItems.map((item) => item.type)).toEqual([
      "tool-progress",
      "message",
      "tool-progress",
    ]);
  });

  it("keeps separate runs in separate turns", () => {
    const entries = buildChatTimelineEntries(
      buildChatDisplayItems([
        user("u1"),
        tools("t1", ["bash"], "turn-1"),
        narration("a1", "第一轮", "turn-1"),
        user("u2"),
        tools("t2", ["bash"], "turn-2"),
        narration("a2", "第二轮", "turn-2"),
      ]),
    );

    const turns = entries.filter((entry) => entry.type === "turn");
    expect(turns).toHaveLength(2);
    // time separator, user, turn-1, user, turn-2
    expect(entries.map((entry) => entry.type)).toEqual([
      "item",
      "item",
      "turn",
      "item",
      "turn",
    ]);
  });

  it("leaves legacy messages without turnId as standalone items", () => {
    const entries = buildChatTimelineEntries(
      buildChatDisplayItems([
        user("u1"),
        tools("t1", ["bash", "read_file"]),
        narration("a1", "旧会话没有 turnId"),
      ]),
    );

    expect(entries.every((entry) => entry.type === "item")).toBe(true);
    expect(entries).toHaveLength(4);
  });

  it("marks an open turn while a segment is still streaming", () => {
    const entries = buildChatTimelineEntries(
      buildChatDisplayItems([
        user("u1"),
        tools("t1", ["bash"], "turn-1"),
        narration("a1", "正在写…", "turn-1", { isStreaming: true }),
      ]),
    );
    expect(firstTurn(entries).isOpen).toBe(true);
  });

  it("computes turn duration from the end stamp", () => {
    const entries = buildChatTimelineEntries(
      buildChatDisplayItems([
        user("u1"),
        tools("t1", ["bash"], "turn-1"),
        narration("a1", "完成", "turn-1", { endedAt: BASE + 113_000 }),
      ]),
    );
    const turn = firstTurn(entries);
    // startedAt is the first process item (tool block at BASE + 2).
    expect(turnDurationMs(turn)).toBe(113_000 - 2);
  });

  it("returns null duration until the turn is stamped", () => {
    const entries = buildChatTimelineEntries(
      buildChatDisplayItems([user("u1"), tools("t1", ["bash"], "turn-1")]),
    );
    expect(turnDurationMs(firstTurn(entries))).toBeNull();
  });
});

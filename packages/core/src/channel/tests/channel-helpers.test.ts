import { describe, expect, it, vi } from "vitest";
import {
  appendBotMessage,
  filterChannelHistory,
  subscribeMessage,
} from "../channel-helpers.js";
import type { ChannelMessage } from "../types.js";

function message(id: string, timestamp: string, senderId = "user"): ChannelMessage {
  return {
    id,
    channelType: "webhook",
    senderId,
    content: id,
    attachments: [],
    timestamp,
  };
}

describe("channel helpers", () => {
  it("subscribes and unsubscribes message callbacks", () => {
    const callbacks: Array<(msg: ChannelMessage) => void> = [];
    const cb = vi.fn();
    const unsubscribe = subscribeMessage(callbacks, cb);
    expect(callbacks).toHaveLength(1);
    unsubscribe();
    expect(callbacks).toHaveLength(0);
  });

  it("filters history by time, sender, and limit", async () => {
    const history = [
      message("1", "2026-01-01T00:00:00.000Z", "alice"),
      message("2", "2026-01-02T00:00:00.000Z", "bob"),
      message("3", "2026-01-03T00:00:00.000Z", "alice"),
    ];

    const filtered = await filterChannelHistory(history, {
      after: "2026-01-01T12:00:00.000Z",
      senderId: "alice",
      limit: 1,
    });

    expect(filtered).toEqual([message("3", "2026-01-03T00:00:00.000Z", "alice")]);
  });

  it("appends bot messages to history", () => {
    const history: ChannelMessage[] = [];
    const sent = appendBotMessage(history, "feishu", { content: "hi" }, () => "msg-1");
    expect(sent.id).toBe("msg-1");
    expect(history).toHaveLength(1);
    expect(history[0]?.senderId).toBe("bot");
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import {
  appendMessage,
  createConversation,
  getConversation,
  listConversations,
  resetConversations,
} from "../conversation-store.js";

beforeEach(() => {
  resetConversations();
});

describe.sequential("conversation-store", () => {
  it("creates and lists conversations by project", () => {
    createConversation("proj-1", "Alpha");
    createConversation("proj-2", "Beta");

    expect(listConversations("proj-1")).toHaveLength(1);
    expect(listConversations()).toHaveLength(2);
  });

  it("appends user message without auto assistant", () => {
    const conversation = createConversation("proj-1");
    const message = appendMessage(conversation.id, "user", "hello gateway");

    expect(message?.content).toBe("hello gateway");
    const updated = getConversation(conversation.id);
    expect(updated?.messages).toHaveLength(1);
    expect(updated?.messages[0]?.role).toBe("user");
  });
});

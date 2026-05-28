import { describe, expect, it } from "vitest";
import { projectUiEvents } from "../src/repl/ui/controller/eventProjector.js";
import { emptyReplViewModel, toolUse } from "../src/repl/ui/events.js";

describe("projectUiEvent — thinking", () => {
  it("archives thinking text with completed assistant message", () => {
    const state = projectUiEvents(emptyReplViewModel(), [
      { type: "assistant.started" },
      { type: "assistant.thinking.delta", delta: "Let me think..." },
      { type: "assistant.delta", delta: "The answer is 42" },
      { type: "assistant.completed", text: "The answer is 42" },
    ]);

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      role: "assistant",
      content: "The answer is 42",
      thinking: "Let me think...",
    });
  });

  it("does not add thinking field when no thinking occurred", () => {
    const state = projectUiEvents(emptyReplViewModel(), [
      { type: "assistant.started" },
      { type: "assistant.delta", delta: "Hello" },
      { type: "assistant.completed", text: "Hello" },
    ]);

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).not.toHaveProperty("thinking");
    expect(state.messages[0]?.content).toBe("Hello");
  });

  it("archives thinking with tools", () => {
    const state = projectUiEvents(emptyReplViewModel(), [
      { type: "assistant.started" },
      { type: "assistant.thinking.delta", delta: "I need to read the file" },
      {
        type: "tool.completed",
        tool: toolUse("read_file", { path: "a.ts" }, { ok: true, content: "x" }),
      },
      { type: "assistant.completed", text: "File contents: x" },
    ]);

    expect(state.messages[0]).toMatchObject({
      role: "assistant",
      content: "File contents: x",
      thinking: "I need to read the file",
    });
    expect(state.messages[0]?.toolUses).toHaveLength(1);
  });

  it("handles multiple thinking deltas accumulated via updated", () => {
    const state = projectUiEvents(emptyReplViewModel(), [
      { type: "assistant.started" },
      { type: "assistant.thinking.updated", text: "Full thinking content here" },
      { type: "assistant.completed", text: "Done" },
    ]);

    expect(state.messages[0]).toMatchObject({
      role: "assistant",
      content: "Done",
      thinking: "Full thinking content here",
    });
  });

  it("thinking does not appear on user messages", () => {
    const state = projectUiEvents(emptyReplViewModel(), [
      { type: "user.submitted", text: "hello" },
    ]);

    expect(state.messages[0]).toMatchObject({
      role: "user",
      content: "hello",
    });
    expect(state.messages[0]).not.toHaveProperty("thinking");
  });
});

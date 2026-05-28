import { describe, expect, it } from "vitest";
import { emptyActiveTurn, reduceActiveTurn } from "../src/repl/ui/state/turnStore.js";
import { toolUse } from "../src/repl/ui/events.js";

describe("reduceActiveTurn — thinking", () => {
  it("accumulates thinking deltas", () => {
    const state = [
      { type: "assistant.started" as const },
      { type: "assistant.thinking.delta" as const, delta: "Let me " },
      { type: "assistant.thinking.delta" as const, delta: "analyze..." },
      { type: "assistant.delta" as const, delta: "The answer is 42" },
    ].reduce(reduceActiveTurn, emptyActiveTurn());

    expect(state.thinkingText).toBe("Let me analyze...");
    expect(state.text).toBe("The answer is 42");
  });

  it("handles assistant.thinking.updated", () => {
    const state = [
      { type: "assistant.started" as const },
      { type: "assistant.thinking.updated" as const, text: "Full thinking text" },
    ].reduce(reduceActiveTurn, emptyActiveTurn());

    expect(state.thinkingText).toBe("Full thinking text");
  });

  it("preserves thinkingText through tool.started", () => {
    const state = [
      { type: "assistant.started" as const },
      { type: "assistant.thinking.delta" as const, delta: "thinking..." },
      { type: "assistant.delta" as const, delta: "I'll check the file." },
      { type: "tool.started" as const, name: "read_file", args: { path: "a.ts" } },
    ].reduce(reduceActiveTurn, emptyActiveTurn());

    expect(state.thinkingText).toBe("thinking...");
    expect(state.text).toBe(""); // cleared by tool.started
  });

  it("preserves thinkingText through tool.completed", () => {
    const state = [
      { type: "assistant.started" as const },
      { type: "assistant.thinking.delta" as const, delta: "analyzing..." },
      {
        type: "tool.completed" as const,
        tool: toolUse("read_file", { path: "a.ts" }, { ok: true, content: "content" }),
      },
    ].reduce(reduceActiveTurn, emptyActiveTurn());

    expect(state.thinkingText).toBe("analyzing...");
    expect(state.tools).toHaveLength(1);
  });

  it("clears thinkingText on new assistant.started", () => {
    const state = [
      { type: "assistant.started" as const },
      { type: "assistant.thinking.delta" as const, delta: "old thinking" },
      { type: "assistant.started" as const },
    ].reduce(reduceActiveTurn, emptyActiveTurn());

    expect(state.thinkingText).toBe("");
  });

  it("handles thinking delta without prior assistant.started", () => {
    const state = [
      { type: "assistant.thinking.delta" as const, delta: "orphan thinking" },
    ].reduce(reduceActiveTurn, emptyActiveTurn());

    expect(state.active).toBe(true);
    expect(state.thinkingText).toBe("orphan thinking");
  });

  it("preserves thinkingText on assistant.completed", () => {
    const state = [
      { type: "assistant.started" as const },
      { type: "assistant.thinking.delta" as const, delta: "my reasoning" },
      { type: "assistant.delta" as const, delta: "final text" },
      { type: "assistant.completed" as const, text: "final text" },
    ].reduce(reduceActiveTurn, emptyActiveTurn());

    expect(state.thinkingText).toBe("my reasoning");
    expect(state.text).toBe("final text");
    expect(state.active).toBe(false);
  });
});

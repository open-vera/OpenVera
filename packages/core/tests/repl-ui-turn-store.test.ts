import { describe, expect, it } from "vitest";
import { emptyActiveTurn, reduceActiveTurn } from "../src/repl/ui/state/turnStore.js";
import { toolUse } from "../src/repl/ui/events.js";

describe("reduceActiveTurn", () => {
  it("tracks assistant streaming text", () => {
    const state = [
      { type: "assistant.started" as const },
      { type: "assistant.delta" as const, delta: "hel" },
      { type: "assistant.updated" as const, text: "hello" },
    ].reduce(reduceActiveTurn, emptyActiveTurn());

    expect(state).toEqual({
      active: true,
      text: "hello",
      thinkingText: "",
      tools: [],
      inputTokens: 0,
      outputTokens: 0,
      status: "streaming",
    });
  });

  it("moves preface text out of active text when a tool starts", () => {
    const state = [
      { type: "assistant.started" as const },
      { type: "assistant.updated" as const, text: "I will inspect." },
      { type: "tool.started" as const, name: "read_file", args: { path: "a.ts" } },
    ].reduce(reduceActiveTurn, emptyActiveTurn());

    expect(state.text).toBe("");
    expect(state.active).toBe(true);
  });

  it("tracks completed tools", () => {
    const state = [
      { type: "assistant.started" as const },
      {
        type: "tool.completed" as const,
        tool: toolUse("read_file", { path: "a.ts" }, { ok: true, content: "content" }),
      },
    ].reduce(reduceActiveTurn, emptyActiveTurn());

    expect(state.tools).toHaveLength(1);
    expect(state.tools[0]?.name).toBe("read_file");
  });

  it("tracks output token deltas for the active turn", () => {
    const state = [
      { type: "assistant.started" as const },
      { type: "usage.updated" as const, usage: { outputTotal: 5 }, outputTokensDelta: 5 },
      { type: "usage.updated" as const, usage: { outputTotal: 3 }, outputTokensDelta: 3 },
    ].reduce(reduceActiveTurn, emptyActiveTurn());

    expect(state.outputTokens).toBe(8);
  });

  it("marks turn completed with final assistant text", () => {
    const state = [
      { type: "assistant.started" as const },
      { type: "assistant.updated" as const, text: "draft" },
      { type: "assistant.completed" as const, text: "final" },
    ].reduce(reduceActiveTurn, emptyActiveTurn());

    expect(state.active).toBe(false);
    expect(state.status).toBe("completed");
    expect(state.text).toBe("final");
  });

  it("preserves partial text on failure when requested", () => {
    const state = [
      { type: "assistant.started" as const },
      { type: "assistant.updated" as const, text: "partial" },
      { type: "assistant.failed" as const, message: "Cancelled.", preservePartial: true },
    ].reduce(reduceActiveTurn, emptyActiveTurn());

    expect(state.active).toBe(false);
    expect(state.status).toBe("failed");
    expect(state.text).toBe("partial");
  });
});

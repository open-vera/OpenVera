import { describe, expect, it } from "vitest";
import { emptyReplViewModel, toolUse } from "../src/repl/ui/events.js";
import { projectUiEvent, projectUiEvents } from "../src/repl/ui/controller/eventProjector.js";

describe("projectUiEvent", () => {
  it("adds submitted user messages", () => {
    const state = projectUiEvent(emptyReplViewModel(), {
      type: "user.submitted",
      text: "hello",
    });

    expect(state.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("projects assistant streaming lifecycle", () => {
    const state = projectUiEvents(emptyReplViewModel(), [
      { type: "assistant.started" },
      { type: "assistant.delta", delta: "hel" },
      { type: "assistant.updated", text: "hello" },
      { type: "assistant.completed", text: "hello world" },
    ]);

    expect(state.messages).toEqual([
      { role: "assistant", content: "hello world" },
    ]);
    expect(state.activeTurn).toMatchObject({
      active: false,
      text: "hello world",
      status: "completed",
    });
  });

  it("tracks a delta without writing a live transcript row", () => {
    const state = projectUiEvent(emptyReplViewModel(), {
      type: "assistant.delta",
      delta: "late",
    });

    expect(state.messages).toEqual([]);
    expect(state.activeTurn).toMatchObject({
      active: true,
      text: "late",
      status: "streaming",
    });
  });

  it("tracks tool progress without writing live transcript rows", () => {
    const state = projectUiEvents(emptyReplViewModel(), [
      { type: "assistant.started" },
      { type: "assistant.updated", text: "I will inspect the file." },
      { type: "tool.started", name: "read_file", args: { path: "a.ts" }, preface: "I will inspect the file." },
      {
        type: "tool.completed",
        tool: toolUse("read_file", { path: "a.ts" }, { ok: true, content: "content" }, "I will inspect the file."),
      },
    ]);

    expect(state.messages).toEqual([]);
    expect(state.activeTurn.tools).toHaveLength(1);
    expect(state.activeTurn.text).toBe("");
  });

  it("archives completed tools with the final assistant message", () => {
    const state = projectUiEvents(emptyReplViewModel(), [
      { type: "assistant.started" },
      {
        type: "tool.completed",
        tool: toolUse("read_file", { path: "a.ts" }, { ok: true, content: "content" }),
      },
      { type: "assistant.completed", text: "done" },
    ]);

    expect(state.messages).toEqual([
      {
        role: "assistant",
        content: "done",
        toolUses: [
          {
            name: "read_file",
            args: { path: "a.ts" },
            result: { ok: true, content: "content" },
          },
        ],
      },
    ]);
  });

  it("preserves partial assistant text on failure when requested", () => {
    const state = projectUiEvents(emptyReplViewModel(), [
      { type: "assistant.started" },
      { type: "assistant.updated", text: "partial" },
      { type: "assistant.failed", message: "Cancelled.", preservePartial: true },
    ]);

    expect(state.messages).toEqual([
      { role: "assistant", content: "partial" },
    ]);
  });

  it("updates status and accumulates usage", () => {
    const state = projectUiEvents(emptyReplViewModel(), [
      { type: "status.changed", status: "streaming" },
      { type: "usage.updated", usage: { inputTotal: 10, outputTotal: 2, costUsd: 0.01 } },
      { type: "usage.updated", usage: { inputTotal: 5, cacheReadTotal: 3, costUsd: 0.02 } },
    ]);

    expect(state.status).toBe("streaming");
    expect(state.usage).toEqual({
      inputTotal: 15,
      outputTotal: 2,
      cacheWriteTotal: 0,
      cacheReadTotal: 3,
      costUsd: 0.02,
    });
  });

  it("updates active turn output tokens from usage events", () => {
    const state = projectUiEvents(emptyReplViewModel(), [
      { type: "assistant.started" },
      { type: "usage.updated", usage: { outputTotal: 4 }, outputTokensDelta: 4 },
    ]);

    expect(state.activeTurn.outputTokens).toBe(4);
  });
});

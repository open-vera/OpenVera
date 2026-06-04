import { describe, expect, it } from "vitest";
import {
  applyPathCompletion,
  deleteBackAtCursor,
  deleteWordBackAtCursor,
  emptyComposerState,
  getCommandSuggestions,
  getCurrentToken,
  getPathCompletions,
  insertAtCursor,
  moveCursorByGrapheme,
  moveWordBack,
  moveWordForward,
  navigateComposerHistory,
  reduceComposerInput,
  syncComposerValue,
} from "../src/repl/ui/state/composerState.js";

describe("composerState", () => {
  it("syncs external composition text with cursor at end when previous cursor was at end", () => {
    const synced = syncComposerValue(emptyComposerState(""), "中文");

    expect(synced.value).toBe("中文");
    expect(synced.cursor).toBe("中文".length);
  });

  it("preserves cursor position when syncing external text while editing in the middle", () => {
    const state = { ...emptyComposerState("abcd"), cursor: 2 };
    const synced = syncComposerValue(state, "abcde");

    expect(synced.cursor).toBe(2);
  });

  it("moves by grapheme instead of UTF-16 code unit", () => {
    const value = "a🙂中";

    const afterEmoji = moveCursorByGrapheme(value, value.length, -1);
    const beforeEmoji = moveCursorByGrapheme(value, afterEmoji, -1);

    expect(afterEmoji).toBe("a🙂".length);
    expect(beforeEmoji).toBe("a".length);
    expect(moveCursorByGrapheme(value, beforeEmoji, 1)).toBe("a🙂".length);
  });

  it("moves by whitespace-delimited words", () => {
    const value = "alpha beta  gamma";

    expect(moveWordBack(value, value.length)).toBe("alpha beta  ".length);
    expect(moveWordBack(value, "alpha beta".length)).toBe("alpha ".length);
    expect(moveWordForward(value, 0)).toBe("alpha ".length);
    expect(moveWordForward(value, "alpha ".length)).toBe("alpha beta  ".length);
  });

  it("inserts and deletes at the cursor", () => {
    const inserted = insertAtCursor({ value: "hello", cursor: 2 }, "y");
    expect(inserted).toEqual({ value: "heyllo", cursor: 3 });

    const deleted = deleteBackAtCursor({ value: "a🙂b", cursor: "a🙂".length });
    expect(deleted).toEqual({ value: "ab", cursor: "a".length });
  });

  it("deletes the previous word", () => {
    const value = "alpha beta gamma";

    const next = deleteWordBackAtCursor({ value, cursor: value.length });

    expect(next).toEqual({ value: "alpha beta ", cursor: "alpha beta ".length });
  });

  it("returns slash command suggestions", () => {
    expect(getCommandSuggestions("/sta").map((s) => s.name)).toEqual(["status"]);
    expect(getCommandSuggestions("/")).toContainEqual({
      name: "diff",
      description: "View uncommitted changes",
    });
    expect(getCommandSuggestions("/status now")).toEqual([]);
  });

  it("navigates history and restores the draft", () => {
    const history = ["first", "second"];
    const initial = {
      value: "draft",
      cursor: "draft".length,
      historyIndex: -1,
      savedDraft: "",
    };

    const upOnce = navigateComposerHistory(initial, history, "up");
    expect(upOnce).toMatchObject({
      value: "second",
      cursor: "second".length,
      historyIndex: 1,
      savedDraft: "draft",
      changed: true,
    });

    const upTwice = navigateComposerHistory(upOnce, history, "up");
    expect(upTwice.value).toBe("first");
    expect(upTwice.historyIndex).toBe(0);

    const downOnce = navigateComposerHistory(upTwice, history, "down");
    expect(downOnce.value).toBe("second");
    expect(downOnce.historyIndex).toBe(1);

    const restored = navigateComposerHistory(downOnce, history, "down");
    expect(restored).toMatchObject({
      value: "draft",
      cursor: "draft".length,
      historyIndex: -1,
      savedDraft: "draft",
      changed: true,
    });
  });

  it("completes selected slash suggestions with arrows, tab, and enter", () => {
    const initial = emptyComposerState("/");
    const down = reduceComposerInput(initial, "", { downArrow: true }, []);
    expect(down.state.selectedSuggestionIndex).toBe(1);

    const tab = reduceComposerInput(down.state, "", { tab: true }, []);
    expect(tab.state.value).toBe("/status ");
    expect(tab.state.cursor).toBe("/status ".length);

    const enter = reduceComposerInput(emptyComposerState("/sta"), "", { return: true }, []);
    expect(enter.state.value).toBe("/status ");
  });

  it("submits trimmed input and clears composer state", () => {
    const result = reduceComposerInput(emptyComposerState("  hello  "), "", { return: true }, []);

    expect(result.state.value).toBe("");
    expect(result.state.cursor).toBe(0);
    expect(result.effect).toEqual({ type: "submit", line: "hello" });
  });

  it("inserts newlines with shifted or meta return", () => {
    const shifted = reduceComposerInput(emptyComposerState("hello"), "", { return: true, shift: true }, []);
    expect(shifted.state.value).toBe("hello\n");
    expect(shifted.effect).toBeUndefined();

    const meta = reduceComposerInput(emptyComposerState("hello"), "", { return: true, meta: true }, []);
    expect(meta.state.value).toBe("hello\n");
  });

  it("keeps pasted multiline text as one insertion", () => {
    const result = reduceComposerInput(emptyComposerState("a"), "b\nc", {}, []);

    expect(result.state.value).toBe("ab\nc");
    expect(result.state.cursor).toBe("ab\nc".length);
  });

  it("finds current token for path completion", () => {
    expect(getCurrentToken("open ./src/in file", "open ./src/in".length)).toEqual({
      token: "./src/in",
      start: "open ".length,
      end: "open ./src/in".length,
    });
  });

  it("builds and applies path completions", () => {
    const state = { value: "read ./src/re", cursor: "read ./src/re".length };
    const completion = getPathCompletions(state.value, state.cursor, [
      "./src/repl/App.tsx",
      "./src/repl/InputBar.tsx",
      "./src/tools/index.ts",
    ]);

    expect(completion).toEqual({
      token: "./src/re",
      replacement: "./src/repl/",
      suggestions: ["./src/repl/App.tsx", "./src/repl/InputBar.tsx"],
    });
    expect(applyPathCompletion(state, completion!).value).toBe("read ./src/repl/");
  });

  it("maps control and escape keys to state changes or effects", () => {
    expect(reduceComposerInput(emptyComposerState("draft"), "c", { ctrl: true }, []).state.value).toBe("");
    expect(reduceComposerInput(emptyComposerState(""), "c", { ctrl: true }, []).effect).toEqual({ type: "exit" });
    expect(reduceComposerInput(emptyComposerState("/sta"), "", { escape: true }, []).state.value).toBe("");
    expect(reduceComposerInput(emptyComposerState("draft"), "", { escape: true }, []).effect).toEqual({ type: "cancel" });
  });

  it("maps paging and meta tool toggle keys to effects", () => {
    const state = emptyComposerState("draft");

    expect(reduceComposerInput(state, "", { pageUp: true }, []).effect).toEqual({ type: "scroll.up" });
    expect(reduceComposerInput(state, "", { pageDown: true }, []).effect).toEqual({ type: "scroll.down" });
    expect(reduceComposerInput(state, "o", { meta: true }, []).effect).toEqual({ type: "toggleToolOutput" });
    expect(reduceComposerInput(state, "ø", {}, []).effect).toEqual({ type: "toggleToolOutput" });
  });

  it("handles cursor, deletion, and ctrl editing shortcuts", () => {
    const value = "alpha beta";
    const state = emptyComposerState(value);

    expect(reduceComposerInput(state, "", { leftArrow: true, meta: true }, []).state.cursor).toBe("alpha ".length);
    expect(reduceComposerInput(state, "a", { ctrl: true }, []).state.cursor).toBe(0);
    expect(reduceComposerInput(state, "e", { ctrl: true }, []).state.cursor).toBe(value.length);
    expect(reduceComposerInput(state, "k", { ctrl: true }, []).state.value).toBe(value);
    expect(reduceComposerInput({ ...state, cursor: "alpha ".length }, "k", { ctrl: true }, []).state.value).toBe("alpha ");
    expect(reduceComposerInput(state, "u", { ctrl: true }, []).state.value).toBe("");
    expect(reduceComposerInput(state, "w", { ctrl: true }, []).state.value).toBe("alpha ");
  });

  it("navigates history through the reducer", () => {
    const history = ["first", "second"];
    const up = reduceComposerInput(emptyComposerState("draft"), "", { upArrow: true }, history);
    expect(up.state.value).toBe("second");
    expect(up.state.savedDraft).toBe("draft");

    const down = reduceComposerInput(up.state, "", { downArrow: true }, history);
    expect(down.state.value).toBe("draft");
    expect(down.state.historyIndex).toBe(-1);
  });
});

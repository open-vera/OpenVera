import { describe, expect, it, vi } from "vitest";
import { pathApprovalPrompt, questionPrompt } from "../src/repl/ui/state/blockingPrompt.js";
import { emptyOverlay, reduceOverlay } from "../src/repl/ui/state/overlayStore.js";

describe("reduceOverlay", () => {
  it("opens and closes the diff overlay", () => {
    const opened = reduceOverlay(emptyOverlay(), { type: "open.diff" });

    expect(opened).toEqual({ type: "diff" });
    expect(reduceOverlay(opened, { type: "close" })).toEqual({ type: "none" });
  });

  it("opens and closes the session picker overlay", () => {
    const opened = reduceOverlay(emptyOverlay(), { type: "open.sessionPicker" });

    expect(opened).toEqual({ type: "sessionPicker" });
    expect(reduceOverlay(opened, { type: "close" })).toEqual({ type: "none" });
  });

  it("stores approval prompts", () => {
    const prompt = pathApprovalPrompt({
      message: "Allow access?",
      allowDir: "/tmp/project",
      resolve: vi.fn(),
    });

    const opened = reduceOverlay(emptyOverlay(), { type: "open.prompt", prompt });

    expect(opened).toEqual({ type: "prompt", prompt });
  });

  it("stores question prompts", () => {
    const prompt = questionPrompt({
      questions: [{ question: "Pick one", options: [{ label: "A", value: "a" }] }],
      resolve: vi.fn(),
    });

    const opened = reduceOverlay(emptyOverlay(), { type: "open.prompt", prompt });

    expect(opened).toEqual({ type: "prompt", prompt });
  });

  it("replaces the active overlay when a new one opens", () => {
    const first = reduceOverlay(emptyOverlay(), { type: "open.diff" });
    const second = reduceOverlay(first, { type: "open.sessionPicker" });

    expect(second).toEqual({ type: "sessionPicker" });
  });
});

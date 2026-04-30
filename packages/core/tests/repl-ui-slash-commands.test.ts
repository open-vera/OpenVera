import { describe, expect, it } from "vitest";
import {
  formatStatusMessage,
  handleQueueCommand,
  isProcessCommand,
  isUiCommand,
  parseSlashCommand,
} from "../src/repl/ui/controller/slashCommands.js";
import { emptyAccumulatedCost } from "../src/session/index.js";

describe("slashCommands", () => {
  it("parses slash commands but not absolute paths", () => {
    expect(parseSlashCommand("/status")).toEqual({ cmd: "status", args: [] });
    expect(parseSlashCommand("/resume abc --all")).toEqual({ cmd: "resume", args: ["abc", "--all"] });
    expect(parseSlashCommand("/Users/example/project")).toBeNull();
    expect(parseSlashCommand("hello")).toBeNull();
  });

  it("classifies process and UI commands", () => {
    expect(isProcessCommand("exit")).toBe(true);
    expect(isProcessCommand("quit")).toBe(true);
    expect(isUiCommand("diff")).toBe(true);
    expect(isUiCommand("queue")).toBe(true);
    expect(isUiCommand("status", "status")).toBe(true);
    expect(isUiCommand("resume")).toBe(false);
  });

  it("handles queue UI commands", () => {
    expect(handleQueueCommand([], ["one", "two"])).toEqual({ type: "message", content: "1. one\n2. two" });
    expect(handleQueueCommand(["drop", "2"], ["one", "two"])).toEqual({
      type: "remove",
      index: 1,
      content: "Removed queued input #2.",
    });
    expect(handleQueueCommand(["edit", "1", "updated", "input"], ["one"])).toEqual({
      type: "update",
      index: 0,
      input: "updated input",
      content: "Updated queued input #1.",
    });
    expect(handleQueueCommand(["clear"], ["one", "two"])).toEqual({
      type: "clear",
      content: "Cleared 2 queued inputs.",
    });
    expect(handleQueueCommand(["edit", "3", "x"], ["one"]).content).toContain("Invalid queue index");
  });

  it("formats status messages from routing, usage, and cost state", () => {
    const status = formatStatusMessage(
      { provider: "anthropic", model: "claude-test", intent: { level: 2, domain: "code", needs_tools: true } },
      { inputTotal: 10, outputTotal: 20, cacheWriteTotal: 1, cacheReadTotal: 2, costUsd: 0.1234 },
      100,
      3,
      emptyAccumulatedCost(),
    );

    expect(status).toContain("Provider: anthropic");
    expect(status).toContain("Model:    claude-test");
    expect(status).toContain("Turns:    3");
    expect(status).toContain("Tokens:   in 10 / out 20");
    expect(status).toContain("Intent:   L2");
  });
});

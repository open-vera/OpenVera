import { describe, expect, it, vi } from "vitest";
import type { ReplContext } from "../src/repl/context.js";
import type { ChatMessage } from "../src/repl/ui/types.js";
import {
  handleSlashCommandSubmission,
  type HandleSlashCommandSubmissionOptions,
} from "../src/repl/ui/controller/commandSubmission.js";

function baseOptions(overrides: Partial<HandleSlashCommandSubmissionOptions> = {}) {
  let messages: ChatMessage[] = [];
  const dispatchOverlay = vi.fn();
  const exit = vi.fn();
  const writeEnd = vi.fn();
  const queue = {
    items: ["one", "two"],
    clearQueue: vi.fn(),
    removeQueued: vi.fn(),
    updateQueued: vi.fn(),
  };
  const aiTitleState = { hasCustomTitle: false, generated: false, attempts: 0 };
  return {
    messagesRef: { get current() { return messages; } },
    dispatchOverlay,
    exit,
    writeEnd,
    queue,
    aiTitleState,
    options: {
      line: "/status",
      slashCommand: { cmd: "status", args: [] },
      ctx: {
        sessionStore: { writeEnd },
      } as unknown as ReplContext,
      routing: { provider: "test", model: "model", intent: null },
      usage: { inputTotal: 1, outputTotal: 2, cacheWriteTotal: 0, cacheReadTotal: 0, costUsd: 0.01 },
      latestInputTokens: 10,
      turnCount: 3,
      cost: { totalUsage: { input_tokens: 4, output_tokens: 5 }, totalUsd: 0.25, byModel: {} },
      lastInput: "last prompt",
      aiTitleState,
      queue,
      setMessages: (updater) => {
        messages = updater(messages);
      },
      dispatchOverlay,
      exit,
      captureCommand: vi.fn(async () => "runtime output"),
      ...overrides,
    } satisfies HandleSlashCommandSubmissionOptions,
  };
}

describe("commandSubmission", () => {
  it("handles process commands by writing session end and exiting", async () => {
    const base = baseOptions({ line: "/exit", slashCommand: { cmd: "exit", args: [] } });

    await handleSlashCommandSubmission(base.options);

    expect(base.writeEnd).toHaveBeenCalledWith({ input_tokens: 4, output_tokens: 5 }, 0.25, 3, "last prompt");
    expect(base.exit).toHaveBeenCalled();
    expect(base.messagesRef.current).toEqual([]);
  });

  it("handles diff UI command without adding transcript messages", async () => {
    const base = baseOptions({ line: "/diff", slashCommand: { cmd: "diff", args: [] } });

    await handleSlashCommandSubmission(base.options);

    expect(base.dispatchOverlay).toHaveBeenCalledWith({ type: "open.diff" });
    expect(base.messagesRef.current).toEqual([]);
  });

  it("handles status UI command", async () => {
    const base = baseOptions();

    await handleSlashCommandSubmission(base.options);

    expect(base.messagesRef.current[0]).toEqual({ role: "user", content: "/status" });
    expect(base.messagesRef.current[1]?.role).toBe("assistant");
    expect(base.messagesRef.current[1]?.content).toContain("Provider: test");
  });

  it("handles queue mutations", async () => {
    const base = baseOptions({ line: "/queue drop 2", slashCommand: { cmd: "queue", args: ["drop", "2"] } });

    await handleSlashCommandSubmission(base.options);

    expect(base.queue.removeQueued).toHaveBeenCalledWith(1);
    expect(base.messagesRef.current.at(-1)).toEqual({ role: "assistant", content: "Removed queued input #2." });
  });

  it("marks custom title and captures runtime command output", async () => {
    const captureCommand = vi.fn(async () => "title set");
    const base = baseOptions({
      line: "/title New title",
      slashCommand: { cmd: "title", args: ["New", "title"] },
      captureCommand,
    });

    await handleSlashCommandSubmission(base.options);

    expect(base.aiTitleState.hasCustomTitle).toBe(true);
    expect(captureCommand).toHaveBeenCalledWith("title", ["New", "title"], base.options.ctx);
    expect(base.messagesRef.current).toEqual([
      { role: "user", content: "/title New title" },
      { role: "assistant", content: "title set" },
    ]);
  });

  it("does not add assistant message when command returns null (overlay opened)", async () => {
    const captureCommand = vi.fn(async () => null);
    const base = baseOptions({
      line: "/resume",
      slashCommand: { cmd: "resume", args: [] },
      captureCommand,
    });

    const result = await handleSlashCommandSubmission(base.options);

    expect(result).toEqual({ handled: true });
    expect(captureCommand).toHaveBeenCalledWith("resume", [], base.options.ctx);
    // Only the user message; no spurious assistant message
    expect(base.messagesRef.current).toEqual([
      { role: "user", content: "/resume" },
    ]);
  });
});

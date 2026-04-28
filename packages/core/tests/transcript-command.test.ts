import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subCommand, transcriptCommand } from "../src/repl/commands/transcript.js";
import type { ReplContext } from "../src/repl/context.js";
import { SessionStore } from "../src/session/store.js";

describe("/sub command", () => {
  let tempHome: string;
  let cwd: string;
  const originalVeraHome = process.env.VERA_HOME;

  beforeEach(() => {
    tempHome = join(tmpdir(), `vera-transcript-home-${crypto.randomUUID()}`);
    cwd = join(tmpdir(), `vera-transcript-repo-${crypto.randomUUID()}`);
    mkdirSync(tempHome, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    process.env.VERA_HOME = tempHome;
  });

  afterEach(() => {
    process.env.VERA_HOME = originalVeraHome;
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function ctx(): ReplContext {
    return {
      cwd,
      sessionStore: new SessionStore({ cwd }),
    } as unknown as ReplContext;
  }

  function createTranscript(sessionId?: string, targetCwd = cwd): string {
    const parent = new SessionStore({ cwd: targetCwd });
    parent.writeStart("claude-sonnet-4-6", "anthropic");
    parent.writeUser("Parent prompt");

    const child = new SessionStore({ cwd: targetCwd, sessionId });
    child.writeStart("claude-sonnet-4-6", "anthropic");
    child.writeBranch({
      parentSessionId: parent.sessionId,
      title: "subagent:reviewer",
      status: "active",
    });
    const userUuid = child.writeUser("Review auth");
    const toolUuid = child.writeToolCall({
      parentUuid: userUuid,
      toolName: "read_file",
      toolCallId: "read_file",
      arguments: { path: "src/auth.ts" },
    });
    child.writeToolResult({
      parentUuid: toolUuid,
      toolCallId: "read_file",
      content: "auth source",
    });
    child.writeAssistant({
      parentUuid: userUuid,
      content: "Review complete",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      stopReason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
      turn: 1,
      latencyMs: 12,
      toolCalls: ["read_file"],
      status: "ok",
    });
    child.writeEnd({ input_tokens: 10, output_tokens: 5 }, 0.001, 1, "Review auth");
    return child.sessionId;
  }

  function createMultiTurnTranscript(): string {
    const child = new SessionStore({ cwd });
    child.writeStart("claude-sonnet-4-6", "anthropic");
    for (let i = 1; i <= 3; i++) {
      const userUuid = child.writeUser(`Question ${i}`);
      child.writeAssistant({
        parentUuid: userUuid,
        content: `Answer ${i}`,
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
        turn: i,
        latencyMs: 1,
        toolCalls: [],
        status: "ok",
      });
    }
    child.writeEnd({ input_tokens: 3, output_tokens: 3 }, 0.001, 3, "Question 3");
    return child.sessionId;
  }

  it("prints a subagent transcript preview by session id prefix", async () => {
    const sessionId = createTranscript();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await subCommand([sessionId.slice(0, 8)], ctx());

    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain(`Transcript ${sessionId.slice(0, 8)}`);
    expect(output).toContain("subagent:reviewer");
    expect(output).toContain("User: Review auth");
    expect(output).toContain("Assistant: Review complete");
    expect(output).toContain("Tool: read_file");
    expect(output).toContain("auth source");
  });

  it("shows usage when no session prefix is provided", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await subCommand([], ctx());

    expect(log).toHaveBeenCalledWith("Usage: /sub <session-id-prefix> [--all] [--limit N]");
  });

  it("reports unknown and ambiguous transcript prefixes", async () => {
    createTranscript("same-a");
    createTranscript("same-b");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await subCommand(["missing"], ctx());
    expect(log).toHaveBeenCalledWith('No session found with prefix "missing".');

    log.mockClear();
    await subCommand(["same"], ctx());
    expect(log).toHaveBeenCalledWith('Ambiguous prefix "same" — 2 sessions match:');
  });

  it("keeps /transcript as a compatibility alias", async () => {
    const sessionId = createTranscript();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await transcriptCommand([sessionId.slice(0, 8)], ctx());

    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain(`Transcript ${sessionId.slice(0, 8)}`);
  });

  it("loads transcripts from other projects when --all is provided", async () => {
    const otherCwd = join(tmpdir(), `vera-transcript-other-${crypto.randomUUID()}`);
    mkdirSync(otherCwd, { recursive: true });
    const sessionId = createTranscript("other-subagent", otherCwd);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await subCommand([sessionId.slice(0, 8), "--all"], ctx());

    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain(`Transcript ${sessionId.slice(0, 8)}`);
    expect(output).toContain("Assistant: Review complete");
    rmSync(otherCwd, { recursive: true, force: true });
  });

  it("respects --limit and reports hidden earlier messages", async () => {
    const sessionId = createMultiTurnTranscript();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await subCommand([sessionId.slice(0, 8), "--limit", "2"], ctx());

    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).not.toContain("Question 1");
    expect(output).toContain("User: Question 3");
    expect(output).toContain("Assistant: Answer 3");
    expect(output).toContain("… 4 earlier messages hidden. Use --limit 6 to show all.");
  });
});

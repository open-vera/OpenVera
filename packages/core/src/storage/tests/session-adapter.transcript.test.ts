/**
 * SessionStorageAdapter tests — transcript
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStorageProvider } from "../sqlite.js";
import { SessionStorageAdapter, migrateJsonlToSqlite } from "../session-adapter.js";
import type { SessionEntry } from "../../session/types.js";
import type { SessionFilter } from "../session-adapter.js";
import {
  makeDbPath,
  makeJsonlContent,
  createSessionAdapterEnv,
  clearAllSessions,
  destroySessionAdapterEnv,
} from "./session-adapter-test-helpers.js";

describe("SessionStorageAdapter — transcript", () => {
  let adapter: SessionStorageAdapter;
  let storage: SqliteStorageProvider;
  let tmpDir: string;

  beforeAll(async () => {
    const env = await createSessionAdapterEnv();
    adapter = env.adapter;
    storage = env.storage;
    tmpDir = env.tmpDir;
  });

  afterAll(async () => {
    await destroySessionAdapterEnv(adapter, tmpDir);
  });

  afterEach(async () => {
    await clearAllSessions(adapter);
  });

  describe("loadTranscriptPreview", () => {
    it("should load transcript with user and assistant messages", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "claude-3", "anthropic", "/tmp");
      await adapter.writeUser(id, "user message");
      await adapter.writeAssistant(id, {
        parentUuid: "p1",
        content: "assistant message",
        model: "claude-3",
        provider: "anthropic",
        stopReason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 20 },
        turn: 1,
        latencyMs: 100,
        toolCalls: [],
        status: "ok",
      });

      const transcript = await adapter.loadTranscriptPreview(id);
      expect(transcript.sessionId).toBe(id);
      expect(transcript.messages.length).toBe(2);
      expect(transcript.messages[0]!.role).toBe("user");
      expect(transcript.messages[0]!.content).toBe("user message");
      expect(transcript.messages[1]!.role).toBe("assistant");
      expect(transcript.messages[1]!.content).toBe("assistant message");
      // No tool calls, so no toolUses
      expect(transcript.messages[1]!.toolUses).toBeUndefined();
    });

    it("should include tool uses in assistant messages", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "claude-3", "anthropic", "/tmp");
      await adapter.writeUser(id, "run ls");

      const asstUuid = await adapter.writeAssistant(id, {
        parentUuid: "p1",
        content: "let me run that command",
        model: "claude-3",
        provider: "anthropic",
        stopReason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 20 },
        turn: 1,
        latencyMs: 100,
        toolCalls: ["bash"],
        status: "ok",
      });

      const tcUuid = await adapter.writeToolCall(id, {
        parentUuid: asstUuid,
        toolName: "bash",
        toolCallId: "tc1",
        arguments: { command: "ls" },
      });

      await adapter.writeToolResult(id, {
        parentUuid: tcUuid,
        toolCallId: "tc1",
        content: "file1.txt\nfile2.txt",
      });

      const transcript = await adapter.loadTranscriptPreview(id);
      expect(transcript.messages.length).toBe(2); // user + assistant

      const asstMsg = transcript.messages[1]!;
      expect(asstMsg.role).toBe("assistant");
      expect(asstMsg.toolUses).toBeDefined();
      expect(asstMsg.toolUses!.length).toBe(1);
      expect(asstMsg.toolUses![0]!.name).toBe("bash");
      expect(asstMsg.toolUses![0]!.args).toEqual({ command: "ls" });
      expect(asstMsg.toolUses![0]!.result.ok).toBe(true);
      expect(asstMsg.toolUses![0]!.result.content).toBe("file1.txt\nfile2.txt");
    });

    it("should show 'no tool result recorded' when tool result is missing", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "claude-3", "anthropic", "/tmp");
      await adapter.writeUser(id, "run ls");

      const asstUuid = await adapter.writeAssistant(id, {
        parentUuid: "p1",
        content: "running command",
        model: "claude-3",
        provider: "anthropic",
        stopReason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 20 },
        turn: 1,
        latencyMs: 100,
        toolCalls: ["bash"],
        status: "ok",
      });

      // Write tool call but no tool result
      await adapter.writeToolCall(id, {
        parentUuid: asstUuid,
        toolName: "bash",
        toolCallId: "tc1",
        arguments: { command: "ls" },
      });

      const transcript = await adapter.loadTranscriptPreview(id);
      const asstMsg = transcript.messages[1]!;
      expect(asstMsg.toolUses![0]!.result.ok).toBe(false);
      expect(asstMsg.toolUses![0]!.result.content).toBe(
        "(no tool result recorded)",
      );
    });

    it("should throw on loading transcript for non-existent session", async () => {
      await expect(
        adapter.loadTranscriptPreview("nonexistent"),
      ).rejects.toThrow();
    });
  });

  // ── loadEntries ─────────────────────────────────────────────────────────

  describe("loadEntries", () => {
    it("should throw on loading entries for non-existent session", async () => {
      await expect(adapter.loadEntries("nonexistent")).rejects.toThrow();
    });
  });

  // ── fork/branch operations ──────────────────────────────────────────────


});

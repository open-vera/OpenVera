/**
 * SQ4: Session storage migration tests — SQLite-backed SessionStorageAdapter
 *
 * Tests cover:
 * - Session creation and entry appending
 * - User/assistant/tool call/tool result entries
 * - Session listing with filters
 * - Session loading for resume
 * - Session deletion
 * - Fork/branch operations
 * - JSONL migration from files
 * - Boundary cases (empty sessions, missing sessions)
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStorageProvider } from "../sqlite.js";
import {
  SessionStorageAdapter,
  migrateJsonlToSqlite,
} from "../session-adapter.js";
import type { SessionEntry } from "../../session/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "session-adapter-test-"));
  return join(dir, "test.db");
}

function makeJsonlContent(sessionId: string): string {
  const lines = [
    JSON.stringify({
      type: "session_start",
      sessionId,
      timestamp: new Date().toISOString(),
      cwd: "/tmp/test",
      model: "claude-3",
      provider: "anthropic",
    }),
    JSON.stringify({
      type: "user",
      sessionId,
      timestamp: new Date().toISOString(),
      uuid: crypto.randomUUID(),
      content: "hello world",
    }),
    JSON.stringify({
      type: "assistant",
      sessionId,
      timestamp: new Date().toISOString(),
      uuid: crypto.randomUUID(),
      parentUuid: "p1",
      content: "hi there",
      model: "claude-3",
      provider: "anthropic",
      stopReason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 20 },
      turn: 1,
      latencyMs: 100,
      toolCalls: [],
      status: "ok",
    }),
  ];
  return lines.join("\n") + "\n";
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("SessionStorageAdapter (SQ4)", () => {
  let adapter: SessionStorageAdapter;
  let storage: SqliteStorageProvider;
  let tmpDir: string;

  beforeAll(async () => {
    const dbPath = makeDbPath();
    tmpDir = join(dbPath, "..");
    storage = new SqliteStorageProvider({ backend: "sqlite", dbPath, enableFts: true });
    adapter = new SessionStorageAdapter(storage);
    await adapter.initialize();
  });

  afterAll(async () => {
    await adapter.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    const { sessions } = await adapter.listSessions();
    for (const s of sessions) {
      await adapter.deleteSession(s.sessionId);
    }
  });

  describe("session creation", () => {
    it("should create a new session with session_start entry", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "claude-3", "anthropic", "/tmp");

      const loaded = await adapter.loadSession(id);
      expect(loaded).toBeDefined();
      expect(loaded.sessionId).toBe(id);
      expect(loaded.cwd).toBe("/tmp");
      expect(loaded.model).toBe("claude-3");
      expect(loaded.provider).toBe("anthropic");
    });

    it("should check session existence with hasSession", async () => {
      const id = crypto.randomUUID();
      expect(await adapter.hasSession(id)).toBe(false);

      await adapter.createSession(id, "m", "p", "/");
      expect(await adapter.hasSession(id)).toBe(true);
    });
  });

  describe("entry appending", () => {
    it("should append user entry and update metadata", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "claude-3", "anthropic", "/tmp");

      const uuid = await adapter.writeUser(id, "hello");
      expect(uuid).toBeDefined();

      const entries = await adapter.loadEntries(id);
      const userEntries = entries.filter((e) => e.type === "user");
      expect(userEntries.length).toBe(1);
      expect((userEntries[0] as { content: string }).content).toBe("hello");
    });

    it("should append assistant entry with usage tracking", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "claude-3", "anthropic", "/tmp");
      await adapter.writeUser(id, "test");

      const uuid = await adapter.writeAssistant(id, {
        parentUuid: "p1",
        content: "response",
        model: "claude-3",
        provider: "anthropic",
        stopReason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 100 },
        turn: 1,
        latencyMs: 200,
        toolCalls: [],
        status: "ok",
      });
      expect(uuid).toBeDefined();

      const loaded = await adapter.loadSession(id);
      expect(loaded.totalUsage.input_tokens).toBe(50);
      expect(loaded.totalUsage.output_tokens).toBe(100);
      expect(loaded.turnCount).toBe(1);
    });

    it("should append tool call entry", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");

      const uuid = await adapter.writeToolCall(id, {
        parentUuid: "p1",
        toolName: "bash",
        toolCallId: "tc1",
        arguments: { command: "ls" },
      });
      expect(uuid).toBeDefined();

      const entries = await adapter.loadEntries(id);
      const toolEntries = entries.filter((e) => e.type === "tool_call");
      expect(toolEntries.length).toBe(1);
    });

    it("should append tool result entry", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");

      await adapter.writeToolResult(id, {
        parentUuid: "p1",
        toolCallId: "tc1",
        content: "file1\nfile2",
      });

      const entries = await adapter.loadEntries(id);
      const resultEntries = entries.filter((e) => e.type === "tool_result");
      expect(resultEntries.length).toBe(1);
    });

    it("should throw on appending to non-existent session", async () => {
      const entry = {
        type: "user" as const,
        sessionId: "nonexistent",
        timestamp: new Date().toISOString(),
        uuid: crypto.randomUUID(),
        content: "x",
      } as SessionEntry;
      await expect(adapter.appendEntry("nonexistent", entry)).rejects.toThrow();
    });
  });

  describe("session loading", () => {
    it("should load session with replayed history", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "claude-3", "anthropic", "/tmp");
      await adapter.writeUser(id, "user message 1");
      await adapter.writeAssistant(id, {
        parentUuid: "p1",
        content: "assistant response",
        model: "claude-3",
        provider: "anthropic",
        stopReason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 20 },
        turn: 1,
        latencyMs: 100,
        toolCalls: [],
        status: "ok",
      });
      await adapter.writeUser(id, "user message 2");

      const loaded = await adapter.loadSession(id);
      expect(loaded.history.length).toBe(3);
      expect(loaded.history[0]!.role).toBe("user");
      expect(loaded.history[1]!.role).toBe("assistant");
      expect(loaded.history[2]!.role).toBe("user");
    });

    it("should throw on loading non-existent session", async () => {
      await expect(adapter.loadSession("nonexistent")).rejects.toThrow();
    });

    it("should accumulate usage across multiple turns", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "claude-3", "anthropic", "/tmp");

      for (let i = 0; i < 3; i++) {
        await adapter.writeAssistant(id, {
          parentUuid: `p${i}`,
          content: `response ${i}`,
          model: "claude-3",
          provider: "anthropic",
          stopReason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 20 },
          turn: i + 1,
          latencyMs: 100,
          toolCalls: [],
          status: "ok",
        });
      }

      const loaded = await adapter.loadSession(id);
      expect(loaded.totalUsage.input_tokens).toBe(30);
      expect(loaded.totalUsage.output_tokens).toBe(60);
      expect(loaded.turnCount).toBe(3);
    });
  });

  describe("session listing", () => {
    it("should list sessions sorted by last activity", async () => {
      const id1 = crypto.randomUUID();
      const id2 = crypto.randomUUID();

      await adapter.createSession(id1, "claude-3", "anthropic", "/tmp");
      await adapter.writeUser(id1, "first session");

      await new Promise((r) => setTimeout(r, 10));

      await adapter.createSession(id2, "claude-3", "anthropic", "/tmp");
      await adapter.writeUser(id2, "second session");

      const { sessions } = await adapter.listSessions();
      expect(sessions.length).toBe(2);
      expect(sessions[0]!.lastActivityAt.getTime()).toBeGreaterThanOrEqual(
        sessions[1]!.lastActivityAt.getTime(),
      );
    });

    it("should paginate with limit and offset", async () => {
      for (let i = 0; i < 5; i++) {
        const id = crypto.randomUUID();
        await adapter.createSession(id, "m", "p", "/");
        await adapter.writeUser(id, `session ${i}`);
      }

      const { sessions, nextOffset } = await adapter.listSessions({
        limit: 2,
        offset: 0,
      });
      expect(sessions.length).toBe(2);
      expect(nextOffset).toBeDefined();
    });

    it("should filter by cwd", async () => {
      const id1 = crypto.randomUUID();
      const id2 = crypto.randomUUID();

      await adapter.createSession(id1, "m", "p", "/project-a");
      await adapter.writeUser(id1, "proj a");

      await adapter.createSession(id2, "m", "p", "/project-b");
      await adapter.writeUser(id2, "proj b");

      const { sessions } = await adapter.listSessions({ cwd: "/project-a" });
      expect(sessions.length).toBe(1);
      expect(sessions[0]!.cwd).toBe("/project-a");
    });
  });

  describe("session deletion", () => {
    it("should delete an existing session", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");

      expect(await adapter.deleteSession(id)).toBe(true);
      expect(await adapter.hasSession(id)).toBe(false);
    });

    it("should return false for non-existent session deletion", async () => {
      expect(await adapter.deleteSession("nonexistent")).toBe(false);
    });
  });

  describe("custom title", () => {
    it("should set and retrieve custom title", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");
      await adapter.writeUser(id, "test prompt");
      await adapter.writeTitle(id, "My Custom Title");

      const summary = await adapter.getSessionSummary(id);
      expect(summary).toBeDefined();
      expect(summary!.title).toBe("My Custom Title");
    });
  });

  describe("fork/branch operations", () => {
    it("should fork a session with replayable entries", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "claude-3", "anthropic", "/tmp");
      await adapter.writeUser(id, "original message");
      await adapter.writeAssistant(id, {
        parentUuid: "p1",
        content: "original response",
        model: "claude-3",
        provider: "anthropic",
        stopReason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 20 },
        turn: 1,
        latencyMs: 100,
        toolCalls: [],
        status: "ok",
      });

      const forked = await adapter.forkSession({
        fromSessionId: id,
        title: "Test Fork",
      });

      expect(forked.sessionId).toBeDefined();
      expect(forked.sessionId).not.toBe(id);
      expect(forked.parentSessionId).toBe(id);

      const forkedLoaded = await adapter.loadSession(forked.sessionId);
      expect(forkedLoaded.history.length).toBeGreaterThanOrEqual(2);
    });

    it("should throw when forking non-existent session", async () => {
      await expect(
        adapter.forkSession({ fromSessionId: "nonexistent" }),
      ).rejects.toThrow();
    });

    it("should list branches of a parent session", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");
      await adapter.writeUser(id, "parent message");

      await adapter.forkSession({ fromSessionId: id, title: "Branch A" });
      await adapter.forkSession({ fromSessionId: id, title: "Branch B" });

      const branches = await adapter.listBranches(id);
      expect(branches.length).toBe(2);
    });

    it("should update branch status", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");
      await adapter.writeUser(id, "parent");

      const forked = await adapter.forkSession({ fromSessionId: id });
      await adapter.updateBranchStatus(forked.sessionId, "merged");

      const meta = await adapter.getBranchMetadata(forked.sessionId);
      expect(meta).toBeDefined();
      expect(meta!.status).toBe("merged");
    });
  });

  describe("session end", () => {
    it("should write session end entry with totals", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");
      await adapter.writeUser(id, "test");

      await adapter.writeEnd(
        id,
        { input_tokens: 100, output_tokens: 200 },
        0.05,
        3,
        "last prompt",
      );

      const entries = await adapter.loadEntries(id);
      const endEntry = entries.find((e) => e.type === "session_end");
      expect(endEntry).toBeDefined();
    });
  });

  describe("health check", () => {
    it("should report healthy when initialized", () => {
      expect(adapter.isHealthy()).toBe(true);
    });
  });
});

// ── Migration tests ────────────────────────────────────────────────────────

describe("migrateJsonlToSqlite (SQ4)", () => {
  let adapter: SessionStorageAdapter;
  let storage: SqliteStorageProvider;
  let tmpDir: string;
  let sessionsDir: string;

  beforeAll(async () => {
    const dbPath = makeDbPath();
    tmpDir = join(dbPath, "..");
    sessionsDir = join(tmpDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    storage = new SqliteStorageProvider({ backend: "sqlite", dbPath });
    adapter = new SessionStorageAdapter(storage);
    await adapter.initialize();
  });

  afterAll(async () => {
    await adapter.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should migrate JSONL files to SQLite", async () => {
    const sessionId = "test-session-001";
    const content = makeJsonlContent(sessionId);
    writeFileSync(join(sessionsDir, `${sessionId}.jsonl`), content);

    const count = await migrateJsonlToSqlite(adapter, sessionsDir);
    expect(count).toBe(1);
    expect(await adapter.hasSession(sessionId)).toBe(true);
  });

  it("should skip already-migrated sessions", async () => {
    const count = await migrateJsonlToSqlite(adapter, sessionsDir);
    expect(count).toBe(0);
  });

  it("should handle empty directory gracefully", async () => {
    const emptyDir = join(tmpDir, "empty-sessions");
    mkdirSync(emptyDir, { recursive: true });

    const count = await migrateJsonlToSqlite(adapter, emptyDir);
    expect(count).toBe(0);
  });

  it("should handle non-existent directory gracefully", async () => {
    const count = await migrateJsonlToSqlite(adapter, "/nonexistent/dir");
    expect(count).toBe(0);
  });

  it("should skip empty files", async () => {
    writeFileSync(join(sessionsDir, "empty.jsonl"), "");
    const count = await migrateJsonlToSqlite(adapter, sessionsDir);
    expect(count).toBe(0);
  });

  it("should migrate multiple sessions", async () => {
    const newDir = join(tmpDir, "multi-sessions");
    mkdirSync(newDir, { recursive: true });

    for (let i = 0; i < 3; i++) {
      const id = `multi-${i}`;
      writeFileSync(join(newDir, `${id}.jsonl`), makeJsonlContent(id));
    }

    const count = await migrateJsonlToSqlite(adapter, newDir);
    expect(count).toBe(3);
  });
});

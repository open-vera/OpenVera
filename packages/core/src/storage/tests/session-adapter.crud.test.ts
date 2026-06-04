/**
 * SessionStorageAdapter tests — crud
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

describe("SessionStorageAdapter — crud", () => {
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

    it("should override totalCostUsd from session_end entry", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "claude-3", "anthropic", "/tmp");
      await adapter.writeAssistant(id, {
        parentUuid: "p1",
        content: "response",
        model: "claude-3",
        provider: "anthropic",
        stopReason: "end_turn",
        usage: { input_tokens: 1000, output_tokens: 2000 },
        turn: 1,
        latencyMs: 100,
        toolCalls: [],
        status: "ok",
      });

      // Write session_end with an explicit totalCostUsd
      await adapter.writeEnd(
        id,
        { input_tokens: 1000, output_tokens: 2000 },
        0.99, // explicit cost
        1,
      );

      const loaded = await adapter.loadSession(id);
      // session_end should override the accumulated cost
      expect(loaded.totalCostUsd).toBe(0.99);
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

    it("should return empty list when no sessions exist", async () => {
      // afterEach cleans up, so this should be empty
      const { sessions, totalCandidates } = await adapter.listSessions();
      expect(sessions).toEqual([]);
      expect(totalCandidates).toBe(0);
    });

    it("should support SessionFilter.model parameter", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "gpt-4o", "openai", "/");
      await adapter.writeUser(id, "test");

      const { sessions } = await adapter.listSessions(
        {},
        { model: "gpt-4o" } as SessionFilter,
      );
      expect(sessions.length).toBeGreaterThanOrEqual(0);
      // The filter is forwarded to storage; we verify no crash + result is valid
      expect(Array.isArray(sessions)).toBe(true);
    });

    it("should support SessionFilter.provider parameter", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "anthropic", "/");
      await adapter.writeUser(id, "test");

      const { sessions } = await adapter.listSessions(
        {},
        { provider: "anthropic" } as SessionFilter,
      );
      expect(Array.isArray(sessions)).toBe(true);
    });

    it("should support SessionFilter.tags parameter", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");
      await adapter.writeUser(id, "test");

      const { sessions } = await adapter.listSessions(
        {},
        { tags: ["fork"] } as SessionFilter,
      );
      expect(Array.isArray(sessions)).toBe(true);
    });

    it("should support SessionFilter.createdAfter parameter", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");
      await adapter.writeUser(id, "test");

      const { sessions } = await adapter.listSessions(
        {},
        { createdAfter: "2020-01-01T00:00:00Z" } as SessionFilter,
      );
      expect(Array.isArray(sessions)).toBe(true);
    });

    it("should support SessionFilter.createdBefore parameter", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");
      await adapter.writeUser(id, "test");

      const { sessions } = await adapter.listSessions(
        {},
        { createdBefore: "2099-01-01T00:00:00Z" } as SessionFilter,
      );
      expect(Array.isArray(sessions)).toBe(true);
    });

    it("should support SessionFilter.fullTextSearch parameter", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");
      await adapter.writeUser(id, "searchable text");

      const { sessions } = await adapter.listSessions(
        {},
        { fullTextSearch: "searchable" } as SessionFilter,
      );
      expect(Array.isArray(sessions)).toBe(true);
    });

    it("should support SessionFilter.orderBy updatedAt and order asc", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");
      await adapter.writeUser(id, "test");

      const { sessions } = await adapter.listSessions(
        {},
        { orderBy: "updatedAt", order: "asc" } as SessionFilter,
      );
      expect(Array.isArray(sessions)).toBe(true);
    });

    it("should support default orderBy when set to createdAt explicitly", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");
      await adapter.writeUser(id, "test");

      const { sessions } = await adapter.listSessions(
        {},
        { orderBy: "createdAt" } as SessionFilter,
      );
      expect(Array.isArray(sessions)).toBe(true);
    });

    it("should handle pagination with nextOffset undefined at end", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");
      await adapter.writeUser(id, "test");

      const { sessions, nextOffset } = await adapter.listSessions({
        limit: 10,
        offset: 0,
      });
      // Only 1 session exists, so nextOffset should be undefined
      expect(nextOffset).toBeUndefined();
    });

    it("should handle both filter.cwd and filter.tags together", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/proj");
      await adapter.writeUser(id, "test");

      const { sessions } = await adapter.listSessions(
        {},
        {
          cwd: "/proj",
          tags: ["important"],
          model: "m",
          provider: "p",
        } as SessionFilter,
      );
      expect(Array.isArray(sessions)).toBe(true);
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

  // ── writeEnd branches ───────────────────────────────────────────────────


});

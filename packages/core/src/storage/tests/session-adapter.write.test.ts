/**
 * SessionStorageAdapter tests — write
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

describe("SessionStorageAdapter — write", () => {
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

  describe("writeEnd", () => {
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

    it("should create last-prompt entry when lastPrompt is provided", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");
      await adapter.writeUser(id, "test");

      await adapter.writeEnd(
        id,
        { input_tokens: 100, output_tokens: 200 },
        0.05,
        3,
        "this was my last prompt",
      );

      const entries = await adapter.loadEntries(id);
      const lpEntry = entries.find((e) => e.type === "last-prompt");
      expect(lpEntry).toBeDefined();
      // The preview storage may store lastPrompt field
      const lp = lpEntry as { lastPrompt?: string };
      expect(lp.lastPrompt).toBeDefined();
    });

    it("should not create last-prompt entry when lastPrompt is omitted", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");
      await adapter.writeUser(id, "test");

      await adapter.writeEnd(
        id,
        { input_tokens: 100, output_tokens: 200 },
        0.05,
        3,
        // no lastPrompt argument
      );

      const entries = await adapter.loadEntries(id);
      const lpEntry = entries.find((e) => e.type === "last-prompt");
      expect(lpEntry).toBeUndefined();
      const endEntry = entries.find((e) => e.type === "session_end");
      expect(endEntry).toBeDefined();
    });

    it("should not create last-prompt entry when lastPrompt is whitespace-only", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");
      await adapter.writeUser(id, "test");

      await adapter.writeEnd(
        id,
        { input_tokens: 100, output_tokens: 200 },
        0.05,
        3,
        "   \t\n  ", // whitespace only
      );

      const entries = await adapter.loadEntries(id);
      const lpEntry = entries.find((e) => e.type === "last-prompt");
      expect(lpEntry).toBeUndefined();
      const endEntry = entries.find((e) => e.type === "session_end");
      expect(endEntry).toBeDefined();
    });

    it("should truncate lastPrompt longer than 120 characters", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");
      await adapter.writeUser(id, "test");

      const longPrompt = "a".repeat(200);
      await adapter.writeEnd(
        id,
        { input_tokens: 100, output_tokens: 200 },
        0.05,
        3,
        longPrompt,
      );

      const entries = await adapter.loadEntries(id);
      const lpEntry = entries.find((e) => e.type === "last-prompt");
      expect(lpEntry).toBeDefined();
      const lp = lpEntry as { lastPrompt?: string };
      expect(lp.lastPrompt!.length).toBeLessThanOrEqual(120);
      expect(lp.lastPrompt!.endsWith("...")).toBe(true);
    });

    it("should handle lastPrompt exactly at 120 chars without truncation", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");
      await adapter.writeUser(id, "test");

      const exactPrompt = "a".repeat(120);
      await adapter.writeEnd(
        id,
        { input_tokens: 100, output_tokens: 200 },
        0.05,
        3,
        exactPrompt,
      );

      const entries = await adapter.loadEntries(id);
      const lpEntry = entries.find((e) => e.type === "last-prompt");
      expect(lpEntry).toBeDefined();
      const lp = lpEntry as { lastPrompt?: string };
      // 120 chars exactly should not append "..."
      expect(lp.lastPrompt).toBe(exactPrompt);
    });
  });

  // ── writeBranch ─────────────────────────────────────────────────────────

  describe("writeBranch", () => {
    it("should write a branch entry with only required fields", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");
      await adapter.writeUser(id, "parent message");

      await adapter.writeBranch(id, {
        parentSessionId: "parent-001",
      });

      const entries = await adapter.loadEntries(id);
      const branchEntry = entries.find((e) => e.type === "branch");
      expect(branchEntry).toBeDefined();
      expect((branchEntry as { parentSessionId: string }).parentSessionId).toBe(
        "parent-001",
      );
    });

    it("should write a branch entry with all optional fields", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");
      await adapter.writeUser(id, "parent message");

      await adapter.writeBranch(id, {
        parentSessionId: "parent-001",
        forkedFromUuid: "uuid-001",
        title: "Feature Branch",
        status: "active",
        worktreePath: "/tmp/wt",
        worktreeBranch: "feat/xyz",
        baseCommit: "abc123",
      });

      const entries = await adapter.loadEntries(id);
      const branchEntry = entries.find((e) => e.type === "branch");
      expect(branchEntry).toBeDefined();
      const b = branchEntry as Record<string, unknown>;
      expect(b.parentSessionId).toBe("parent-001");
      expect(b.forkedFromUuid).toBe("uuid-001");
      expect(b.title).toBe("Feature Branch");
      expect(b.status).toBe("active");
      expect(b.worktreePath).toBe("/tmp/wt");
      expect(b.worktreeBranch).toBe("feat/xyz");
      expect(b.baseCommit).toBe("abc123");
    });

    it("should write a branch entry with discarded status", async () => {
      const id = crypto.randomUUID();
      await adapter.createSession(id, "m", "p", "/");
      await adapter.writeUser(id, "msg");

      await adapter.writeBranch(id, {
        parentSessionId: "parent-002",
        status: "discarded",
      });

      const entries = await adapter.loadEntries(id);
      const branchEntry = entries.find((e) => e.type === "branch");
      expect(branchEntry).toBeDefined();
      expect((branchEntry as { status: string }).status).toBe("discarded");
    });
  });

  // ── loadTranscriptPreview ───────────────────────────────────────────────


});

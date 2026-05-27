import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/session/store.js";
import { SQLiteSessionBackend } from "../src/session/sqlite-backend.js";
import type { SessionStoreBackend } from "../src/session/backend.js";
import { SqliteStorageProvider } from "../src/storage/sqlite.js";
import { SessionStorageAdapter, migrateJsonlToSqlite } from "../src/storage/session-adapter.js";

describe("SQLiteSessionBackend", () => {
  let tempDir: string;
  let dbPath: string;
  let backend: SQLiteSessionBackend;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "vera-sqlite-test-"));
    dbPath = join(tempDir, "sessions.db");
    backend = new SQLiteSessionBackend(dbPath);
    await backend.initialize();
  });

  afterEach(async () => {
    await backend.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should initialize and be healthy", () => {
    expect(backend.isHealthy()).toBe(true);
    expect(backend.name).toBe("sqlite");
  });

  it("should write and read a session", () => {
    const sessionId = "test-session-1";
    const cwd = "/tmp/test";

    backend.writeStart(sessionId, cwd, "gpt-4", "openai");
    const userUuid = backend.writeUser(sessionId, cwd, "Hello world");
    backend.writeAssistant(sessionId, cwd, {
      parentUuid: userUuid,
      content: "Hi there!",
      model: "gpt-4",
      provider: "openai",
      stopReason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 20 },
      turn: 1,
      latencyMs: 500,
      toolCalls: [],
      status: "ok",
    });
    backend.writeEnd(sessionId, cwd, { input_tokens: 10, output_tokens: 20 }, 0.01, 1);

    const loaded = backend.loadSession(sessionId, cwd);
    expect(loaded.sessionId).toBe(sessionId);
    expect(loaded.history).toHaveLength(2);
    expect(loaded.history[0]).toEqual({ role: "user", content: "Hello world" });
    expect(loaded.history[1]).toEqual({ role: "assistant", content: "Hi there!" });
    expect(loaded.turnCount).toBe(1);
    expect(loaded.model).toBe("gpt-4");
  });

  it("should list sessions with cwd filter", () => {
    backend.writeStart("s1", "/project-a", "gpt-4", "openai");
    backend.writeUser("s1", "/project-a", "Task A");
    backend.writeEnd("s1", "/project-a", { input_tokens: 1, output_tokens: 1 }, 0.01, 1);

    backend.writeStart("s2", "/project-b", "gpt-4", "openai");
    backend.writeUser("s2", "/project-b", "Task B");
    backend.writeEnd("s2", "/project-b", { input_tokens: 1, output_tokens: 1 }, 0.01, 1);

    const all = backend.listSessions();
    expect(all.sessions).toHaveLength(2);

    const filtered = backend.listSessions({ cwd: "/project-a" });
    expect(filtered.sessions).toHaveLength(1);
    expect(filtered.sessions[0].sessionId).toBe("s1");
  });

  it("should write and read tool calls", () => {
    const sid = "tool-test";
    backend.writeStart(sid, "/tmp", "gpt-4", "openai");
    const userUuid = backend.writeUser(sid, "/tmp", "Read file");
    const toolUuid = backend.writeToolCall(sid, "/tmp, ", {
      parentUuid: userUuid,
      toolName: "read_file",
      toolCallId: "tc1",
      arguments: { path: "README.md" },
    });
    backend.writeToolResult(sid, "/tmp", {
      parentUuid: toolUuid,
      toolCallId: "tc1",
      content: "File contents here",
    });
    backend.writeAssistant(sid, "/tmp", {
      parentUuid: userUuid,
      content: "Done reading",
      model: "gpt-4",
      provider: "openai",
      stopReason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 5 },
      turn: 1,
      latencyMs: 100,
      toolCalls: ["read_file"],
      status: "ok",
    });

    const preview = backend.loadTranscriptPreview(sid, "/tmp");
    expect(preview.messages).toHaveLength(2);
    expect(preview.messages[1].toolUses).toBeDefined();
    expect(preview.messages[1].toolUses![0].name).toBe("read_file");
  });

  it("should write metadata entries", () => {
    const sid = "meta-test";
    backend.writeStart(sid, "/tmp", "gpt-4", "openai");
    backend.writeTitle(sid, "/tmp", "My Title");
    backend.writeAiTitle(sid, "/tmp", "AI Generated Title");
    backend.writeTag(sid, "/tmp", "p0");
    backend.writeGitBranch(sid, "/tmp", "feature/test");
    backend.writeSummary(sid, "/tmp", "Test summary");
    backend.writeUser(sid, "/tmp", "content");
    backend.writeEnd(sid, "/tmp", { input_tokens: 1, output_tokens: 1 }, 0.01, 1);

    const { sessions } = backend.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe("My Title");
    expect(sessions[0].tag).toBe("p0");
    expect(sessions[0].gitBranch).toBe("feature/test");
  });

  it("should fork a session", () => {
    const parentSid = "parent-session";
    backend.writeStart(parentSid, "/tmp", "gpt-4", "openai");
    const u = backend.writeUser(parentSid, "/tmp", "Original question");
    backend.writeAssistant(parentSid, "/tmp, ", {
      parentUuid: u,
      content: "Original answer",
      model: "gpt-4",
      provider: "openai",
      stopReason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 5 },
      turn: 1,
      latencyMs: 100,
      toolCalls: [],
      status: "ok",
    });
    backend.writeEnd(parentSid, "/tmp", { input_tokens: 5, output_tokens: 5 }, 0.01, 1);

    const forked = backend.forkSession({
      fromSessionId: parentSid,
      title: "experiment",
    });

    expect(forked.parentSessionId).toBe(parentSid);
    expect(forked.title).toBe("experiment");

    const loaded = backend.loadSession(forked.sessionId);
    expect(loaded.history).toHaveLength(2);
    expect(loaded.history[0]).toEqual({ role: "user", content: "Original question" });
  });

  it("should list and manage branches", () => {
    const parentSid = "branch-parent";
    backend.writeStart(parentSid, "/tmp", "gpt-4", "openai");
    backend.writeUser(parentSid, "/tmp", "Q");
    backend.writeEnd(parentSid, "/tmp", { input_tokens: 1, output_tokens: 1 }, 0.01, 1);

    const branch = backend.forkSession({
      fromSessionId: parentSid,
      title: "try-1",
    });

    let branches = backend.listBranches(parentSid);
    expect(branches).toHaveLength(1);
    expect(branches[0].branch?.status).toBe("active");

    backend.discardBranch(branch.sessionId);
    branches = backend.listBranches(parentSid);
    expect(branches).toHaveLength(0);

    // Verify the discarded branch still exists in the full list
    const all = backend.listSessions();
    const discarded = all.sessions.find((s) => s.sessionId === branch.sessionId);
    expect(discarded?.branch?.status).toBe("discarded");
  });

  it("should adopt and merge branches", () => {
    const parentSid = "adopt-parent";
    backend.writeStart(parentSid, "/tmp", "gpt-4", "openai");
    backend.writeUser(parentSid, "/tmp", "Q");
    backend.writeEnd(parentSid, "/tmp", { input_tokens: 1, output_tokens: 1 }, 0.01, 1);

    const branch = backend.forkSession({
      fromSessionId: parentSid,
      title: "adopt-me",
    });

    backend.adoptBranch(branch.sessionId);
    let branches = backend.listBranches(parentSid);
    expect(branches[0].branch?.status).toBe("adopted");

    backend.markBranchMerged(branch.sessionId);
    branches = backend.listBranches(parentSid);
    expect(branches[0].branch?.status).toBe("merged");
  });

  it("should throw SessionNotFoundError for missing sessions", () => {
    expect(() => backend.loadSession("nonexistent")).toThrow();
  });

  it("should throw SessionNotBranchError for non-branch discard", () => {
    backend.writeStart("not-a-branch", "/tmp", "gpt-4", "openai");
    backend.writeUser("not-a-branch", "/tmp", "Q");
    expect(() => backend.discardBranch("not-a-branch")).toThrow();
  });
});

describe("JSONL to SQLite migration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vera-migration-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should migrate JSONL files to SQLite", async () => {
    // Create JSONL session files
    const sessionsDir = join(tempDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    const session1Content = [
      JSON.stringify({ type: "session_start", sessionId: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp", model: "gpt-4", provider: "openai" }),
      JSON.stringify({ type: "user", sessionId: "s1", timestamp: "2026-01-01T00:00:01Z", uuid: "u1", content: "Hello" }),
      JSON.stringify({ type: "assistant", sessionId: "s1", timestamp: "2026-01-01T00:00:02Z", uuid: "a1", parentUuid: "u1", content: "Hi!", model: "gpt-4", provider: "openai", stopReason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 }, turn: 1, latencyMs: 100, toolCalls: [], status: "ok" }),
      JSON.stringify({ type: "session_end", sessionId: "s1", timestamp: "2026-01-01T00:00:03Z", totalUsage: { input_tokens: 5, output_tokens: 5 }, totalCostUsd: 0.01, turnCount: 1 }),
    ].join("\n") + "\n";

    writeFileSync(join(sessionsDir, "s1.jsonl"), session1Content);

    // Create SQLite backend and migrate
    const dbPath = join(tempDir, "migrated.db");
    const backend = new SQLiteSessionBackend(dbPath);
    await backend.initialize();

    const migrated = await backend.migrateFromJsonl(sessionsDir);
    expect(migrated).toBe(1);

    // Verify migration
    const loaded = backend.loadSession("s1");
    expect(loaded.history).toHaveLength(2);
    expect(loaded.history[0]).toEqual({ role: "user", content: "Hello" });
    expect(loaded.history[1]).toEqual({ role: "assistant", content: "Hi!" });

    await backend.close();
  });

  it("should skip empty files and already migrated sessions", async () => {
    const sessionsDir = join(tempDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    // Empty file
    writeFileSync(join(sessionsDir, "empty.jsonl"), "");

    // Valid session
    const validContent = [
      JSON.stringify({ type: "session_start", sessionId: "valid", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp", model: "gpt-4", provider: "openai" }),
      JSON.stringify({ type: "user", sessionId: "valid", timestamp: "2026-01-01T00:00:01Z", uuid: "u1", content: "Q" }),
    ].join("\n") + "\n";
    writeFileSync(join(sessionsDir, "valid.jsonl"), validContent);

    const dbPath = join(tempDir, "skip-test.db");
    const backend = new SQLiteSessionBackend(dbPath);
    await backend.initialize();

    // First migration
    const m1 = await backend.migrateFromJsonl(sessionsDir);
    expect(m1).toBe(1);

    // Second migration should skip already migrated
    const m2 = await backend.migrateFromJsonl(sessionsDir);
    expect(m2).toBe(0);

    await backend.close();
  });

  it("should return 0 for nonexistent directory", async () => {
    const dbPath = join(tempDir, "no-dir.db");
    const backend = new SQLiteSessionBackend(dbPath);
    await backend.initialize();

    const migrated = await backend.migrateFromJsonl(join(tempDir, "nonexistent"));
    expect(migrated).toBe(0);

    await backend.close();
  });
});

describe("SessionStore backend delegation", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vera-delegation-test-"));
    process.env.VERA_HOME = tempDir;
    SessionStore.configure(null); // Reset to JSONL
  });

  afterEach(() => {
    SessionStore.configure(null);
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.VERA_HOME;
  });

  it("should work with JSONL backend (default)", () => {
    const cwd = mkdtempSync(join(tempDir, "project-"));
    const store = new SessionStore({ cwd });
    store.writeStart("gpt-4", "openai");
    store.writeUser("Test message");

    const sessions = SessionStore.listSessions(cwd);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].summary).toBe("Test message");
  });

  it("should delegate to SQLite backend when configured", async () => {
    const dbPath = join(tempDir, "delegation.db");
    const backend = new SQLiteSessionBackend(dbPath);
    await backend.initialize();
    SessionStore.configure(backend);

    const cwd = "/tmp/delegation-test";
    const store = new SessionStore({ cwd });
    store.writeStart("gpt-4", "openai");
    store.writeUser("SQLite message");
    store.writeEnd({ input_tokens: 1, output_tokens: 1 }, 0.01, 1);

    const sessions = SessionStore.listSessions(cwd);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].summary).toBe("SQLite message");

    const loaded = SessionStore.loadSession(store.sessionId, cwd);
    expect(loaded.history).toHaveLength(1);
    expect(loaded.history[0]).toEqual({ role: "user", content: "SQLite message" });

    SessionStore.configure(null);
    await backend.close();
  });

  it("should return null backend when not configured", () => {
    expect(SessionStore.getBackend()).toBeNull();
  });

  it("should preserve session metadata with SQLite backend", async () => {
    const dbPath = join(tempDir, "metadata.db");
    const backend = new SQLiteSessionBackend(dbPath);
    await backend.initialize();
    SessionStore.configure(backend);

    const cwd = "/tmp/meta-test";
    const store = new SessionStore({ cwd });
    store.writeStart("gpt-4", "openai");
    store.writeTitle("My Session");
    store.writeTag("important");
    store.writeGitBranch("feature/test");
    store.writeUser("content");
    store.writeEnd({ input_tokens: 1, output_tokens: 1 }, 0.01, 1);

    const sessions = SessionStore.listSessions(cwd);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe("My Session");
    expect(sessions[0].tag).toBe("important");
    expect(sessions[0].gitBranch).toBe("feature/test");

    SessionStore.configure(null);
    await backend.close();
  });

  it("should fork sessions with SQLite backend", async () => {
    const dbPath = join(tempDir, "fork.db");
    const backend = new SQLiteSessionBackend(dbPath);
    await backend.initialize();
    SessionStore.configure(backend);

    const cwd = "/tmp/fork-test";
    const parent = new SessionStore({ cwd });
    parent.writeStart("gpt-4", "openai");
    const u = parent.writeUser("Original");
    parent.writeAssistant({
      parentUuid: u,
      content: "Response",
      model: "gpt-4",
      provider: "openai",
      stopReason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 5 },
      turn: 1,
      latencyMs: 100,
      toolCalls: [],
      status: "ok",
    });
    parent.writeEnd({ input_tokens: 5, output_tokens: 5 }, 0.01, 1);

    const forked = SessionStore.forkSession({
      fromSessionId: parent.sessionId,
      title: "experiment",
    });

    expect(forked.parentSessionId).toBe(parent.sessionId);
    expect(forked.title).toBe("experiment");

    const branches = SessionStore.listBranches(parent.sessionId, cwd);
    expect(branches).toHaveLength(1);
    expect(branches[0].branch?.status).toBe("active");

    SessionStore.configure(null);
    await backend.close();
  });

  it("should handle branch status transitions with SQLite", async () => {
    const dbPath = join(tempDir, "branch-status.db");
    const backend = new SQLiteSessionBackend(dbPath);
    await backend.initialize();
    SessionStore.configure(backend);

    const cwd = "/tmp/branch-test";
    const parent = new SessionStore({ cwd });
    parent.writeStart("gpt-4", "openai");
    parent.writeUser("Q");
    parent.writeEnd({ input_tokens: 1, output_tokens: 1 }, 0.01, 1);

    const branch = SessionStore.forkSession({
      fromSessionId: parent.sessionId,
      title: "try-1",
    });

    // Adopt
    SessionStore.adoptBranch(branch.sessionId, cwd);
    let branches = SessionStore.listBranches(parent.sessionId, cwd);
    expect(branches[0].branch?.status).toBe("adopted");

    // Merge
    SessionStore.markBranchMerged(branch.sessionId, cwd);
    branches = SessionStore.listBranches(parent.sessionId, cwd);
    expect(branches[0].branch?.status).toBe("merged");

    SessionStore.configure(null);
    await backend.close();
  });

  it("should write PR link entries with SQLite backend", async () => {
    const dbPath = join(tempDir, "prlink.db");
    const backend = new SQLiteSessionBackend(dbPath);
    await backend.initialize();
    SessionStore.configure(backend);

    const cwd = "/tmp/pr-test";
    const store = new SessionStore({ cwd });
    store.writeStart("gpt-4", "openai");
    store.writePrLink({
      prUrl: "https://github.com/test/pr/1",
      prRepository: "test/repo",
      prNumber: 1,
    });
    store.writeUser("content");
    store.writeEnd({ input_tokens: 1, output_tokens: 1 }, 0.01, 1);

    // PR link is stored as metadata in the session
    const sessions = SessionStore.listSessions(cwd);
    expect(sessions).toHaveLength(1);

    SessionStore.configure(null);
    await backend.close();
  });
});

/**
 * migrateJsonlToSqlite tests
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SqliteStorageProvider } from "../sqlite.js";
import { SessionStorageAdapter, migrateJsonlToSqlite } from "../session-adapter.js";
import { makeDbPath, makeJsonlContent } from "./session-adapter-test-helpers.js";

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

  it("should skip files with unparseable content but valid file size", async () => {
    const newDir = join(tmpDir, "corrupt-sessions");
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, "corrupt.jsonl"), "not json\nstill not json\n");

    const count = await migrateJsonlToSqlite(adapter, newDir);
    // All lines unparseable → entries.length === 0 → skipped
    expect(count).toBe(0);
  });

  it("should handle migration with mixed valid/invalid lines", async () => {
    const newDir = join(tmpDir, "mixed-sessions");
    mkdirSync(newDir, { recursive: true });

    const content = [
      JSON.stringify({ type: "session_start", sessionId: "mixed-1", timestamp: new Date().toISOString(), cwd: "/", model: "m", provider: "p" }),
      "not valid json",
      JSON.stringify({ type: "user", sessionId: "mixed-1", timestamp: new Date().toISOString(), uuid: crypto.randomUUID(), content: "hello" }),
    ].join("\n") + "\n";
    writeFileSync(join(newDir, "mixed-1.jsonl"), content);

    const count = await migrateJsonlToSqlite(adapter, newDir);
    expect(count).toBe(1);
    expect(await adapter.hasSession("mixed-1")).toBe(true);
  });

  it("should extract metadata from session_end entry during migration", async () => {
    const newDir = join(tmpDir, "end-sessions");
    mkdirSync(newDir, { recursive: true });

    const sessionId = "end-test-1";
    const content = [
      JSON.stringify({ type: "session_start", sessionId, timestamp: new Date().toISOString(), cwd: "/proj", model: "claude-3", provider: "anthropic" }),
      JSON.stringify({ type: "user", sessionId, timestamp: new Date().toISOString(), uuid: crypto.randomUUID(), content: "hello" }),
      JSON.stringify({ type: "assistant", sessionId, timestamp: new Date().toISOString(), uuid: crypto.randomUUID(), parentUuid: "p1", content: "hi", model: "claude-3", provider: "anthropic", stopReason: "end_turn", usage: { input_tokens: 10, output_tokens: 20 }, turn: 1, latencyMs: 100, toolCalls: [], status: "ok" }),
      JSON.stringify({ type: "session_end", sessionId, timestamp: new Date().toISOString(), totalUsage: { input_tokens: 100, output_tokens: 200 }, totalCostUsd: 0.42, turnCount: 3 }),
    ].join("\n") + "\n";
    writeFileSync(join(newDir, `${sessionId}.jsonl`), content);

    const count = await migrateJsonlToSqlite(adapter, newDir);
    expect(count).toBe(1);
    expect(await adapter.hasSession(sessionId)).toBe(true);

    // Verify turnCount and cost from session_end were captured
    const summary = await adapter.getSessionSummary(sessionId);
    expect(summary).toBeDefined();
    expect(summary!.turnCount).toBe(3);
    expect(summary!.totalCostUsd).toBe(0.42);
  });

  it("should extract metadata from custom-title entry during migration", async () => {
    const newDir = join(tmpDir, "customtitle-sessions");
    mkdirSync(newDir, { recursive: true });

    const sessionId = "customtitle-test-1";
    const content = [
      JSON.stringify({ type: "session_start", sessionId, timestamp: new Date().toISOString(), cwd: "/", model: "m", provider: "p" }),
      JSON.stringify({ type: "user", sessionId, timestamp: new Date().toISOString(), uuid: crypto.randomUUID(), content: "prompt" }),
      JSON.stringify({ type: "custom-title", sessionId, timestamp: new Date().toISOString(), customTitle: "Migration Custom Title" }),
    ].join("\n") + "\n";
    writeFileSync(join(newDir, `${sessionId}.jsonl`), content);

    const count = await migrateJsonlToSqlite(adapter, newDir);
    expect(count).toBe(1);

    const summary = await adapter.getSessionSummary(sessionId);
    expect(summary).toBeDefined();
    expect(summary!.title).toBe("Migration Custom Title");
  });

  it("should extract metadata from ai-title entry during migration", async () => {
    const newDir = join(tmpDir, "aititle-sessions");
    mkdirSync(newDir, { recursive: true });

    const sessionId = "aititle-test-1";
    const content = [
      JSON.stringify({ type: "session_start", sessionId, timestamp: new Date().toISOString(), cwd: "/", model: "m", provider: "p" }),
      JSON.stringify({ type: "user", sessionId, timestamp: new Date().toISOString(), uuid: crypto.randomUUID(), content: "prompt" }),
      JSON.stringify({ type: "ai-title", sessionId, timestamp: new Date().toISOString(), aiTitle: "Migration AI Title" }),
    ].join("\n") + "\n";
    writeFileSync(join(newDir, `${sessionId}.jsonl`), content);

    const count = await migrateJsonlToSqlite(adapter, newDir);
    expect(count).toBe(1);

    const summary = await adapter.getSessionSummary(sessionId);
    expect(summary).toBeDefined();
    expect(summary!.title).toBe("Migration AI Title");
  });

  it("should extract tag from tag entry during migration", async () => {
    const newDir = join(tmpDir, "tag-sessions");
    mkdirSync(newDir, { recursive: true });

    const sessionId = "tag-test-1";
    const content = [
      JSON.stringify({ type: "session_start", sessionId, timestamp: new Date().toISOString(), cwd: "/", model: "m", provider: "p" }),
      JSON.stringify({ type: "user", sessionId, timestamp: new Date().toISOString(), uuid: crypto.randomUUID(), content: "tagged prompt" }),
      JSON.stringify({ type: "tag", sessionId, timestamp: new Date().toISOString(), tag: "migrated-important" }),
    ].join("\n") + "\n";
    writeFileSync(join(newDir, `${sessionId}.jsonl`), content);

    const count = await migrateJsonlToSqlite(adapter, newDir);
    expect(count).toBe(1);

    const summary = await adapter.getSessionSummary(sessionId);
    expect(summary).toBeDefined();
    expect(summary!.tag).toBe("migrated-important");
  });
});


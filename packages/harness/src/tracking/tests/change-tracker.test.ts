/**
 * Tests for ChangeTracker and ChangeStore — agent tool call logging.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChangeStore } from "../change-store.js";
import { ChangeTracker } from "../change-tracker.js";
import type { ChangeRecord } from "../change-store.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "change-tracker-"));
}

function makeRecord(overrides: Partial<ChangeRecord> = {}): ChangeRecord {
  return {
    timestamp: new Date().toISOString(),
    agentId: "test-agent",
    toolName: "write_file",
    args: '{"file_path":"/test.ts"}',
    success: true,
    filesChanged: ["/test.ts"],
    summary: "Wrote /test.ts",
    ...overrides,
  };
}

// ── ChangeStore ──────────────────────────────────────────────────────────────

describe("ChangeStore", () => {
  let tmpDir: string;
  let store: ChangeStore;

  beforeEach(async () => {
    tmpDir = createTmpDir();
    store = new ChangeStore({ storeDir: tmpDir });
    await store.initialize();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should create store directory", () => {
    expect(existsSync(tmpDir)).toBe(true);
  });

  it("should append records to daily file", async () => {
    const record = makeRecord();
    await store.append(record);

    const today = new Date().toISOString().slice(0, 10);
    const filePath = join(tmpDir, `${today}.jsonl`);
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("write_file");
  });

  it("should query records by tool name", async () => {
    await store.append(makeRecord({ toolName: "write_file" }));
    await store.append(makeRecord({ toolName: "bash" }));
    await store.append(makeRecord({ toolName: "write_file" }));

    const results = await store.query({ toolName: "write_file" });
    expect(results).toHaveLength(2);
  });

  it("should query records by agent ID", async () => {
    await store.append(makeRecord({ agentId: "agent-1" }));
    await store.append(makeRecord({ agentId: "agent-2" }));

    const results = await store.query({ agentId: "agent-1" });
    expect(results).toHaveLength(1);
  });

  it("should query records by file path", async () => {
    await store.append(makeRecord({ filesChanged: ["/src/a.ts"] }));
    await store.append(makeRecord({ filesChanged: ["/src/b.ts"] }));

    const results = await store.query({ filePath: "/src/a.ts" });
    expect(results).toHaveLength(1);
  });

  it("should respect limit", async () => {
    for (let i = 0; i < 10; i++) {
      await store.append(makeRecord());
    }

    const results = await store.query({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("should return empty for no matches", async () => {
    await store.append(makeRecord({ toolName: "bash" }));
    const results = await store.query({ toolName: "nonexistent" });
    expect(results).toEqual([]);
  });

  it("should get statistics", async () => {
    await store.append(makeRecord());
    await store.append(makeRecord());

    const stats = await store.getStats();
    expect(stats.totalRecords).toBe(2);
    expect(stats.dayCount).toBe(1);
  });

  it("should return empty stats for empty store", async () => {
    const stats = await store.getStats();
    expect(stats.totalRecords).toBe(0);
    expect(stats.dayCount).toBe(0);
  });
});

// ── ChangeTracker ────────────────────────────────────────────────────────────

describe("ChangeTracker", () => {
  let tmpDir: string;
  let tracker: ChangeTracker;

  beforeEach(async () => {
    tmpDir = createTmpDir();
    tracker = new ChangeTracker({
      storeDir: tmpDir,
      agentId: "test-agent",
    });
    await tracker.initialize();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should create middleware", () => {
    const middleware = tracker.createMiddleware();
    expect(middleware.name).toBe("change-tracker");
    expect(middleware.after).toBeDefined();
  });

  it("should log tool calls via middleware", async () => {
    const middleware = tracker.createMiddleware();
    const ctx = { cwd: "/tmp", sessionId: "test" };

    await middleware.after!(
      "write_file",
      { file_path: "/test.ts" },
      { ok: true, content: "done" },
      ctx,
    );

    const records = await tracker.query({});
    expect(records).toHaveLength(1);
    expect(records[0].toolName).toBe("write_file");
    expect(records[0].success).toBe(true);
  });

  it("should skip read-only tools by default", async () => {
    const middleware = tracker.createMiddleware();
    const ctx = { cwd: "/tmp", sessionId: "test" };

    await middleware.after!(
      "read_file",
      { file_path: "/test.ts" },
      { ok: true, content: "file content" },
      ctx,
    );

    const records = await tracker.query({});
    expect(records).toHaveLength(0);
  });

  it("should track reads when configured", async () => {
    const readTracker = new ChangeTracker({
      storeDir: tmpDir,
      trackReads: true,
    });
    await readTracker.initialize();

    const middleware = readTracker.createMiddleware();
    const ctx = { cwd: "/tmp", sessionId: "test" };

    await middleware.after!(
      "read_file",
      { file_path: "/test.ts" },
      { ok: true, content: "content" },
      ctx,
    );

    const records = await readTracker.query({});
    expect(records).toHaveLength(1);
  });

  it("should extract changed files from write_file", async () => {
    const middleware = tracker.createMiddleware();
    const ctx = { cwd: "/tmp", sessionId: "test" };

    await middleware.after!(
      "write_file",
      { file_path: "/src/index.ts" },
      { ok: true, content: "done" },
      ctx,
    );

    const records = await tracker.query({});
    expect(records[0].filesChanged).toEqual(["/src/index.ts"]);
  });

  it("should record errors", async () => {
    const middleware = tracker.createMiddleware();
    const ctx = { cwd: "/tmp", sessionId: "test" };

    await middleware.after!(
      "bash",
      { command: "rm missing" },
      { ok: false, content: "", error: { code: "EXEC_ERROR", message: "File not found", retryable: false } },
      ctx,
    );

    const records = await tracker.query({});
    expect(records[0].success).toBe(false);
    expect(records[0].error).toBe("File not found");
  });
});

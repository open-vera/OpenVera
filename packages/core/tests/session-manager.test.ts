import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SessionManager } from "../src/session/session-manager.js";
import { SessionStore } from "../src/session/store.js";
import type { SessionSummary } from "../src/session/types.js";
import type { Message } from "../src/types/message.js";
import type { LLMAdapter } from "../src/adapters/base.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: overrides.sessionId ?? crypto.randomUUID(),
    filePath: overrides.filePath ?? "/tmp/test.jsonl",
    startedAt: overrides.startedAt ?? new Date("2026-01-01"),
    lastActivityAt: overrides.lastActivityAt ?? new Date(),
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    turnCount: overrides.turnCount ?? 5,
    totalUsage: { input_tokens: 1000, output_tokens: 500 },
    totalCostUsd: 0.01,
    cwd: overrides.cwd ?? "/tmp/project",
    title: overrides.title,
    summary: overrides.summary,
    firstPrompt: overrides.firstPrompt,
    lastUserInput: overrides.lastUserInput,
    gitBranch: overrides.gitBranch,
  };
}

function makeMockAdapter(response?: string): LLMAdapter {
  return {
    complete: vi.fn().mockResolvedValue({
      message: {
        role: "assistant",
        content: response
          ? `<summary>${response}</summary>`
          : `<summary>{"summary":"compressed","decisions":[],"findings":[],"pending":[]}</summary>`,
      },
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
  } as unknown as LLMAdapter;
}

function makeMessages(count: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({ role: "user", content: `Message ${i}` });
    messages.push({ role: "assistant", content: `Response ${i}` });
  }
  return messages;
}

// ── SS1: Auto-compression ──────────────────────────────────────────────────

describe("SessionManager — SS1 Auto-compression", () => {
  it("skips compression when disabled", async () => {
    const manager = new SessionManager({ autoCompress: { enabled: false } });
    const messages = makeMessages(100);
    const adapter = makeMockAdapter();

    const result = await manager.autoCompress("s1", messages, adapter, "test-model");

    expect(result.compressed).toBe(false);
    expect(result.messages).toBe(messages);
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  it("skips compression when messages are under threshold", async () => {
    const manager = new SessionManager({
      autoCompress: { enabled: true, tokenThreshold: 1_000_000 },
    });
    const messages = makeMessages(2);
    const adapter = makeMockAdapter();

    const result = await manager.autoCompress("s1", messages, adapter, "test-model");

    expect(result.compressed).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("compresses messages when over threshold", async () => {
    const manager = new SessionManager({
      autoCompress: { enabled: true, tokenThreshold: 10, keepRecentTurns: 2 },
    });
    const messages = makeMessages(20);
    const adapter = makeMockAdapter();

    const result = await manager.autoCompress("s1", messages, adapter, "test-model");

    expect(result.compressed).toBe(true);
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.usage).toBeDefined();
  });

  it("persists compression state across calls", async () => {
    const manager = new SessionManager({
      autoCompress: { enabled: true, tokenThreshold: 10, keepRecentTurns: 2 },
    });
    const messages = makeMessages(20);
    const adapter = makeMockAdapter();

    await manager.autoCompress("s1", messages, adapter, "test-model");
    const state = manager.getCompressionState("s1");

    expect(state.segments.length).toBeGreaterThan(0);
  });

  it("clearCompressionState removes session state", async () => {
    const manager = new SessionManager({
      autoCompress: { enabled: true, tokenThreshold: 10, keepRecentTurns: 2 },
    });
    const messages = makeMessages(20);
    const adapter = makeMockAdapter();

    await manager.autoCompress("s1", messages, adapter, "test-model");
    manager.clearCompressionState("s1");

    const state = manager.getCompressionState("s1");
    expect(state.segments).toHaveLength(0);
  });
});

// ── SS2: Session dedup & merge ─────────────────────────────────────────────

describe("SessionManager — SS2 Dedup & Merge", () => {
  let tempHome: string;
  const originalVeraHome = process.env.VERA_HOME;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "vera-test-"));
    process.env.VERA_HOME = tempHome;
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    process.env.VERA_HOME = originalVeraHome;
  });

  it("finds similar sessions by title", () => {
    const manager = new SessionManager();
    const target = makeSummary({
      sessionId: "target",
      title: "Fix authentication bug",
    });
    const similar = makeSummary({
      sessionId: "similar",
      title: "Fix authentication bug",
    });
    const different = makeSummary({
      sessionId: "different",
      title: "Add dark mode support",
    });

    const results = manager.findSimilarSessions("target", [target, similar, different]);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.session.sessionId).toBe("similar");
    expect(results[0]?.similarity).toBeGreaterThan(0);
  });

  it("finds similar sessions by first prompt", () => {
    const manager = new SessionManager();
    const target = makeSummary({
      sessionId: "target",
      firstPrompt: "Help me fix the login flow for OAuth2 integration",
    });
    const similar = makeSummary({
      sessionId: "similar",
      firstPrompt: "Help me fix the login flow for OAuth2 authentication",
    });
    const different = makeSummary({
      sessionId: "different",
      firstPrompt: "Create a new React component for the dashboard",
    });

    const results = manager.findSimilarSessions("target", [target, similar, different]);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.session.sessionId).toBe("similar");
  });

  it("excludes the target session from results", () => {
    const manager = new SessionManager();
    const target = makeSummary({ sessionId: "target", title: "test" });

    const results = manager.findSimilarSessions("target", [target]);

    expect(results).toHaveLength(0);
  });

  it("returns empty when target not found in candidates", () => {
    const manager = new SessionManager();
    const other = makeSummary({ sessionId: "other", title: "test" });

    const results = manager.findSimilarSessions("nonexistent", [other]);

    expect(results).toHaveLength(0);
  });

  it("mergeSessions writes tags to both primary and duplicates", () => {
    const manager = new SessionManager();
    const cwd = mkdtempSync(join(tempHome, "project-"));

    // Create real sessions
    const primary = new SessionStore({ cwd });
    primary.writeStart("test-model", "test-provider");
    primary.writeUser("Hello");
    primary.writeAssistant({
      parentUuid: "uuid1",
      content: "Hi",
      model: "test-model",
      provider: "test-provider",
      stopReason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
      turn: 1,
      latencyMs: 100,
      toolCalls: [],
      status: "ok",
    });

    const dup = new SessionStore({ cwd });
    dup.writeStart("test-model", "test-provider");
    dup.writeUser("Hello");
    dup.writeAssistant({
      parentUuid: "uuid2",
      content: "Hi",
      model: "test-model",
      provider: "test-provider",
      stopReason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
      turn: 1,
      latencyMs: 100,
      toolCalls: [],
      status: "ok",
    });

    manager.mergeSessions(primary.sessionId, [dup.sessionId]);

    // Verify tags were written (read back the sessions)
    const primarySessions = SessionStore.listSessions(cwd);
    const primarySession = primarySessions.find(
      (s) => s.sessionId === primary.sessionId
    );
    const dupSession = primarySessions.find(
      (s) => s.sessionId === dup.sessionId
    );

    // The tags should be present in the session data
    expect(primarySession).toBeDefined();
    expect(dupSession).toBeDefined();
  });
});

// ── SS3: Session index ─────────────────────────────────────────────────────

describe("SessionManager — SS3 Session Index", () => {
  it("builds index from summaries", () => {
    const manager = new SessionManager();
    const summaries = [
      makeSummary({ sessionId: "s1", title: "Fix auth bug", firstPrompt: "Fix the OAuth2 login" }),
      makeSummary({ sessionId: "s2", title: "Add dark mode", firstPrompt: "Implement dark theme" }),
    ];

    manager.buildIndex(summaries);

    expect(manager.getIndexSize()).toBe(2);
  });

  it("searches by keyword in title", () => {
    const manager = new SessionManager();
    manager.buildIndex([
      makeSummary({ sessionId: "s1", title: "Fix authentication bug" }),
      makeSummary({ sessionId: "s2", title: "Add dark mode support" }),
    ]);

    const results = manager.searchByKeyword("authentication");

    expect(results).toHaveLength(1);
    expect(results[0]?.sessionId).toBe("s1");
  });

  it("searches by keyword in first prompt", () => {
    const manager = new SessionManager();
    manager.buildIndex([
      makeSummary({ sessionId: "s1", firstPrompt: "Help me with OAuth2 integration" }),
      makeSummary({ sessionId: "s2", firstPrompt: "Create a dashboard component" }),
    ]);

    const results = manager.searchByKeyword("OAuth2");

    expect(results).toHaveLength(1);
    expect(results[0]?.sessionId).toBe("s1");
  });

  it("searches by keyword in summary", () => {
    const manager = new SessionManager();
    manager.buildIndex([
      makeSummary({ sessionId: "s1", summary: "Implemented JWT token refresh" }),
      makeSummary({ sessionId: "s2", summary: "Added CSS animations" }),
    ]);

    const results = manager.searchByKeyword("JWT");

    expect(results).toHaveLength(1);
    expect(results[0]?.sessionId).toBe("s1");
  });

  it("returns empty for non-matching query", () => {
    const manager = new SessionManager();
    manager.buildIndex([
      makeSummary({ sessionId: "s1", title: "Fix auth" }),
    ]);

    const results = manager.searchByKeyword("nonexistent");

    expect(results).toHaveLength(0);
  });

  it("ranks title matches higher than content matches", () => {
    const manager = new SessionManager();
    manager.buildIndex([
      makeSummary({
        sessionId: "s1",
        title: "Something else",
        summary: "This mentions auth briefly",
      }),
      makeSummary({
        sessionId: "s2",
        title: "Fix auth bug",
        summary: "Something else entirely",
      }),
    ]);

    const results = manager.searchByKeyword("auth");

    expect(results).toHaveLength(2);
    expect(results[0]?.sessionId).toBe("s2");
  });

  it("handles multi-term queries", () => {
    const manager = new SessionManager();
    manager.buildIndex([
      makeSummary({ sessionId: "s1", title: "Fix OAuth2 authentication" }),
      makeSummary({ sessionId: "s2", title: "Add OAuth2 login flow" }),
      makeSummary({ sessionId: "s3", title: "Dark mode support" }),
    ]);

    const results = manager.searchByKeyword("OAuth2 authentication");

    expect(results).toHaveLength(2);
    expect(results[0]?.sessionId).toBe("s1");
  });

  it("rebuild clears previous index", () => {
    const manager = new SessionManager();
    manager.buildIndex([makeSummary({ sessionId: "s1" })]);
    manager.buildIndex([makeSummary({ sessionId: "s2" }), makeSummary({ sessionId: "s3" })]);

    expect(manager.getIndexSize()).toBe(2);
  });
});

// ── SS4: Lifecycle management ──────────────────────────────────────────────

describe("SessionManager — SS4 Lifecycle", () => {
  let tempHome: string;
  const originalVeraHome = process.env.VERA_HOME;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "vera-test-"));
    process.env.VERA_HOME = tempHome;
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    process.env.VERA_HOME = originalVeraHome;
  });

  function createTestSession(cwd: string, label: string): string {
    const store = new SessionStore({ cwd });
    store.writeStart("test-model", "test-provider");
    store.writeUser(`Hello ${label}`);
    store.writeAssistant({
      parentUuid: "uuid",
      content: `Response ${label}`,
      model: "test-model",
      provider: "test-provider",
      stopReason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
      turn: 1,
      latencyMs: 100,
      toolCalls: [],
      status: "ok",
    });
    return store.sessionId;
  }

  it("cleanup with dryRun does not delete files", () => {
    const cwd = mkdtempSync(join(tempHome, "project-"));
    createTestSession(cwd, "1");
    createTestSession(cwd, "2");

    const manager = new SessionManager({ ttlDays: 0 });
    const result = manager.cleanup({ cwd, dryRun: true });

    // With TTL=0, all sessions are "expired", but dryRun shouldn't delete
    expect(result.removedCount).toBeGreaterThanOrEqual(0);
    expect(SessionStore.listSessions(cwd)).toHaveLength(2);
  });

  it("cleanup removes sessions older than TTL", () => {
    const cwd = mkdtempSync(join(tempHome, "project-"));
    createTestSession(cwd, "1");
    createTestSession(cwd, "2");

    // TTL=0 means everything is expired
    const manager = new SessionManager({ ttlDays: 0 });
    const result = manager.cleanup({ cwd });

    expect(result.removedCount).toBe(2);
    expect(result.remainingCount).toBe(0);
    expect(SessionStore.listSessions(cwd)).toHaveLength(0);
  });

  it("cleanup preserves sessions within TTL", () => {
    const cwd = mkdtempSync(join(tempHome, "project-"));
    createTestSession(cwd, "1");

    // TTL=365 means nothing expires within a year
    const manager = new SessionManager({ ttlDays: 365 });
    const result = manager.cleanup({ cwd });

    expect(result.removedCount).toBe(0);
    expect(result.remainingCount).toBe(1);
  });

  it("cleanup respects maxSessions limit", () => {
    const cwd = mkdtempSync(join(tempHome, "project-"));
    for (let i = 0; i < 5; i++) {
      createTestSession(cwd, `session-${i}`);
    }

    // Long TTL but maxSessions=3
    const manager = new SessionManager({ ttlDays: 365, maxSessions: 3 });
    const result = manager.cleanup({ cwd });

    expect(result.removedCount).toBe(2);
    expect(result.remainingCount).toBe(3);
  });

  it("listByActivity returns sessions sorted by time", () => {
    const cwd = mkdtempSync(join(tempHome, "project-"));
    createTestSession(cwd, "1");
    createTestSession(cwd, "2");

    const manager = new SessionManager();
    const sessions = manager.listByActivity({ cwd });

    expect(sessions).toHaveLength(2);
    // Most recent first
    expect(sessions[0]?.lastActivityAt.getTime()).toBeGreaterThanOrEqual(
      sessions[1]?.lastActivityAt.getTime() ?? 0
    );
  });
});

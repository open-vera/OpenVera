/**
 * Tests for memory_search tool — Search across memory tiers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMemorySearchTool } from "../memory-search.js";
import type { ToolContext } from "../types.js";
import type { MemorySearchResult, MemoryEntry } from "../../memory/store.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "mem-test-1",
    tier: "working",
    content: "test content",
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    importance: 0.5,
    ...overrides,
  };
}

function makeSearchResult(overrides: Partial<MemorySearchResult> = {}): MemorySearchResult {
  return {
    entry: makeEntry(),
    score: 0.85,
    matchedTerms: ["test"],
    ...overrides,
  };
}

function makeContext(memoryStore?: unknown): ToolContext {
  return {
    cwd: "/tmp",
    sessionId: "test-session",
    memoryStore: memoryStore as ToolContext["memoryStore"],
  };
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("memory_search tool", () => {
  const tool = createMemorySearchTool();

  // ── Tool Definition ─────────────────────────────────────────────────────────

  it("should return a ToolDef with correct name", () => {
    expect(tool.name).toBe("memory_search");
  });

  it("should have a non-empty description", () => {
    expect(tool.description).toBeTruthy();
    expect(tool.description).toContain("Search memory");
  });

  it("should require query parameter", () => {
    expect(tool.parameters.required).toContain("query");
  });

  it("should define tiers and limit as optional parameters", () => {
    const props = tool.parameters.properties as Record<string, unknown>;
    expect(props).toHaveProperty("tiers");
    expect(props).toHaveProperty("limit");
  });

  // ── Error: No memoryStore ────────────────────────────────────────────────────

  it("should return error when memoryStore is not available", async () => {
    const ctx = makeContext(undefined);
    const result = await tool.execute({ query: "anything" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.error?.message).toContain("MemoryStore not available");
  });

  // ── Empty Results ────────────────────────────────────────────────────────────

  it("should return 'No matching memories found.' when search returns empty", async () => {
    const mockStore = { search: vi.fn().mockReturnValue([]) };
    const ctx = makeContext(mockStore);
    const result = await tool.execute({ query: "nonexistent" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("No matching memories found.");
    expect(mockStore.search).toHaveBeenCalledWith("nonexistent", { tiers: undefined, limit: 10 });
  });

  // ── Results Found ────────────────────────────────────────────────────────────

  it("should format single result with tier, score, id, and content", async () => {
    const entry = makeEntry({
      id: "mem-abc",
      tier: "semantic",
      content: "TypeScript is typed",
      tags: ["ts", "language"],
    });
    const mockStore = { search: vi.fn().mockReturnValue([makeSearchResult({ entry, score: 0.92 })]) };
    const ctx = makeContext(mockStore);
    const result = await tool.execute({ query: "typescript" }, ctx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Found 1 memories:");
    expect(result.content).toContain("[1] SEMANTIC (92%) — mem-abc");
    expect(result.content).toContain("tags: [ts, language]");
    expect(result.content).toContain("TypeScript is typed");
  });

  it("should format multiple results separated by blank lines", async () => {
    const entry1 = makeEntry({ id: "mem-1", tier: "working", content: "first", tags: ["a"] });
    const entry2 = makeEntry({ id: "mem-2", tier: "episodic", content: "second", tags: [] });
    const mockStore = {
      search: vi.fn().mockReturnValue([
        makeSearchResult({ entry: entry1, score: 0.9 }),
        makeSearchResult({ entry: entry2, score: 0.7 }),
      ]),
    };
    const ctx = makeContext(mockStore);
    const result = await tool.execute({ query: "test" }, ctx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Found 2 memories:");
    expect(result.content).toContain("[1] WORKING");
    expect(result.content).toContain("[2] EPISODIC");
    // Results separated by double newline
    expect(result.content).toContain("\n\n");
  });

  it("should omit tags line when entry has no tags", async () => {
    const entry = makeEntry({ tags: [] });
    const mockStore = { search: vi.fn().mockReturnValue([makeSearchResult({ entry })]) };
    const ctx = makeContext(mockStore);
    const result = await tool.execute({ query: "test" }, ctx);

    expect(result.ok).toBe(true);
    expect(result.content).not.toContain("tags:");
  });

  it("should pass tiers and limit from args to store.search", async () => {
    const mockStore = { search: vi.fn().mockReturnValue([]) };
    const ctx = makeContext(mockStore);
    await tool.execute({ query: "q", tiers: ["semantic"], limit: 5 }, ctx);

    expect(mockStore.search).toHaveBeenCalledWith("q", { tiers: ["semantic"], limit: 5 });
  });

  it("should default limit to 10 when not specified", async () => {
    const mockStore = { search: vi.fn().mockReturnValue([]) };
    const ctx = makeContext(mockStore);
    await tool.execute({ query: "q" }, ctx);

    expect(mockStore.search).toHaveBeenCalledWith("q", { tiers: undefined, limit: 10 });
  });

  // ── Error: search throws ─────────────────────────────────────────────────────

  it("should return error when store.search throws", async () => {
    const mockStore = { search: vi.fn().mockImplementation(() => { throw new Error("index broken"); }) };
    const ctx = makeContext(mockStore);
    const result = await tool.execute({ query: "boom" }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.error?.message).toBe("index broken");
  });

  it("should handle non-Error thrown values", async () => {
    const mockStore = { search: vi.fn().mockImplementation(() => { throw "string error"; }) };
    const ctx = makeContext(mockStore);
    const result = await tool.execute({ query: "boom" }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe("string error");
  });
});

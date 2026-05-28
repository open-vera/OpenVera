/**
 * Tests for memory_write tool — Store information into memory tiers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMemoryWriteTool } from "../memory-write.js";
import type { ToolContext } from "../types.js";
import type { MemoryEntry, EpisodicEntry, SemanticEntry } from "../../memory/store.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMemoryEntry(tier: string, id: string): MemoryEntry {
  return {
    id,
    tier: tier as MemoryEntry["tier"],
    content: "test content",
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    importance: 0.5,
  };
}

function makeEpisodicEntry(id: string): EpisodicEntry {
  return {
    ...makeMemoryEntry("episodic", id),
    tier: "episodic",
    taskSummary: "summary",
    outcome: "outcome",
    lessons: [],
  };
}

function makeSemanticEntry(id: string): SemanticEntry {
  return {
    ...makeMemoryEntry("semantic", id),
    tier: "semantic",
    key: "key",
    value: "value",
  };
}

function makeMockStore() {
  return {
    addWorking: vi.fn().mockReturnValue(makeMemoryEntry("working", "w-1")),
    addEpisodic: vi.fn().mockReturnValue(makeEpisodicEntry("e-1")),
    addSemantic: vi.fn().mockReturnValue(makeSemanticEntry("s-1")),
    search: vi.fn(),
  };
}

function makeCtx(memoryStore?: unknown): ToolContext {
  return {
    cwd: "/tmp",
    sessionId: "test-session",
    memoryStore: memoryStore as ToolContext["memoryStore"],
  };
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("memory_write tool", () => {
  const tool = createMemoryWriteTool();

  // ── Tool Definition ─────────────────────────────────────────────────────────

  it("should return a ToolDef with correct name", () => {
    expect(tool.name).toBe("memory_write");
  });

  it("should have a non-empty description", () => {
    expect(tool.description).toBeTruthy();
    expect(tool.description).toContain("Store information");
  });

  it("should require tier and content parameters", () => {
    const req = tool.parameters.required as string[];
    expect(req).toContain("tier");
    expect(req).toContain("content");
  });

  // ── Error: No memoryStore ────────────────────────────────────────────────────

  it("should return error when memoryStore is not available", async () => {
    const ctx = makeCtx(undefined);
    const result = await tool.execute({ tier: "working", content: "hi" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.error?.message).toContain("MemoryStore not available");
  });

  // ── Working Tier ─────────────────────────────────────────────────────────────

  it("should call addWorking with correct args for working tier", async () => {
    const store = makeMockStore();
    const ctx = makeCtx(store);
    const result = await tool.execute(
      { tier: "working", content: "remember this", tags: ["note"], source: "session-1", importance: 0.6 },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Stored in working memory: w-1");
    expect(store.addWorking).toHaveBeenCalledWith("remember this", ["note"], "session-1", 0.6);
  });

  it("should use default tags/source/importance for working tier", async () => {
    const store = makeMockStore();
    const ctx = makeCtx(store);
    await tool.execute({ tier: "working", content: "note" }, ctx);

    expect(store.addWorking).toHaveBeenCalledWith("note", [], undefined, 0.5);
  });

  // ── Episodic Tier ────────────────────────────────────────────────────────────

  it("should call addEpisodic with explicit args for episodic tier", async () => {
    const store = makeMockStore();
    const ctx = makeCtx(store);
    const result = await tool.execute(
      {
        tier: "episodic",
        content: "raw content",
        taskSummary: "Fixed the bug",
        outcome: "Tests pass now",
        lessons: ["Always run tests"],
        tags: ["bugfix"],
        source: "task-42",
        importance: 0.9,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Stored in episodic memory: e-1");
    expect(result.content).toContain("Summary: Fixed the bug");
    expect(store.addEpisodic).toHaveBeenCalledWith(
      "Fixed the bug",
      "Tests pass now",
      ["Always run tests"],
      ["bugfix"],
      "task-42",
      0.9,
    );
  });

  it("should default taskSummary to content, outcome to empty, lessons to empty for episodic tier", async () => {
    const store = makeMockStore();
    const ctx = makeCtx(store);
    await tool.execute({ tier: "episodic", content: "my summary" }, ctx);

    expect(store.addEpisodic).toHaveBeenCalledWith("my summary", "", [], [], undefined, 0.7);
  });

  // ── Semantic Tier ────────────────────────────────────────────────────────────

  it("should call addSemantic with key and value for semantic tier", async () => {
    const store = makeMockStore();
    const ctx = makeCtx(store);
    const result = await tool.execute(
      {
        tier: "semantic",
        content: "TypeScript adds types",
        key: "TypeScript",
        value: "A typed superset of JavaScript",
        tags: ["lang"],
        source: "docs",
        importance: 0.85,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Stored in semantic memory: s-1");
    expect(result.content).toContain("Key: TypeScript");
    expect(store.addSemantic).toHaveBeenCalledWith(
      "TypeScript",
      "A typed superset of JavaScript",
      ["lang"],
      "docs",
      0.85,
    );
  });

  it("should default value to content when value is omitted for semantic tier", async () => {
    const store = makeMockStore();
    const ctx = makeCtx(store);
    await tool.execute({ tier: "semantic", content: "the detail", key: "fact" }, ctx);

    expect(store.addSemantic).toHaveBeenCalledWith("fact", "the detail", [], undefined, 0.8);
  });

  it("should return error when key is missing for semantic tier", async () => {
    const store = makeMockStore();
    const ctx = makeCtx(store);
    const result = await tool.execute({ tier: "semantic", content: "no key provided" }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.error?.message).toContain("'key' is required");
    expect(store.addSemantic).not.toHaveBeenCalled();
  });

  // ── Unknown Tier ─────────────────────────────────────────────────────────────

  it("should return error for unknown tier", async () => {
    const store = makeMockStore();
    const ctx = makeCtx(store);
    const result = await tool.execute(
      { tier: "unknown-tier" as unknown as "working", content: "x" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.error?.message).toContain("Unknown tier");
  });

  // ── Error: store throws ──────────────────────────────────────────────────────

  it("should return error when store.addWorking throws", async () => {
    const store = makeMockStore();
    store.addWorking.mockImplementation(() => { throw new Error("disk full"); });
    const ctx = makeCtx(store);
    const result = await tool.execute({ tier: "working", content: "x" }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.error?.message).toBe("disk full");
  });

  it("should return error when store.addEpisodic throws", async () => {
    const store = makeMockStore();
    store.addEpisodic.mockImplementation(() => { throw new Error("write failed"); });
    const ctx = makeCtx(store);
    const result = await tool.execute({ tier: "episodic", content: "x" }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe("write failed");
  });

  it("should return error when store.addSemantic throws", async () => {
    const store = makeMockStore();
    store.addSemantic.mockImplementation(() => { throw new Error("corrupt"); });
    const ctx = makeCtx(store);
    const result = await tool.execute({ tier: "semantic", content: "x", key: "k" }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe("corrupt");
  });

  it("should handle non-Error thrown values", async () => {
    const store = makeMockStore();
    store.addWorking.mockImplementation(() => { throw "string error"; });
    const ctx = makeCtx(store);
    const result = await tool.execute({ tier: "working", content: "x" }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe("string error");
  });
});

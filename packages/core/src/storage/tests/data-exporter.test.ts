import { describe, it, expect, vi, beforeEach } from "vitest";
import { DataExporter, createDataExporter } from "../data-exporter.js";
import type { ExportFormat } from "../data-exporter.js";
import type { StorageQueryResult } from "../types.js";

// ── Mock SqliteStorageProvider ─────────────────────────────────────────────────

const mockQuery = vi.fn<[string, unknown], Promise<StorageQueryResult>>();
const mockListKeys = vi.fn<[string], Promise<string[]>>();
const mockGet = vi.fn<[string, string], Promise<unknown>>();

vi.mock("../sqlite.js", () => ({
  SqliteStorageProvider: vi.fn(function () {
    return {
      query: mockQuery,
      listKeys: mockListKeys,
      get: mockGet,
    };
  }),
}));

import { SqliteStorageProvider } from "../sqlite.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build a mock query result entry */
function mockEntry(key: string, value: unknown, overrides: Record<string, unknown> = {}) {
  return {
    key,
    entry: {
      value,
      createdAt: overrides.createdAt as string ?? "2025-01-01T00:00:00.000Z",
      updatedAt: overrides.updatedAt as string ?? "2025-01-02T00:00:00.000Z",
      ...(overrides.tags !== undefined ? { tags: overrides.tags as string[] } : {}),
    },
  };
}

/** Build a mock StorageQueryResult */
function mockResult(entries: ReturnType<typeof mockEntry>[], total?: number, hasMore?: boolean): StorageQueryResult {
  return {
    entries,
    total: total ?? entries.length,
    hasMore: hasMore ?? false,
  };
}

/** Create a fresh exporter instance */
function createExporter(): DataExporter {
  return new DataExporter(new SqliteStorageProvider({ dbPath: ":memory:", backend: "sqlite" }));
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("createDataExporter", () => {
  it("should create a DataExporter instance wrapping a SqliteStorageProvider", () => {
    const storage = new SqliteStorageProvider({ dbPath: ":memory:", backend: "sqlite" });
    const exporter = createDataExporter(storage);
    expect(exporter).toBeInstanceOf(DataExporter);
  });
});

describe("DataExporter.exportData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── JSONL format ──────────────────────────────────────────────────────────

  it("should export data in jsonl format with metadata by default", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("k1", "hello", { tags: ["greeting"] }),
      mockEntry("k2", 42),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({ namespace: "test", format: "jsonl" });

    expect(result.format).toBe("jsonl");
    expect(result.count).toBe(2);
    const lines = result.data.split("\n");
    expect(lines).toHaveLength(2);

    const obj1 = JSON.parse(lines[0]);
    expect(obj1.key).toBe("k1");
    expect(obj1.value).toBe("hello");
    expect(obj1.createdAt).toBe("2025-01-01T00:00:00.000Z");
    expect(obj1.tags).toEqual(["greeting"]);

    const obj2 = JSON.parse(lines[1]);
    expect(obj2.key).toBe("k2");
    expect(obj2.value).toBe(42);
  });

  it("should export data in jsonl format without metadata when includeMetadata=false", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("k1", "hello"),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({
      namespace: "test", format: "jsonl", includeMetadata: false,
    });

    const obj = JSON.parse(result.data);
    expect(obj.key).toBe("k1");
    expect(obj.value).toBe("hello");
    expect(obj.createdAt).toBeUndefined();
    expect(obj.updatedAt).toBeUndefined();
    expect(obj.tags).toBeUndefined();
  });

  // ── JSON format ────────────────────────────────────────────────────────────

  it("should export data in json format with pretty print by default", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("k1", "hello"),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({ namespace: "test", format: "json" });

    expect(result.format).toBe("json");
    expect(result.count).toBe(1);
    // Pretty printed JSON has newlines and indentation
    expect(result.data).toContain("\n");
    expect(result.data).toContain('"key": "k1"');
    expect(result.data).toContain('"value": "hello"');

    const parsed = JSON.parse(result.data);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].key).toBe("k1");
  });

  it("should export data in compact json format when prettyPrint=false", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("k1", "hello"),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({
      namespace: "test", format: "json", prettyPrint: false,
    });

    // Compact JSON should be a single line
    expect(result.data).not.toContain("\n");
    const parsed = JSON.parse(result.data);
    expect(parsed).toHaveLength(1);
  });

  it("should export data in json format without metadata", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("k1", "hello", { tags: ["t1"] }),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({
      namespace: "test", format: "json", includeMetadata: false,
    });

    const parsed = JSON.parse(result.data);
    expect(parsed[0].key).toBe("k1");
    expect(parsed[0].value).toBe("hello");
    expect(parsed[0].createdAt).toBeUndefined();
    expect(parsed[0].tags).toBeUndefined();
  });

  it("should export data in json format with metadata including tags", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("k1", "hello", { tags: ["greeting", "important"] }),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({
      namespace: "test", format: "json",
    });

    const parsed = JSON.parse(result.data);
    expect(parsed[0].key).toBe("k1");
    expect(parsed[0].value).toBe("hello");
    expect(parsed[0].createdAt).toBeDefined();
    expect(parsed[0].updatedAt).toBeDefined();
    expect(parsed[0].tags).toEqual(["greeting", "important"]);
  });

  // ── CSV format ─────────────────────────────────────────────────────────────

  it("should export data in csv format with metadata", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("k1", "hello", { tags: ["greeting", "test"] }),
      mockEntry("k2", 99),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({ namespace: "test", format: "csv" });

    expect(result.format).toBe("csv");
    expect(result.count).toBe(2);

    const lines = result.data.split("\n");
    expect(lines).toHaveLength(3); // header + 2 data rows
    expect(lines[0]).toBe("key,value,createdAt,updatedAt,tags");

    const fields1 = lines[1].split(",");
    expect(fields1[0]).toBe("k1");
    expect(fields1[1]).toBe("hello");
    expect(fields1[4]).toBe("greeting;test");
  });

  it("should export data in csv format without metadata", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("k1", "hello"),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({
      namespace: "test", format: "csv", includeMetadata: false,
    });

    const lines = result.data.split("\n");
    expect(lines[0]).toBe("key,value");
    expect(lines[1]).toBe("k1,hello");
  });

  it("should use custom csv separator when csvSeparator is provided", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("k1", "hello", { tags: ["t1"] }),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({
      namespace: "test", format: "csv", csvSeparator: ";",
    });

    const lines = result.data.split("\n");
    expect(lines[0]).toBe("key;value;createdAt;updatedAt;tags");
    expect(lines[1]).toContain(";");
    expect(lines[1]).not.toContain(",");
  });

  // ── Filter ─────────────────────────────────────────────────────────────────

  it("should pass the filter to storage.query when provided", async () => {
    const filter = { tags: ["important"], limit: 10 };
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("k1", "filtered"),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({
      namespace: "test", format: "jsonl", filter,
    });

    expect(mockQuery).toHaveBeenCalledWith("test", filter);
    expect(result.count).toBe(1);
  });

  it("should pass an empty query when no filter is provided", async () => {
    mockQuery.mockResolvedValue(mockResult([]));

    const exporter = createExporter();
    await exporter.exportData({ namespace: "test", format: "jsonl" });

    expect(mockQuery).toHaveBeenCalledWith("test", {});
  });

  // ── Empty results ──────────────────────────────────────────────────────────

  it("should handle empty results in jsonl format", async () => {
    mockQuery.mockResolvedValue(mockResult([]));

    const exporter = createExporter();
    const result = await exporter.exportData({ namespace: "test", format: "jsonl" });

    expect(result.data).toBe("");
    expect(result.count).toBe(0);
  });

  it("should handle empty results in csv format", async () => {
    mockQuery.mockResolvedValue(mockResult([]));

    const exporter = createExporter();
    const result = await exporter.exportData({ namespace: "test", format: "csv" });

    expect(result.data).toBe("");
    expect(result.count).toBe(0);
  });

  it("should handle empty results in json format", async () => {
    mockQuery.mockResolvedValue(mockResult([]));

    const exporter = createExporter();
    const result = await exporter.exportData({ namespace: "test", format: "json" });

    const parsed = JSON.parse(result.data);
    expect(parsed).toEqual([]);
    expect(result.count).toBe(0);
  });

  // ── Default format fallthrough ─────────────────────────────────────────────

  it("should fall back to jsonl format when an unrecognized format is given (default switch)", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("k1", "hello"),
    ]));

    const exporter = createExporter();
    // Cast to bypass TypeScript type check and test the default branch
    const result = await exporter.exportData({
      namespace: "test", format: "unknown" as ExportFormat,
    });

    // Falls to default -> jsonl, but format in result is still the passed-in value
    expect(result.format).toBe("unknown");
    // Data should be in jsonl format (one JSON per line)
    const lines = result.data.split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.key).toBe("k1");
  });

  // ── Complex values ─────────────────────────────────────────────────────────

  it("should JSON-stringify complex values in jsonl format", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("k1", { nested: { a: 1 }, arr: [1, 2] }),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({
      namespace: "test", format: "jsonl", includeMetadata: false,
    });

    const obj = JSON.parse(result.data);
    expect(obj.key).toBe("k1");
    expect(obj.value).toEqual({ nested: { a: 1 }, arr: [1, 2] });
  });
});

describe("DataExporter.exportSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockSessionContent = JSON.stringify({ role: "user", content: "hello" }) + "\n"
    + JSON.stringify({ role: "assistant", content: "hi there" });

  // ── All sessions (jsonl) ──────────────────────────────────────────────────

  it("should export all sessions in jsonl format when no sessionIds filter", async () => {
    mockListKeys.mockResolvedValue(["sess-1", "sess-2"]);
    mockGet.mockImplementation(async (_ns: string, key: string) => {
      if (key === "sess-1") return {
        sessionId: "sess-1",
        content: mockSessionContent,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-02T00:00:00.000Z",
        metadata: { model: "claude", turnCount: 3 },
      };
      if (key === "sess-2") return {
        sessionId: "sess-2",
        content: mockSessionContent,
        createdAt: "2025-01-03T00:00:00.000Z",
        updatedAt: "2025-01-04T00:00:00.000Z",
        metadata: { model: "claude", turnCount: 1 },
      };
      return undefined;
    });

    const exporter = createExporter();
    const result = await exporter.exportSessions({ format: "jsonl" });

    expect(result.format).toBe("jsonl");
    expect(result.count).toBe(2);
    expect(mockListKeys).toHaveBeenCalledWith("sessions");

    const lines = result.data.split("\n");
    expect(lines).toHaveLength(2);

    const s1 = JSON.parse(lines[0]);
    expect(s1.sessionId).toBe("sess-1");
    expect(s1.content).toBe(mockSessionContent);
    expect(s1.metadata.model).toBe("claude");

    const s2 = JSON.parse(lines[1]);
    expect(s2.sessionId).toBe("sess-2");
  });

  // ── Filtered by sessionIds ────────────────────────────────────────────────

  it("should export only specified sessions when sessionIds filter is provided", async () => {
    mockGet.mockResolvedValueOnce({
      sessionId: "sess-1",
      content: mockSessionContent,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
      metadata: {},
    });

    const exporter = createExporter();
    const result = await exporter.exportSessions({
      format: "jsonl",
      sessionIds: ["sess-1"],
    });

    expect(result.count).toBe(1);
    expect(mockListKeys).not.toHaveBeenCalled();
    // get should be called with the specified session id
    expect(mockGet).toHaveBeenCalledWith("sessions", "sess-1");
  });

  it("should skip sessions that are not found in storage", async () => {
    mockGet.mockResolvedValue(undefined);

    const exporter = createExporter();
    const result = await exporter.exportSessions({
      format: "jsonl",
      sessionIds: ["nonexistent"],
    });

    expect(result.count).toBe(0);
    expect(result.data).toBe("");
  });

  // ── Structured format (csv / json) ─────────────────────────────────────────

  it("should export sessions in csv format with parsed entries", async () => {
    mockListKeys.mockResolvedValue(["sess-1"]);
    mockGet.mockResolvedValue({
      sessionId: "sess-1",
      content: mockSessionContent,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
      metadata: { model: "claude" },
    });

    const exporter = createExporter();
    const result = await exporter.exportSessions({ format: "csv" });

    expect(result.format).toBe("csv");
    expect(result.count).toBe(1);

    const lines = result.data.split("\n");
    expect(lines).toHaveLength(2); // header + 1 row

    // Should contain all union keys from the entries
    expect(lines[0]).toContain("sessionId");
    expect(lines[0]).toContain("entries");
    expect(lines[0]).toContain("createdAt");
    expect(lines[0]).toContain("metadata");

    // entries field should be JSON-stringified array of parsed lines
    const row = lines[1];
    expect(row).toContain("sess-1");
  });

  it("should export sessions in json format with pretty print by default", async () => {
    mockListKeys.mockResolvedValue(["sess-1"]);
    mockGet.mockResolvedValue({
      sessionId: "sess-1",
      content: mockSessionContent,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
      metadata: { model: "claude" },
    });

    const exporter = createExporter();
    const result = await exporter.exportSessions({ format: "json" });

    // Pretty printed JSON has newlines
    expect(result.data).toContain("\n");
    const parsed = JSON.parse(result.data);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sessionId).toBe("sess-1");
    // entries should be the parsed content array (non-jsonl format)
    expect(Array.isArray(parsed[0].entries)).toBe(true);
    expect(parsed[0].entries).toHaveLength(2);
    expect(parsed[0].entries[0].role).toBe("user");
  });

  it("should export sessions in compact json format when prettyPrint=false", async () => {
    mockListKeys.mockResolvedValue(["sess-1"]);
    mockGet.mockResolvedValue({
      sessionId: "sess-1",
      content: mockSessionContent,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
      metadata: {},
    });

    const exporter = createExporter();
    const result = await exporter.exportSessions({ format: "json", prettyPrint: false });

    expect(result.data).not.toContain("\n");
    const parsed = JSON.parse(result.data);
    expect(parsed).toHaveLength(1);
  });

  // ── parseJsonlContent behavior (tested via structured export) ─────────────

  it("should parse valid JSONL content when exporting in structured format", async () => {
    const content = JSON.stringify({ a: 1 }) + "\n" + JSON.stringify({ b: 2 });
    mockListKeys.mockResolvedValue(["sess-1"]);
    mockGet.mockResolvedValue({
      sessionId: "sess-1",
      content,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
      metadata: {},
    });

    const exporter = createExporter();
    const result = await exporter.exportSessions({ format: "json" });

    const parsed = JSON.parse(result.data);
    expect(parsed[0].entries).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("should filter out invalid JSONL lines when parsing content (non-jsonl format)", async () => {
    const content = JSON.stringify({ a: 1 }) + "\n" + "bad json line\n" + JSON.stringify({ c: 3 });
    mockListKeys.mockResolvedValue(["sess-1"]);
    mockGet.mockResolvedValue({
      sessionId: "sess-1",
      content,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
      metadata: {},
    });

    const exporter = createExporter();
    const result = await exporter.exportSessions({ format: "json" });

    const parsed = JSON.parse(result.data);
    // Invalid line "bad json line" should be filtered out
    expect(parsed[0].entries).toEqual([{ a: 1 }, { c: 3 }]);
  });

  it("should return empty entries array when all JSONL lines are invalid", async () => {
    mockListKeys.mockResolvedValue(["sess-1"]);
    mockGet.mockResolvedValue({
      sessionId: "sess-1",
      content: "not json\nalso not json",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
      metadata: {},
    });

    const exporter = createExporter();
    const result = await exporter.exportSessions({ format: "json" });

    const parsed = JSON.parse(result.data);
    expect(parsed[0].entries).toEqual([]);
  });

  it("should handle empty content string gracefully", async () => {
    mockListKeys.mockResolvedValue(["sess-1"]);
    mockGet.mockResolvedValue({
      sessionId: "sess-1",
      content: "",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
      metadata: {},
    });

    const exporter = createExporter();
    const result = await exporter.exportSessions({ format: "json" });

    const parsed = JSON.parse(result.data);
    expect(parsed[0].entries).toEqual([]);
  });

  // ── Empty result ──────────────────────────────────────────────────────────

  it("should handle empty sessions (no keys)", async () => {
    mockListKeys.mockResolvedValue([]);

    const exporter = createExporter();
    const result = await exporter.exportSessions({ format: "jsonl" });

    expect(result.data).toBe("");
    expect(result.count).toBe(0);
  });

  // ── Default format fallthrough ────────────────────────────────────────────

  it("should fall back to json format for unrecognized format in exportSessions", async () => {
    mockListKeys.mockResolvedValue(["sess-1"]);
    mockGet.mockResolvedValue({
      sessionId: "sess-1",
      content: mockSessionContent,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
      metadata: {},
    });

    const exporter = createExporter();
    const result = await exporter.exportSessions({ format: "unknown" as ExportFormat });

    // Falls to default -> JSON pretty print
    const parsed = JSON.parse(result.data);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sessionId).toBe("sess-1");
  });
});

describe("DataExporter.exportMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const makeMemoryEntry = (id: string, tier: string, content: string) => ({
    id,
    tier,
    content,
    tags: [],
    importance: 5,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  });

  // ── All entries ────────────────────────────────────────────────────────────

  it("should export all memory entries in jsonl format", async () => {
    mockListKeys.mockResolvedValue(["mem-1", "mem-2"]);
    mockGet.mockImplementation(async (_ns: string, key: string) => {
      if (key === "mem-1") return makeMemoryEntry("mem-1", "working", "data1");
      if (key === "mem-2") return makeMemoryEntry("mem-2", "semantic", "data2");
      return undefined;
    });

    const exporter = createExporter();
    const result = await exporter.exportMemory({ format: "jsonl" });

    expect(result.format).toBe("jsonl");
    expect(result.count).toBe(2);
    expect(mockListKeys).toHaveBeenCalledWith("memory");

    const lines = result.data.split("\n");
    expect(lines).toHaveLength(2);

    const m1 = JSON.parse(lines[0]);
    expect(m1.id).toBe("mem-1");
    expect(m1.tier).toBe("working");

    const m2 = JSON.parse(lines[1]);
    expect(m2.id).toBe("mem-2");
    expect(m2.tier).toBe("semantic");
  });

  // ── Filtered by tiers ─────────────────────────────────────────────────────

  it("should filter memory entries by specified tiers", async () => {
    mockListKeys.mockResolvedValue(["mem-1", "mem-2", "mem-3"]);
    mockGet.mockImplementation(async (_ns: string, key: string) => {
      if (key === "mem-1") return makeMemoryEntry("mem-1", "working", "w");
      if (key === "mem-2") return makeMemoryEntry("mem-2", "episodic", "e");
      if (key === "mem-3") return makeMemoryEntry("mem-3", "semantic", "s");
      return undefined;
    });

    const exporter = createExporter();
    const result = await exporter.exportMemory({
      format: "jsonl",
      tiers: ["working", "semantic"],
    });

    expect(result.count).toBe(2);
    const lines = result.data.split("\n");
    const tiers = lines.map((l) => JSON.parse(l).tier).sort();
    expect(tiers).toEqual(["semantic", "working"]);
  });

  it("should return all entries when tiers is an empty array", async () => {
    mockListKeys.mockResolvedValue(["mem-1", "mem-2"]);
    mockGet.mockImplementation(async (_ns: string, key: string) => {
      if (key === "mem-1") return makeMemoryEntry("mem-1", "working", "w");
      if (key === "mem-2") return makeMemoryEntry("mem-2", "semantic", "s");
      return undefined;
    });

    const exporter = createExporter();
    const result = await exporter.exportMemory({ format: "jsonl", tiers: [] });

    // Empty array -> tiers.length > 0 is false, all entries returned
    expect(result.count).toBe(2);
  });

  it("should return no entries when tiers filter matches nothing", async () => {
    mockListKeys.mockResolvedValue(["mem-1"]);
    mockGet.mockResolvedValue(makeMemoryEntry("mem-1", "working", "w"));

    const exporter = createExporter();
    const result = await exporter.exportMemory({
      format: "jsonl",
      tiers: ["nonexistent"],
    });

    expect(result.count).toBe(0);
    expect(result.data).toBe("");
  });

  // ── CSV format ─────────────────────────────────────────────────────────────

  it("should export memory entries in csv format", async () => {
    mockListKeys.mockResolvedValue(["mem-1"]);
    mockGet.mockResolvedValue(makeMemoryEntry("mem-1", "working", "test content"));

    const exporter = createExporter();
    const result = await exporter.exportMemory({ format: "csv" });

    expect(result.format).toBe("csv");
    const lines = result.data.split("\n");
    expect(lines).toHaveLength(2); // header + 1 row
    // Union of all keys from the entry object
    const headers = lines[0].split(",");
    expect(headers).toContain("id");
    expect(headers).toContain("tier");
    expect(headers).toContain("content");
  });

  // ── JSON format ────────────────────────────────────────────────────────────

  it("should export memory entries in json format with pretty print", async () => {
    mockListKeys.mockResolvedValue(["mem-1"]);
    mockGet.mockResolvedValue(makeMemoryEntry("mem-1", "working", "test"));

    const exporter = createExporter();
    const result = await exporter.exportMemory({ format: "json" });

    expect(result.data).toContain("\n");
    const parsed = JSON.parse(result.data);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("mem-1");
  });

  it("should export memory entries in compact json format when prettyPrint=false", async () => {
    mockListKeys.mockResolvedValue(["mem-1"]);
    mockGet.mockResolvedValue(makeMemoryEntry("mem-1", "working", "test"));

    const exporter = createExporter();
    const result = await exporter.exportMemory({ format: "json", prettyPrint: false });

    expect(result.data).not.toContain("\n");
  });

  // ── Empty results ──────────────────────────────────────────────────────────

  it("should handle empty memory entries", async () => {
    mockListKeys.mockResolvedValue([]);

    const exporter = createExporter();
    const result = await exporter.exportMemory({ format: "jsonl" });

    expect(result.data).toBe("");
    expect(result.count).toBe(0);
  });

  it("should skip memory entries that return undefined from storage", async () => {
    mockListKeys.mockResolvedValue(["mem-1", "mem-2"]);
    mockGet.mockImplementation(async (_ns: string, key: string) => {
      if (key === "mem-1") return makeMemoryEntry("mem-1", "working", "ok");
      return undefined; // mem-2 returns undefined
    });

    const exporter = createExporter();
    const result = await exporter.exportMemory({ format: "jsonl" });

    expect(result.count).toBe(1);
    expect(JSON.parse(result.data).id).toBe("mem-1");
  });

  // ── Default format fallthrough ────────────────────────────────────────────

  it("should fall back to json format for unrecognized format in exportMemory", async () => {
    mockListKeys.mockResolvedValue(["mem-1"]);
    mockGet.mockResolvedValue(makeMemoryEntry("mem-1", "working", "test"));

    const exporter = createExporter();
    const result = await exporter.exportMemory({ format: "unknown" as ExportFormat });

    const parsed = JSON.parse(result.data);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("mem-1");
  });
});

describe("DataExporter.exportUserData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const makeUserEntry = (key: string, value: unknown, ns?: string) => ({
    key,
    value,
    namespace: ns ?? "default",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
    description: "test data",
  });

  // ── All entries ────────────────────────────────────────────────────────────

  it("should export all user data entries in jsonl format", async () => {
    mockListKeys.mockResolvedValue(["u1", "u2"]);
    mockGet.mockImplementation(async (_ns: string, key: string) => {
      if (key === "u1") return makeUserEntry("u1", "val1", "ns-a");
      if (key === "u2") return makeUserEntry("u2", "val2", "ns-b");
      return undefined;
    });

    const exporter = createExporter();
    const result = await exporter.exportUserData({ format: "jsonl" });

    expect(result.format).toBe("jsonl");
    expect(result.count).toBe(2);
    expect(mockListKeys).toHaveBeenCalledWith("user-data");

    const lines = result.data.split("\n");
    expect(lines).toHaveLength(2);

    const d1 = JSON.parse(lines[0]);
    expect(d1.key).toBe("u1");
    expect(d1.namespace).toBe("ns-a");

    const d2 = JSON.parse(lines[1]);
    expect(d2.key).toBe("u2");
    expect(d2.namespace).toBe("ns-b");
  });

  // ── Filtered by namespace ─────────────────────────────────────────────────

  it("should filter user data entries by namespace", async () => {
    mockListKeys.mockResolvedValue(["u1", "u2", "u3"]);
    mockGet.mockImplementation(async (_ns: string, key: string) => {
      if (key === "u1") return makeUserEntry("u1", "v1", "ns-a");
      if (key === "u2") return makeUserEntry("u2", "v2", "ns-b");
      if (key === "u3") return makeUserEntry("u3", "v3", "ns-a");
      return undefined;
    });

    const exporter = createExporter();
    const result = await exporter.exportUserData({
      format: "jsonl",
      namespace: "ns-a",
    });

    expect(result.count).toBe(2);
    const lines = result.data.split("\n");
    const keys = lines.map((l) => JSON.parse(l).key).sort();
    expect(keys).toEqual(["u1", "u3"]);
  });

  it("should return all entries when namespace filter is not provided", async () => {
    mockListKeys.mockResolvedValue(["u1", "u2"]);
    mockGet.mockImplementation(async (_ns: string, key: string) => {
      if (key === "u1") return makeUserEntry("u1", "v1", "ns-a");
      if (key === "u2") return makeUserEntry("u2", "v2", "ns-b");
      return undefined;
    });

    const exporter = createExporter();
    const result = await exporter.exportUserData({ format: "jsonl" });

    expect(result.count).toBe(2);
  });

  it("should return no entries when namespace filter matches nothing", async () => {
    mockListKeys.mockResolvedValue(["u1"]);
    mockGet.mockResolvedValue(makeUserEntry("u1", "v1", "ns-a"));

    const exporter = createExporter();
    const result = await exporter.exportUserData({
      format: "jsonl",
      namespace: "ns-other",
    });

    expect(result.count).toBe(0);
    expect(result.data).toBe("");
  });

  // ── CSV format ─────────────────────────────────────────────────────────────

  it("should export user data entries in csv format", async () => {
    mockListKeys.mockResolvedValue(["u1"]);
    mockGet.mockResolvedValue(makeUserEntry("u1", "val1", "ns-a"));

    const exporter = createExporter();
    const result = await exporter.exportUserData({ format: "csv" });

    expect(result.format).toBe("csv");
    const lines = result.data.split("\n");
    expect(lines).toHaveLength(2); // header + 1 row
    const headers = lines[0].split(",");
    expect(headers).toContain("key");
    expect(headers).toContain("namespace");
  });

  it("should handle empty user data in csv format", async () => {
    mockListKeys.mockResolvedValue([]);

    const exporter = createExporter();
    const result = await exporter.exportUserData({ format: "csv" });

    expect(result.data).toBe("");
    expect(result.count).toBe(0);
  });

  // ── JSON format ────────────────────────────────────────────────────────────

  it("should export user data entries in json format with pretty print", async () => {
    mockListKeys.mockResolvedValue(["u1"]);
    mockGet.mockResolvedValue(makeUserEntry("u1", "val1", "ns-a"));

    const exporter = createExporter();
    const result = await exporter.exportUserData({ format: "json" });

    expect(result.data).toContain("\n");
    const parsed = JSON.parse(result.data);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].key).toBe("u1");
    expect(parsed[0].namespace).toBe("ns-a");
  });

  it("should export user data entries in compact json format when prettyPrint=false", async () => {
    mockListKeys.mockResolvedValue(["u1"]);
    mockGet.mockResolvedValue(makeUserEntry("u1", "val1", "ns-a"));

    const exporter = createExporter();
    const result = await exporter.exportUserData({ format: "json", prettyPrint: false });

    expect(result.data).not.toContain("\n");
  });

  // ── Empty results ──────────────────────────────────────────────────────────

  it("should handle empty user data entries", async () => {
    mockListKeys.mockResolvedValue([]);

    const exporter = createExporter();
    const result = await exporter.exportUserData({ format: "jsonl" });

    expect(result.data).toBe("");
    expect(result.count).toBe(0);
  });

  it("should skip user data entries that return undefined from storage", async () => {
    mockListKeys.mockResolvedValue(["u1", "u2"]);
    mockGet.mockImplementation(async (_ns: string, key: string) => {
      if (key === "u1") return makeUserEntry("u1", "ok", "ns-a");
      return undefined;
    });

    const exporter = createExporter();
    const result = await exporter.exportUserData({ format: "jsonl" });

    expect(result.count).toBe(1);
    expect(JSON.parse(result.data).key).toBe("u1");
  });

  // ── Default format fallthrough ────────────────────────────────────────────

  it("should fall back to json format for unrecognized format in exportUserData", async () => {
    mockListKeys.mockResolvedValue(["u1"]);
    mockGet.mockResolvedValue(makeUserEntry("u1", "val1", "ns-a"));

    const exporter = createExporter();
    const result = await exporter.exportUserData({ format: "unknown" as ExportFormat });

    const parsed = JSON.parse(result.data);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].key).toBe("u1");
  });
});

describe("CSV escaping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should escape fields containing commas in exportData CSV", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("key1", "hello, world"),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({
      namespace: "test", format: "csv",
    });

    // Value with comma should be double-quoted
    const lines = result.data.split("\n");
    expect(lines[1]).toContain('"hello, world"');
  });

  it("should escape fields containing double quotes in exportData CSV", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("key1", 'say "hello"'),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({
      namespace: "test", format: "csv",
    });

    // Value with quotes should be wrapped in quotes and internal quotes doubled
    const lines = result.data.split("\n");
    expect(lines[1]).toContain('"say ""hello"""');
  });

  it("should escape fields containing newlines in exportData CSV", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("key1", "line1\nline2"),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({
      namespace: "test", format: "csv",
    });

    // Value with newline should be double-quoted
    const lines = result.data.split("\n");
    // With a newline in the value, split might give more lines
    expect(result.data).toContain('"line1\nline2"');
  });

  it("should escape fields with multiple special characters", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("key1", 'data "with" , commas\nand newlines'),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({
      namespace: "test", format: "csv",
    });

    // Entire field should be quoted, internal quotes doubled
    expect(result.data).toContain("data " + '""' + "with" + '""' + " , commas\nand newlines");
  });

  it("should not escape simple fields without special characters", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("simple", "plaintext"),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({
      namespace: "test", format: "csv",
    });

    // Plain text should not be wrapped in quotes
    expect(result.data).toContain("simple,plaintext");
    expect(result.data).not.toContain('"plaintext"');
  });

  it("should escape fields with custom separator in exportData", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("key1", "value;with;semicolons"),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({
      namespace: "test", format: "csv", csvSeparator: ";",
    });

    // With semicolon separator, fields containing semicolons should be escaped
    expect(result.data).toContain('"value;with;semicolons"');
  });

  it("should escape complex values JSON-stringified in CSV via objectsToCsv", async () => {
    mockListKeys.mockResolvedValue(["mem-1"]);
    mockGet.mockResolvedValue({
      id: "mem-1",
      tier: "working",
      content: 'say "hi", friend\nwelcome',
      tags: [],
      importance: 5,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
    });

    const exporter = createExporter();
    const result = await exporter.exportMemory({ format: "csv" });

    // The content field with special chars should be escaped in CSV
    expect(result.data).toContain("mem-1");
    expect(result.data).toContain("working");
  });
});

describe("parseJsonlContent (via exportSessions structured export)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should parse a single valid JSONL line", async () => {
    mockListKeys.mockResolvedValue(["sess-1"]);
    mockGet.mockResolvedValue({
      sessionId: "sess-1",
      content: JSON.stringify({ role: "user", content: "hello" }),
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      metadata: {},
    });

    const exporter = createExporter();
    const result = await exporter.exportSessions({ format: "json" });
    const parsed = JSON.parse(result.data);
    expect(parsed[0].entries).toEqual([{ role: "user", content: "hello" }]);
  });

  it("should parse valid lines and filter out invalid lines", async () => {
    const content = [
      JSON.stringify({ a: 1 }),
      "{invalid: json}",
      JSON.stringify({ b: 2 }),
      "bare string",
      JSON.stringify({ c: 3 }),
    ].join("\n");

    mockListKeys.mockResolvedValue(["sess-1"]);
    mockGet.mockResolvedValue({
      sessionId: "sess-1",
      content,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      metadata: {},
    });

    const exporter = createExporter();
    const result = await exporter.exportSessions({ format: "json" });
    const parsed = JSON.parse(result.data);
    expect(parsed[0].entries).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("should handle content with empty lines between entries", async () => {
    const content = [
      JSON.stringify({ a: 1 }),
      "",
      JSON.stringify({ b: 2 }),
      "",
    ].join("\n");

    mockListKeys.mockResolvedValue(["sess-1"]);
    mockGet.mockResolvedValue({
      sessionId: "sess-1",
      content,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      metadata: {},
    });

    const exporter = createExporter();
    const result = await exporter.exportSessions({ format: "json" });
    const parsed = JSON.parse(result.data);
    // Empty lines are filtered by .filter(Boolean)
    expect(parsed[0].entries).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("should return empty array for content with only whitespace lines", async () => {
    mockListKeys.mockResolvedValue(["sess-1"]);
    mockGet.mockResolvedValue({
      sessionId: "sess-1",
      content: "  \n  \n  ",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      metadata: {},
    });

    const exporter = createExporter();
    const result = await exporter.exportSessions({ format: "json" });
    const parsed = JSON.parse(result.data);
    // Whitespace-only lines pass .filter(Boolean) but fail JSON.parse → return null → filtered
    expect(parsed[0].entries).toEqual([]);
  });

  it("should parse JSONL content with complex nested values", async () => {
    const nested = { deep: { nested: { value: [1, 2, 3] } }, flag: true, count: 42 };
    mockListKeys.mockResolvedValue(["sess-1"]);
    mockGet.mockResolvedValue({
      sessionId: "sess-1",
      content: JSON.stringify(nested),
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      metadata: {},
    });

    const exporter = createExporter();
    const result = await exporter.exportSessions({ format: "json" });
    const parsed = JSON.parse(result.data);
    expect(parsed[0].entries).toEqual([nested]);
  });
});

describe("objectsToCsv (via exportMemory/exportSessions/exportUserData)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should build union headers from all object keys", async () => {
    mockListKeys.mockResolvedValue(["u1", "u2"]);
    mockGet.mockImplementation(async (_ns: string, key: string) => {
      if (key === "u1") return { key: "u1", value: "v1", namespace: "ns-a" };
      if (key === "u2") return {
        key: "u2", value: "v2", namespace: "ns-b", extraField: "extra",
      };
      return undefined;
    });

    const exporter = createExporter();
    const result = await exporter.exportUserData({ format: "csv" });

    const headers = result.data.split("\n")[0].split(",");
    expect(headers).toContain("key");
    expect(headers).toContain("value");
    expect(headers).toContain("namespace");
    expect(headers).toContain("extraField");
  });

  it("should handle null and undefined values as empty strings", async () => {
    mockListKeys.mockResolvedValue(["u1"]);
    mockGet.mockResolvedValue({
      key: "u1",
      value: null,
      nullable: undefined,
      text: "hello",
    });

    const exporter = createExporter();
    const result = await exporter.exportUserData({ format: "csv" });

    const line = result.data.split("\n")[1];
    // null/undefined should become empty strings in CSV
    expect(line).toBeDefined();
  });

  it("should JSON-stringify non-string values", async () => {
    mockListKeys.mockResolvedValue(["u1"]);
    mockGet.mockResolvedValue({
      key: "u1",
      value: { nested: true },
      count: 42,
    });

    const exporter = createExporter();
    const result = await exporter.exportUserData({ format: "csv" });

    const line = result.data.split("\n")[1];
    // JSON-stringified value gets CSV-escaped (internal quotes are doubled)
    expect(line).toContain('{""nested"":true}');
    expect(line).toContain("42");
  });

  it("should return empty string when objects array is empty", async () => {
    mockListKeys.mockResolvedValue([]);

    const exporter = createExporter();
    const result = await exporter.exportUserData({ format: "csv" });

    expect(result.data).toBe("");
  });
});

describe("exportMemory - JSONL raw content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should handle memory entries with complex nested values", async () => {
    mockListKeys.mockResolvedValue(["mem-1"]);
    mockGet.mockResolvedValue({
      id: "mem-1",
      tier: "episodic",
      content: "complex data",
      tags: ["important", "verified"],
      importance: 8,
      taskSummary: "did something",
      outcome: "success",
      lessons: ["lesson1", "lesson2"],
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
      accessCount: 10,
      lastAccessedAt: "2025-02-01T00:00:00.000Z",
    });

    const exporter = createExporter();
    const result = await exporter.exportMemory({ format: "jsonl" });

    const m = JSON.parse(result.data);
    expect(m.id).toBe("mem-1");
    expect(m.tier).toBe("episodic");
    expect(m.tags).toEqual(["important", "verified"]);
    expect(m.lessons).toEqual(["lesson1", "lesson2"]);
    expect(m.accessCount).toBe(10);
  });
});

describe("DataExporter - edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should handle boolean values in exportData jsonl", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("k1", true),
      mockEntry("k2", false),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({
      namespace: "test", format: "jsonl", includeMetadata: false,
    });

    const lines = result.data.split("\n");
    expect(JSON.parse(lines[0]).value).toBe(true);
    expect(JSON.parse(lines[1]).value).toBe(false);
  });

  it("should handle null values in exportData", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("k1", null),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({
      namespace: "test", format: "jsonl", includeMetadata: false,
    });

    const obj = JSON.parse(result.data);
    expect(obj.value).toBeNull();
  });

  it("should handle number values in exportData", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("k1", 0),
      mockEntry("k2", -1),
      mockEntry("k3", 3.14),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({
      namespace: "test", format: "jsonl", includeMetadata: false,
    });

    const lines = result.data.split("\n");
    expect(JSON.parse(lines[0]).value).toBe(0);
    expect(JSON.parse(lines[1]).value).toBe(-1);
    expect(JSON.parse(lines[2]).value).toBe(3.14);
  });

  it("should handle array values in exportData", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("k1", [1, "two", true, null]),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({
      namespace: "test", format: "jsonl", includeMetadata: false,
    });

    const obj = JSON.parse(result.data);
    expect(obj.value).toEqual([1, "two", true, null]);
  });

  it("should handle entries without tags in csv export (empty tags column)", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("k1", "hello"),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({ namespace: "test", format: "csv" });

    const lines = result.data.split("\n");
    const fields = lines[1].split(",");
    // Last field (tags) should be empty string
    expect(fields[4]).toBe("");
  });

  it("should handle entries with tags in jsonl export without metadata", async () => {
    mockQuery.mockResolvedValue(mockResult([
      mockEntry("k1", "hello", { tags: ["t1", "t2"] }),
    ]));

    const exporter = createExporter();
    const result = await exporter.exportData({
      namespace: "test", format: "jsonl", includeMetadata: false,
    });

    const obj = JSON.parse(result.data);
    // Without metadata, tags should not appear
    expect(obj.tags).toBeUndefined();
    expect(obj.key).toBe("k1");
    expect(obj.value).toBe("hello");
  });
});

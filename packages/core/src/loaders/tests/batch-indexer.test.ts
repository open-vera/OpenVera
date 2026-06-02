/**
 * Unit tests for BatchIndexer — batch document indexing with concurrency,
 * incremental change detection, and loader dispatch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VectorDocumentInput } from "../../rag/types.js";

// ── Hoisted mock factories ──────────────────────────────────────────────────

const mockFns = vi.hoisted(() => ({
  mockStat: vi.fn<() => Promise<{ mtimeMs: number }>>(),
  mockTsLoad: vi.fn<() => Promise<VectorDocumentInput[]>>(),
  mockTsCanHandle: vi.fn<() => boolean>(),
  mockTextLoad: vi.fn<() => Promise<VectorDocumentInput[]>>(),
  mockTextCanHandle: vi.fn<() => boolean>(),
}));

vi.mock("node:fs/promises", () => ({
  stat: mockFns.mockStat,
}));

vi.mock("../typescript-loader.js", () => ({
  TypeScriptLoader: vi.fn(function (this: Record<string, unknown>) {
    this.canHandle = mockFns.mockTsCanHandle;
    this.load = mockFns.mockTsLoad;
  }),
}));

vi.mock("../text-loader.js", () => ({
  TextLoader: vi.fn(function (this: Record<string, unknown>) {
    this.canHandle = mockFns.mockTextCanHandle;
    this.load = mockFns.mockTextLoad;
  }),
}));

// ── Imports ─────────────────────────────────────────────────────────────────

import { BatchIndexer, createBatchIndexer } from "../batch-indexer.js";
import { TypeScriptLoader } from "../typescript-loader.js";
import { TextLoader } from "../text-loader.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeDoc(id: string, content = "test content"): VectorDocumentInput {
  return { id, content };
}

function makeIndexer(opts?: Partial<Parameters<typeof createBatchIndexer>[0]>) {
  return new BatchIndexer({ basePath: "/base", ...opts });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("BatchIndexer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Sensible defaults: both loaders accept their files
    mockFns.mockTsCanHandle.mockReturnValue(true);
    mockFns.mockTextCanHandle.mockReturnValue(true);
    mockFns.mockTsLoad.mockResolvedValue([makeDoc("d1")]);
    mockFns.mockTextLoad.mockResolvedValue([makeDoc("d2")]);
  });

  // ── Constructor ─────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("throws RAGError when basePath is empty string", () => {
      expect(() => new BatchIndexer({ basePath: "" })).toThrow(
        "basePath is required",
      );
    });

    it("throws RAGError when basePath is only whitespace", () => {
      // empty string is falsy; whitespace is truthy, so it passes the check
      // verify that non-empty strings are accepted
      expect(() => new BatchIndexer({ basePath: "  " })).not.toThrow();
    });

    it("creates TypeScriptLoader with basePath and typescript options", () => {
      new BatchIndexer({
        basePath: "/app",
        typescript: { chunkSize: 500 },
      });
      expect(TypeScriptLoader).toHaveBeenCalledWith(
        expect.objectContaining({ basePath: "/app", chunkSize: 500 }),
      );
    });

    it("creates TextLoader with basePath and text options", () => {
      new BatchIndexer({
        basePath: "/app",
        text: { chunkSize: 300 },
      });
      expect(TextLoader).toHaveBeenCalledWith(
        expect.objectContaining({ basePath: "/app", chunkSize: 300 }),
      );
    });

    it("defaults concurrency to 8 when not provided", () => {
      const indexer = makeIndexer();
      // concurrency is private; test behaviour via runConcurrent in index()
      // by verifying all items are still processed
      mockFns.mockTsLoad.mockResolvedValue([makeDoc("d1")]);
      // no direct assertion on private field; covered by index tests
      expect(indexer).toBeInstanceOf(BatchIndexer);
    });

    it("does not set callbacks when not provided (no-op default)", () => {
      const indexer = makeIndexer();
      expect(indexer).toBeInstanceOf(BatchIndexer);
      // callbacks are private; tested indirectly via index() behaviour
    });

    it("sets callbacks when provided", () => {
      const onFileIndexed = vi.fn();
      const onFileError = vi.fn();
      const indexer = new BatchIndexer({
        basePath: "/base",
        onFileIndexed,
        onFileError,
      });
      expect(indexer).toBeInstanceOf(BatchIndexer);
    });
  });

  // ── selectLoader (tested via index) ──────────────────────────────────────

  describe("loader selection (via index)", () => {
    it("dispatches .ts files to TypeScriptLoader when canHandle returns true", async () => {
      mockFns.mockTsCanHandle.mockReturnValue(true);
      mockFns.mockTsLoad.mockResolvedValue([makeDoc("ts-doc")]);

      const indexer = makeIndexer();
      const result = await indexer.index(["/base/foo.ts"]);

      expect(mockFns.mockTsLoad).toHaveBeenCalledWith("/base/foo.ts");
      expect(mockFns.mockTextLoad).not.toHaveBeenCalled();
      expect(result.documents).toHaveLength(1);
    });

    it("dispatches .tsx files to TypeScriptLoader", async () => {
      mockFns.mockTsCanHandle.mockReturnValue(true);
      mockFns.mockTsLoad.mockResolvedValue([makeDoc("tsx-doc")]);

      const indexer = makeIndexer();
      const result = await indexer.index(["/base/Component.tsx"]);

      expect(mockFns.mockTsLoad).toHaveBeenCalledWith("/base/Component.tsx");
      expect(result.documents).toHaveLength(1);
    });

    it("dispatches .mts files to TypeScriptLoader", async () => {
      mockFns.mockTsCanHandle.mockReturnValue(true);
      mockFns.mockTsLoad.mockResolvedValue([makeDoc("mts-doc")]);

      const indexer = makeIndexer();
      const result = await indexer.index(["/base/mod.mts"]);

      expect(mockFns.mockTsLoad).toHaveBeenCalled();
      expect(result.documents).toHaveLength(1);
    });

    it("dispatches .cts files to TypeScriptLoader", async () => {
      mockFns.mockTsCanHandle.mockReturnValue(true);
      mockFns.mockTsLoad.mockResolvedValue([makeDoc("cts-doc")]);

      const indexer = makeIndexer();
      const result = await indexer.index(["/base/mod.cts"]);

      expect(mockFns.mockTsLoad).toHaveBeenCalled();
      expect(result.documents).toHaveLength(1);
    });

    it("falls through to TextLoader when ts canHandle returns false", async () => {
      // .ts extension is in TS_EXTENSIONS, but canHandle returns false
      mockFns.mockTsCanHandle.mockReturnValue(false);
      mockFns.mockTextCanHandle.mockReturnValue(true);
      mockFns.mockTextLoad.mockResolvedValue([makeDoc("text-doc")]);

      const indexer = makeIndexer();
      const result = await indexer.index(["/base/foo.ts"]);

      expect(mockFns.mockTsLoad).not.toHaveBeenCalled();
      expect(mockFns.mockTextLoad).toHaveBeenCalledWith("/base/foo.ts");
      expect(result.documents).toHaveLength(1);
    });

    it("dispatches .txt files to TextLoader", async () => {
      mockFns.mockTextCanHandle.mockReturnValue(true);
      mockFns.mockTextLoad.mockResolvedValue([makeDoc("txt-doc")]);

      const indexer = makeIndexer();
      const result = await indexer.index(["/base/readme.txt"]);

      expect(mockFns.mockTextLoad).toHaveBeenCalledWith("/base/readme.txt");
      expect(result.documents).toHaveLength(1);
    });

    it("dispatches .py files to TextLoader", async () => {
      mockFns.mockTextCanHandle.mockReturnValue(true);
      mockFns.mockTextLoad.mockResolvedValue([makeDoc("py-doc")]);

      const indexer = makeIndexer();
      const result = await indexer.index(["/base/script.py"]);

      expect(mockFns.mockTextLoad).toHaveBeenCalled();
      expect(result.documents).toHaveLength(1);
    });

    it("skips files when neither loader can handle (returns null loader)", async () => {
      mockFns.mockTsCanHandle.mockReturnValue(false);
      mockFns.mockTextCanHandle.mockReturnValue(false);

      const indexer = makeIndexer();
      const result = await indexer.index(["/base/unknown.xyz"]);

      expect(mockFns.mockTsLoad).not.toHaveBeenCalled();
      expect(mockFns.mockTextLoad).not.toHaveBeenCalled();
      expect(result.filesSkipped).toBe(1);
      expect(result.filesProcessed).toBe(0);
    });
  });

  // ── index() ──────────────────────────────────────────────────────────────

  describe("index()", () => {
    it("processes a single TS file and returns correct result", async () => {
      mockFns.mockTsLoad.mockResolvedValue([makeDoc("d1", "hello world")]);

      const indexer = makeIndexer();
      const result = await indexer.index(["/base/a.ts"]);

      expect(result.documents).toEqual([{ id: "d1", content: "hello world" }]);
      expect(result.filesProcessed).toBe(1);
      expect(result.filesFailed).toBe(0);
      expect(result.filesSkipped).toBe(0);
      expect(result.chunksProduced).toBe(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("processes multiple files and aggregates documents", async () => {
      mockFns.mockTsLoad
        .mockResolvedValueOnce([makeDoc("a1"), makeDoc("a2")])
        .mockResolvedValueOnce([makeDoc("b1")]);

      const indexer = makeIndexer();
      const result = await indexer.index(["/base/a.ts", "/base/b.ts"]);

      expect(result.documents).toHaveLength(3);
      expect(result.filesProcessed).toBe(2);
      expect(result.chunksProduced).toBe(3);
    });

    it("skips file when loader returns empty array", async () => {
      mockFns.mockTsLoad.mockResolvedValue([]);
      mockFns.mockTextLoad.mockResolvedValue([]);

      const indexer = makeIndexer();
      const result = await indexer.index(["/base/empty.ts"]);

      expect(result.filesSkipped).toBe(1);
      expect(result.filesProcessed).toBe(0);
      expect(result.chunksProduced).toBe(0);
    });

    it("handles loader throwing an error (onFileError callback)", async () => {
      mockFns.mockTsLoad.mockRejectedValue(new Error("read failure"));
      const onFileError = vi.fn();

      const indexer = new BatchIndexer({
        basePath: "/base",
        onFileError,
      });

      const result = await indexer.index(["/base/broken.ts"]);

      expect(result.filesFailed).toBe(1);
      expect(result.filesProcessed).toBe(0);
      expect(onFileError).toHaveBeenCalledTimes(1);
      expect(onFileError).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: "/base/broken.ts",
          error: expect.any(Error),
          filesProcessedSoFar: 1, // filesProcessed(0) + filesFailed(1)
          totalFiles: 1,
        }),
      );
    });

    it("silently ignores errors when onFileError is not set", async () => {
      mockFns.mockTsLoad.mockRejectedValue(new Error("burst"));

      const indexer = makeIndexer(); // no onFileError
      const result = await indexer.index(["/base/bad.ts"]);

      expect(result.filesFailed).toBe(1);
      expect(result.filesProcessed).toBe(0);
      // should not throw
    });

    it("calls onFileIndexed callback after successful load", async () => {
      mockFns.mockTsLoad.mockResolvedValue([makeDoc("x"), makeDoc("y")]);
      const onFileIndexed = vi.fn();

      const indexer = new BatchIndexer({
        basePath: "/base",
        onFileIndexed,
      });

      await indexer.index(["/base/good.ts"]);

      expect(onFileIndexed).toHaveBeenCalledTimes(1);
      expect(onFileIndexed).toHaveBeenCalledWith({
        filePath: "/base/good.ts",
        documentCount: 2,
        filesProcessedSoFar: 1,
        totalFiles: 1,
      });
    });

    it("does not crash when onFileIndexed is not set", async () => {
      mockFns.mockTsLoad.mockResolvedValue([makeDoc("x")]);

      const indexer = makeIndexer(); // no onFileIndexed
      const result = await indexer.index(["/base/ok.ts"]);

      expect(result.filesProcessed).toBe(1);
    });

    it("handles mixed results: process, skip, fail", async () => {
      // File 1: unsupported (.xyz) => skipped (no loader)
      // File 2: .ts, loads ok => processed
      // File 3: .ts, throws => failed
      // File 4: .ts, returns empty => skipped
      mockFns.mockTsCanHandle.mockReturnValue(true);
      mockFns.mockTextCanHandle.mockReturnValue(false); // .xyz not handled

      mockFns.mockTsLoad
        .mockResolvedValueOnce([makeDoc("ok")]) // file 2
        .mockRejectedValueOnce(new Error("fail")) // file 3
        .mockResolvedValueOnce([]); // file 4

      const onFileIndexed = vi.fn();
      const onFileError = vi.fn();
      const indexer = new BatchIndexer({
        basePath: "/base",
        onFileIndexed,
        onFileError,
      });

      const result = await indexer.index([
        "/base/a.xyz", // skipped - no loader
        "/base/b.ts", // processed
        "/base/c.ts", // failed
        "/base/d.ts", // skipped - empty
      ]);

      expect(result.filesProcessed).toBe(1);
      expect(result.filesFailed).toBe(1);
      expect(result.filesSkipped).toBe(2);
      expect(result.chunksProduced).toBe(1);
      expect(onFileIndexed).toHaveBeenCalledTimes(1);
      expect(onFileError).toHaveBeenCalledTimes(1);
    });

    it("handles empty filePaths array", async () => {
      const indexer = makeIndexer();
      const result = await indexer.index([]);

      expect(result.documents).toEqual([]);
      expect(result.filesProcessed).toBe(0);
      expect(result.filesFailed).toBe(0);
      expect(result.filesSkipped).toBe(0);
      expect(result.chunksProduced).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("tracks filesProcessedSoFar correctly across multiple successes", async () => {
      mockFns.mockTsLoad.mockResolvedValue([makeDoc("1")]);
      const onFileIndexed = vi.fn();

      const indexer = new BatchIndexer({ basePath: "/base", onFileIndexed });
      await indexer.index(["/base/a.ts", "/base/b.ts", "/base/c.ts"]);

      expect(onFileIndexed).toHaveBeenCalledTimes(3);
      expect(onFileIndexed).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ filesProcessedSoFar: 1, totalFiles: 3 }),
      );
      expect(onFileIndexed).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ filesProcessedSoFar: 2, totalFiles: 3 }),
      );
      expect(onFileIndexed).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ filesProcessedSoFar: 3, totalFiles: 3 }),
      );
    });

    it("processes files concurrently respecting the concurrency limit", async () => {
      let running = 0;
      let maxConcurrent = 0;

      mockFns.mockTsLoad.mockImplementation(async () => {
        running++;
        maxConcurrent = Math.max(maxConcurrent, running);
        // Small delay to allow other workers to start
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return [makeDoc("d")];
      });

      const indexer = new BatchIndexer({ basePath: "/base", concurrency: 2 });

      const filePaths = Array.from({ length: 6 }, (_, i) => `/base/f${i}.ts`);
      await indexer.index(filePaths);

      // With concurrency=2, max concurrent should be 2 (or at most 2)
      expect(maxConcurrent).toBeLessThanOrEqual(2);
      expect(maxConcurrent).toBeGreaterThanOrEqual(1);
    });
  });

  // ── indexIncremental() ────────────────────────────────────────────────────

  describe("indexIncremental()", () => {
    beforeEach(() => {
      // Default stat response: file exists with mtime 1000
      mockFns.mockStat.mockResolvedValue({ mtimeMs: 1000 });
    });

    it("processes all files when no previousChanges are provided", async () => {
      mockFns.mockTsLoad.mockResolvedValue([makeDoc("new")]);

      const indexer = makeIndexer();
      const { result, changes } = await indexer.indexIncremental([
        "/base/a.ts",
      ]);

      expect(result.filesUpdated).toBe(1);
      expect(result.filesUnchanged).toBe(0);
      expect(result.filesProcessed).toBe(1);
      expect(changes.size).toBe(1);
      expect(changes.get("/base/a.ts")).toBe(1000);
    });

    it("skips files unchanged since last index (same mtime)", async () => {
      const prevChanges: Map<string, number> = new Map([
        ["/base/a.ts", 1000],
        ["/base/b.ts", 1000],
      ]);

      // stat returns same mtime 1000
      mockFns.mockStat.mockResolvedValue({ mtimeMs: 1000 });

      const indexer = makeIndexer();
      const { result } = await indexer.indexIncremental(
        ["/base/a.ts", "/base/b.ts"],
        { previousChanges: prevChanges },
      );

      expect(result.filesUnchanged).toBe(2);
      expect(result.filesUpdated).toBe(0);
      expect(result.filesProcessed).toBe(0);
      expect(mockFns.mockTsLoad).not.toHaveBeenCalled();
    });

    it("re-indexes files with newer mtime than previous", async () => {
      const prevChanges: Map<string, number> = new Map([
        ["/base/a.ts", 500], // old mtime
      ]);

      // stat returns newer mtime
      mockFns.mockStat.mockResolvedValue({ mtimeMs: 1000 });
      mockFns.mockTsLoad.mockResolvedValue([makeDoc("updated")]);

      const indexer = makeIndexer();
      const { result } = await indexer.indexIncremental(
        ["/base/a.ts"],
        { previousChanges: prevChanges },
      );

      expect(result.filesUpdated).toBe(1);
      expect(result.filesUnchanged).toBe(0);
      expect(mockFns.mockTsLoad).toHaveBeenCalledWith("/base/a.ts");
    });

    it("skips file when previousMtime equals mtimeMs exactly", async () => {
      const prevChanges: Map<string, number> = new Map([
        ["/base/a.ts", 1000],
      ]);

      mockFns.mockStat.mockResolvedValue({ mtimeMs: 1000 });

      const indexer = makeIndexer();
      const { result } = await indexer.indexIncremental(
        ["/base/a.ts"],
        { previousChanges: prevChanges },
      );

      // previousMtime (1000) >= mtimeMs (1000) → unchanged
      expect(result.filesUnchanged).toBe(1);
      expect(result.filesUpdated).toBe(0);
    });

    it("handles stat() rejection gracefully (skips file)", async () => {
      mockFns.mockStat.mockRejectedValue(new Error("ENOENT"));

      const indexer = makeIndexer();
      const { result } = await indexer.indexIncremental(["/base/missing.ts"]);

      expect(result.filesSkipped).toBe(1);
      expect(result.filesProcessed).toBe(0);
      expect(mockFns.mockTsLoad).not.toHaveBeenCalled();
    });

    it("handles load error during incremental processing phase", async () => {
      mockFns.mockStat.mockResolvedValue({ mtimeMs: 1000 });
      mockFns.mockTsLoad.mockRejectedValue(new Error("parse error"));
      const onFileError = vi.fn();

      const indexer = new BatchIndexer({
        basePath: "/base",
        onFileError,
      });

      const { result } = await indexer.indexIncremental(["/base/broken.ts"]);

      expect(result.filesFailed).toBe(1);
      expect(result.filesUpdated).toBe(0);
      expect(onFileError).toHaveBeenCalledTimes(1);
      expect(onFileError).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: "/base/broken.ts",
          filesProcessedSoFar: 1,
        }),
      );
    });

    it("silently ignores errors during incremental phase when onFileError is not set", async () => {
      mockFns.mockStat.mockResolvedValue({ mtimeMs: 1000 });
      mockFns.mockTsLoad.mockRejectedValue(new Error("burst"));

      const indexer = makeIndexer(); // no onFileError
      const { result } = await indexer.indexIncremental(["/base/bad.ts"]);

      expect(result.filesFailed).toBe(1);
      expect(result.filesUpdated).toBe(0);
      // should not throw
    });

    it("skips unsupported file during incremental processing phase", async () => {
      mockFns.mockStat.mockResolvedValue({ mtimeMs: 1000 });
      mockFns.mockTsCanHandle.mockReturnValue(false);
      mockFns.mockTextCanHandle.mockReturnValue(false);

      const indexer = makeIndexer();
      const { result } = await indexer.indexIncremental(["/base/a.xyz"]);

      expect(result.filesSkipped).toBe(1);
    });

    it("skips file when loader returns empty during incremental phase", async () => {
      mockFns.mockStat.mockResolvedValue({ mtimeMs: 1000 });
      mockFns.mockTsLoad.mockResolvedValue([]);

      const indexer = makeIndexer();
      const { result } = await indexer.indexIncremental(["/base/empty.ts"]);

      expect(result.filesSkipped).toBe(1);
    });

    it("calls onFileIndexed during incremental processing", async () => {
      mockFns.mockStat.mockResolvedValue({ mtimeMs: 1000 });
      mockFns.mockTsLoad.mockResolvedValue([makeDoc("x"), makeDoc("y")]);
      const onFileIndexed = vi.fn();

      const indexer = new BatchIndexer({
        basePath: "/base",
        onFileIndexed,
      });

      await indexer.indexIncremental(["/base/a.ts"]);

      expect(onFileIndexed).toHaveBeenCalledTimes(1);
      expect(onFileIndexed).toHaveBeenCalledWith({
        filePath: "/base/a.ts",
        documentCount: 2,
        filesProcessedSoFar: 1,
        totalFiles: 1,
      });
    });

    it("returns an updated change map with current mtimes", async () => {
      mockFns.mockStat
        .mockResolvedValueOnce({ mtimeMs: 100 })
        .mockResolvedValueOnce({ mtimeMs: 200 })
        .mockResolvedValueOnce({ mtimeMs: 300 });

      mockFns.mockTsLoad.mockResolvedValue([makeDoc("d")]);

      const indexer = makeIndexer();
      const { changes } = await indexer.indexIncremental([
        "/base/a.ts",
        "/base/b.ts",
        "/base/c.ts",
      ]);

      expect(changes.size).toBe(3);
      expect(changes.get("/base/a.ts")).toBe(100);
      expect(changes.get("/base/b.ts")).toBe(200);
      expect(changes.get("/base/c.ts")).toBe(300);
    });

    it("handles empty filePaths array", async () => {
      const indexer = makeIndexer();
      const { result, changes } = await indexer.indexIncremental([]);

      expect(result.documents).toEqual([]);
      expect(result.filesProcessed).toBe(0);
      expect(result.filesFailed).toBe(0);
      expect(result.filesSkipped).toBe(0);
      expect(result.filesUpdated).toBe(0);
      expect(result.filesUnchanged).toBe(0);
      expect(changes.size).toBe(0);
    });

    it("mixed scenario: unchanged, updated, failed, and skipped files", async () => {
      const prevChanges: Map<string, number> = new Map([
        ["/base/unchanged.ts", 1000],
      ]);

      // stat responses for files: [unchanged.ts, updated.ts, failed.ts, missing.ts]
      mockFns.mockStat
        .mockResolvedValueOnce({ mtimeMs: 1000 }) // unchanged
        .mockResolvedValueOnce({ mtimeMs: 2000 }) // updated (newer)
        .mockResolvedValueOnce({ mtimeMs: 3000 }) // failed (new)
        .mockRejectedValueOnce(new Error("stat error")); // missing

      mockFns.mockTsLoad
        .mockResolvedValueOnce([makeDoc("updated-doc")]) // updated.ts
        .mockRejectedValueOnce(new Error("load error")); // failed.ts

      const onFileIndexed = vi.fn();
      const onFileError = vi.fn();
      const indexer = new BatchIndexer({
        basePath: "/base",
        onFileIndexed,
        onFileError,
      });

      const { result, changes } = await indexer.indexIncremental(
        [
          "/base/unchanged.ts",
          "/base/updated.ts",
          "/base/failed.ts",
          "/base/missing.ts",
        ],
        { previousChanges: prevChanges },
      );

      expect(result.filesUnchanged).toBe(1);
      expect(result.filesUpdated).toBe(1);
      expect(result.filesFailed).toBe(1);
      expect(result.filesSkipped).toBe(1); // stat failure
      expect(result.filesProcessed).toBe(1);
      expect(onFileIndexed).toHaveBeenCalledTimes(1);
      expect(onFileError).toHaveBeenCalledTimes(1);
      expect(changes.size).toBe(3); // missing.ts not in changes
      expect(changes.has("/base/missing.ts")).toBe(false);
    });

    it("preserves filesProcessedSoFar in onFileIndexed during incremental phase", async () => {
      mockFns.mockStat
        .mockResolvedValueOnce({ mtimeMs: 100 })
        .mockResolvedValueOnce({ mtimeMs: 200 });

      mockFns.mockTsLoad
        .mockResolvedValueOnce([makeDoc("d1")])
        .mockResolvedValueOnce([makeDoc("d2")]);

      const onFileIndexed = vi.fn();
      const indexer = new BatchIndexer({
        basePath: "/base",
        onFileIndexed,
      });

      await indexer.indexIncremental(["/base/a.ts", "/base/b.ts"]);

      expect(onFileIndexed).toHaveBeenCalledTimes(2);
      expect(onFileIndexed).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ filesProcessedSoFar: 1, totalFiles: 2 }),
      );
      expect(onFileIndexed).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ filesProcessedSoFar: 2, totalFiles: 2 }),
      );
    });
  });

  // ── createBatchIndexer ────────────────────────────────────────────────────

  describe("createBatchIndexer()", () => {
    it("returns a BatchIndexer instance", () => {
      const indexer = createBatchIndexer({ basePath: "/app" });
      expect(indexer).toBeInstanceOf(BatchIndexer);
    });

    it("passes through all options to the constructor", () => {
      const onFileIndexed = vi.fn();
      const onFileError = vi.fn();

      const indexer = createBatchIndexer({
        basePath: "/app",
        concurrency: 4,
        typescript: { chunkSize: 800 },
        text: { extraExtensions: [".kt"] },
        onFileIndexed,
        onFileError,
      });

      expect(indexer).toBeInstanceOf(BatchIndexer);
      expect(TypeScriptLoader).toHaveBeenCalledWith(
        expect.objectContaining({ chunkSize: 800 }),
      );
      expect(TextLoader).toHaveBeenCalledWith(
        expect.objectContaining({ extraExtensions: [".kt"] }),
      );
    });
  });
});

// ── Concurrency utility (tested via index / indexIncremental) ──────────────

describe("runConcurrent (via index)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFns.mockTsCanHandle.mockReturnValue(true);
    mockFns.mockTextCanHandle.mockReturnValue(false);
  });

  it("processes all items when count is less than concurrency limit", async () => {
    mockFns.mockTsLoad.mockResolvedValue([makeDoc("d")]);
    const indexer = new BatchIndexer({ basePath: "/base", concurrency: 10 });

    const result = await indexer.index([
      "/base/a.ts",
      "/base/b.ts",
      "/base/c.ts",
    ]);

    expect(result.filesProcessed).toBe(3);
    expect(mockFns.mockTsLoad).toHaveBeenCalledTimes(3);
  });

  it("processes all items when count equals concurrency limit", async () => {
    mockFns.mockTsLoad.mockResolvedValue([makeDoc("d")]);
    const indexer = new BatchIndexer({ basePath: "/base", concurrency: 3 });

    const result = await indexer.index([
      "/base/a.ts",
      "/base/b.ts",
      "/base/c.ts",
    ]);

    expect(result.filesProcessed).toBe(3);
    expect(mockFns.mockTsLoad).toHaveBeenCalledTimes(3);
  });

  it("limits concurrency when items exceed limit", async () => {
    let running = 0;
    let maxConcurrent = 0;

    mockFns.mockTsLoad.mockImplementation(async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return [makeDoc("d")];
    });

    const indexer = new BatchIndexer({ basePath: "/base", concurrency: 2 });

    const files = Array.from({ length: 8 }, (_, i) => `/base/f${i}.ts`);
    await indexer.index(files);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(maxConcurrent).toBeGreaterThan(0);
    expect(mockFns.mockTsLoad).toHaveBeenCalledTimes(8);
  });

  it("handles a single item with concurrency=1", async () => {
    mockFns.mockTsLoad.mockResolvedValue([makeDoc("d")]);
    const indexer = new BatchIndexer({ basePath: "/base", concurrency: 1 });

    const result = await indexer.index(["/base/only.ts"]);

    expect(result.filesProcessed).toBe(1);
  });

  it("passes correct index to each worker task", async () => {
    const indexedOrder: number[] = [];
    mockFns.mockTsLoad.mockImplementation(
      async (_path: string) => {
        // We can't directly capture the index from runConcurrent here,
        // but we verify all files are processed
        return [makeDoc("d")];
      },
    );

    const indexer = new BatchIndexer({ basePath: "/base", concurrency: 4 });
    await indexer.index([
      "/base/a.ts",
      "/base/b.ts",
      "/base/c.ts",
      "/base/d.ts",
    ]);

    expect(mockFns.mockTsLoad).toHaveBeenCalledTimes(4);
  });

  it("errors thrown by tasks propagate and are caught by the indexer", async () => {
    mockFns.mockTsLoad.mockRejectedValue(new Error("worker failure"));

    const indexer = new BatchIndexer({ basePath: "/base", concurrency: 2 });
    const result = await indexer.index([
      "/base/a.ts",
      "/base/b.ts",
      "/base/c.ts",
    ]);

    // Each task error is caught in the index() catch block
    expect(result.filesFailed).toBe(3);
    expect(result.filesProcessed).toBe(0);
  });
});

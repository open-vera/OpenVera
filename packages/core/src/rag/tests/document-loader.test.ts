/**
 * Tests for DocumentLoader — file scanning, chunking, and metadata extraction.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DocumentLoader, createDocumentLoader } from "../document-loader.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "docloader-test-"));
}

function writeFile(dir: string, relPath: string, content: string): void {
  const fullPath = join(dir, relPath);
  const dirName = fullPath.substring(0, fullPath.lastIndexOf("/"));
  mkdirSync(dirName, { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("DocumentLoader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Constructor ────────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("should throw if rootDir is empty", () => {
      expect(() => new DocumentLoader({ rootDir: "" })).toThrow();
    });

    it("should accept custom options", () => {
      const loader = new DocumentLoader({
        rootDir: tmpDir,
        chunkSize: 500,
        chunkOverlap: 50,
        maxFileSize: 100_000,
      });
      expect(loader).toBeDefined();
    });
  });

  // ── File Scanning ──────────────────────────────────────────────────────────

  describe("load", () => {
    it("should load markdown files", () => {
      writeFile(tmpDir, "readme.md", "# Hello\n\nThis is a test.");
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const result = loader.load();

      expect(result.filesScanned).toBe(1);
      expect(result.filesLoaded).toBe(1);
      expect(result.documents.length).toBeGreaterThan(0);
      expect(result.documents[0].metadata?.fileType).toBe("markdown");
      expect(result.documents[0].metadata?.source).toBe("readme.md");
    });

    it("should load TypeScript files", () => {
      writeFile(tmpDir, "src/index.ts", 'export const hello = "world";');
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const result = loader.load();

      expect(result.filesLoaded).toBe(1);
      expect(result.documents[0].metadata?.fileType).toBe("typescript");
    });

    it("should load JSON files", () => {
      writeFile(tmpDir, "config.json", '{"key": "value"}');
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const result = loader.load();

      expect(result.filesLoaded).toBe(1);
      expect(result.documents[0].metadata?.fileType).toBe("json");
    });

    it("should load plain text files", () => {
      writeFile(tmpDir, "notes.txt", "Some notes here.");
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const result = loader.load();

      expect(result.filesLoaded).toBe(1);
      expect(result.documents[0].metadata?.fileType).toBe("text");
    });

    it("should scan subdirectories recursively", () => {
      writeFile(tmpDir, "a/b/c/deep.md", "Deep content");
      writeFile(tmpDir, "shallow.md", "Shallow content");
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const result = loader.load();

      expect(result.filesLoaded).toBe(2);
    });

    it("should exclude node_modules by default", () => {
      writeFile(tmpDir, "src/index.ts", "code");
      writeFile(tmpDir, "node_modules/pkg/index.ts", "ignored");
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const result = loader.load();

      expect(result.filesLoaded).toBe(1);
      expect(result.documents[0].metadata?.source).toBe("src/index.ts");
    });

    it("should exclude .git by default", () => {
      writeFile(tmpDir, "src/code.ts", "code");
      writeFile(tmpDir, ".git/config", "git stuff");
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const result = loader.load();

      expect(result.filesLoaded).toBe(1);
    });

    it("should respect custom exclude patterns", () => {
      writeFile(tmpDir, "src/code.ts", "code");
      writeFile(tmpDir, "vendor/lib.ts", "vendor code");
      const loader = new DocumentLoader({
        rootDir: tmpDir,
        exclude: ["vendor"],
      });
      const result = loader.load();

      expect(result.filesLoaded).toBe(1);
    });

    it("should respect custom extensions filter", () => {
      writeFile(tmpDir, "readme.md", "# Hello");
      writeFile(tmpDir, "code.ts", "const x = 1;");
      writeFile(tmpDir, "data.txt", "text");
      const loader = new DocumentLoader({
        rootDir: tmpDir,
        extensions: [".md"],
      });
      const result = loader.load();

      expect(result.filesLoaded).toBe(1);
      expect(result.documents[0].metadata?.fileType).toBe("markdown");
    });

    it("should skip files exceeding maxFileSize", () => {
      const bigContent = "x".repeat(2000);
      writeFile(tmpDir, "big.md", bigContent);
      writeFile(tmpDir, "small.md", "tiny");
      const loader = new DocumentLoader({
        rootDir: tmpDir,
        maxFileSize: 100,
      });
      const result = loader.load();

      expect(result.filesLoaded).toBe(1);
      expect(result.documents[0].metadata?.source).toBe("small.md");
    });

    it("should return empty result for empty directory", () => {
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const result = loader.load();

      expect(result.filesScanned).toBe(0);
      expect(result.filesLoaded).toBe(0);
      expect(result.documents).toEqual([]);
    });
  });

  // ── Chunking ───────────────────────────────────────────────────────────────

  describe("chunking", () => {
    it("should not chunk small documents", () => {
      writeFile(tmpDir, "short.md", "Short content.");
      const loader = new DocumentLoader({ rootDir: tmpDir, chunkSize: 1000 });
      const result = loader.load();

      expect(result.chunksProduced).toBe(1);
      expect(result.documents[0].metadata?.chunkIndex).toBe(0);
      expect(result.documents[0].metadata?.totalChunks).toBe(1);
    });

    it("should chunk large documents", () => {
      const longContent = "word ".repeat(100); // ~500 chars
      writeFile(tmpDir, "long.md", longContent);
      const loader = new DocumentLoader({
        rootDir: tmpDir,
        chunkSize: 200,
        chunkOverlap: 30,
      });
      const result = loader.load();

      expect(result.chunksProduced).toBeGreaterThan(1);
      for (const doc of result.documents) {
        expect(doc.metadata?.totalChunks).toBe(result.chunksProduced);
      }
    });

    it("should set chunkIndex correctly", () => {
      const longContent = "x".repeat(900);
      writeFile(tmpDir, "multi.md", longContent);
      const loader = new DocumentLoader({
        rootDir: tmpDir,
        chunkSize: 300,
        chunkOverlap: 50,
      });
      const result = loader.load();

      const indices = result.documents.map((d) => d.metadata?.chunkIndex);
      expect(indices.length).toBeGreaterThan(1);
      // Indices should be sequential starting from 0
      for (let i = 0; i < indices.length; i++) {
        expect(indices[i]).toBe(i);
      }
    });

    it("should generate unique IDs per chunk", () => {
      const longContent = "y".repeat(900);
      writeFile(tmpDir, "chunks.md", longContent);
      const loader = new DocumentLoader({
        rootDir: tmpDir,
        chunkSize: 300,
      });
      const result = loader.load();

      const ids = result.documents.map((d) => d.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it("should use idPrefix when provided", () => {
      writeFile(tmpDir, "file.md", "content");
      const loader = new DocumentLoader({
        rootDir: tmpDir,
        idPrefix: "myproject",
      });
      const result = loader.load();

      expect(result.documents[0].id).toMatch(/^myproject:/);
    });
  });

  // ── loadFile ───────────────────────────────────────────────────────────────

  describe("loadFile", () => {
    it("should load a single file", () => {
      writeFile(tmpDir, "test.md", "# Test\n\nHello world.");
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const docs = loader.loadFile(join(tmpDir, "test.md"));

      expect(docs).toHaveLength(1);
      expect(docs[0].content).toContain("Hello world");
      expect(docs[0].metadata?.fileType).toBe("markdown");
    });

    it("should return empty array for non-existent file", () => {
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const docs = loader.loadFile(join(tmpDir, "nonexistent.md"));
      expect(docs).toEqual([]);
    });

    it("should chunk large files", () => {
      const longContent = "z".repeat(1500);
      writeFile(tmpDir, "big.md", longContent);
      const loader = new DocumentLoader({
        rootDir: tmpDir,
        chunkSize: 500,
      });
      const docs = loader.loadFile(join(tmpDir, "big.md"));

      expect(docs.length).toBeGreaterThan(1);
    });
  });

  // ── Factory ────────────────────────────────────────────────────────────────

  describe("createDocumentLoader", () => {
    it("should create a DocumentLoader instance", () => {
      const loader = createDocumentLoader({ rootDir: tmpDir });
      expect(loader).toBeInstanceOf(DocumentLoader);
    });
  });
});

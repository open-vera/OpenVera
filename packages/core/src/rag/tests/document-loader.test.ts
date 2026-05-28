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

    it("should load JavaScript files as text type", () => {
      writeFile(tmpDir, "app.js", "console.log('hello');");
      writeFile(tmpDir, "ui.jsx", "<div/>");
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const result = loader.load();

      expect(result.filesLoaded).toBe(2);
      for (const doc of result.documents) {
        expect(doc.metadata?.fileType).toBe("text");
      }
    });

    it("should load JSONL files as json type", () => {
      writeFile(tmpDir, "data.jsonl", '{"id":1}\n{"id":2}');
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const result = loader.load();

      expect(result.filesLoaded).toBe(1);
      expect(result.documents[0].metadata?.fileType).toBe("json");
    });

    it("should load MDX files as markdown type", () => {
      writeFile(tmpDir, "page.mdx", "# MDX\n\nexport const meta = {}");
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const result = loader.load();

      expect(result.filesLoaded).toBe(1);
      expect(result.documents[0].metadata?.fileType).toBe("markdown");
    });

    it("should load TSX files as typescript type", () => {
      writeFile(tmpDir, "Component.tsx", "export const App = () => <div/>");
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const result = loader.load();

      expect(result.filesLoaded).toBe(1);
      expect(result.documents[0].metadata?.fileType).toBe("typescript");
    });

    it("should skip empty files (size 0)", () => {
      writeFile(tmpDir, "empty.md", "");
      writeFile(tmpDir, "nonempty.md", "content");
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const result = loader.load();

      expect(result.filesScanned).toBe(2);
      expect(result.filesLoaded).toBe(1);
    });

    it("should skip files with unsupported extensions", () => {
      writeFile(tmpDir, "image.png", "binarydata");
      writeFile(tmpDir, "readme.md", "# Hello");
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const result = loader.load();

      expect(result.filesScanned).toBe(1);
      expect(result.filesLoaded).toBe(1);
      expect(result.documents[0].metadata?.source).toBe("readme.md");
    });

    it("should exclude multiple default patterns", () => {
      writeFile(tmpDir, "src/main.ts", "code");
      writeFile(tmpDir, "dist/bundle.js", "built");
      writeFile(tmpDir, "build/output.js", "built");
      writeFile(tmpDir, ".next/cache", "next");
      writeFile(tmpDir, "coverage/report.html", "cov");
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const result = loader.load();

      expect(result.filesLoaded).toBe(1);
      expect(result.documents[0].metadata?.source).toBe("src/main.ts");
    });

    it("should handle glob patterns in exclude with wildcards", () => {
      writeFile(tmpDir, "src/main.ts", "code");
      writeFile(tmpDir, "temp-data/temp.ts", "temp");
      writeFile(tmpDir, "other/data.ts", "other");
      const loader = new DocumentLoader({
        rootDir: tmpDir,
        exclude: ["temp-*"],
      });
      const result = loader.load();

      expect(result.filesLoaded).toBe(2);
    });

    it("should handle glob patterns with question mark wildcards", () => {
      writeFile(tmpDir, "src/a.ts", "code");
      writeFile(tmpDir, "tmp/b.ts", "temp");
      writeFile(tmpDir, "tmp2/c.ts", "temp2");
      const loader = new DocumentLoader({
        rootDir: tmpDir,
        exclude: ["tm?"],
      });
      const result = loader.load();

      expect(result.filesLoaded).toBe(2);
    });

    it("should exclude dist directory by default", () => {
      writeFile(tmpDir, "src/index.ts", "code");
      writeFile(tmpDir, "dist/index.js", "built");
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const result = loader.load();

      expect(result.filesLoaded).toBe(1);
    });

    it("should load multiple file types in mixed directory", () => {
      writeFile(tmpDir, "README.md", "# Project");
      writeFile(tmpDir, "config.json", '{"name":"test"}');
      writeFile(tmpDir, "src/index.ts", "export {}");
      writeFile(tmpDir, "notes.txt", "notes");
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const result = loader.load();

      expect(result.filesLoaded).toBe(4);
      const types = result.documents.map((d) => d.metadata?.fileType);
      expect(types).toContain("markdown");
      expect(types).toContain("json");
      expect(types).toContain("typescript");
      expect(types).toContain("text");
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

    it("should break at paragraph boundaries when possible", () => {
      // Create text that's longer than chunkSize with paragraph breaks
      const paragraph1 = "a".repeat(400);
      const paragraph2 = "b".repeat(400);
      const paragraph3 = "c".repeat(400);
      const content = `${paragraph1}\n\n${paragraph2}\n\n${paragraph3}`;
      writeFile(tmpDir, "para.md", content);
      const loader = new DocumentLoader({
        rootDir: tmpDir,
        chunkSize: 600,
        chunkOverlap: 50,
      });
      const result = loader.load();

      // Should produce multiple chunks, and one of them should break at \n\n
      expect(result.chunksProduced).toBeGreaterThan(1);
    });

    it("should break at sentence boundaries when no paragraph break", () => {
      // Create text with sentence breaks but no paragraph breaks
      const sentence1 = "This is sentence one. ";
      const sentence2 = "This is sentence two. ";
      const sentence3 = "This is sentence three. ";
      const sentence4 = "This is sentence four. ";
      const sentence5 = "This is sentence five. ";
      const content = (sentence1 + sentence2 + sentence3 + sentence4 + sentence5).repeat(10);
      writeFile(tmpDir, "sent.md", content);
      const loader = new DocumentLoader({
        rootDir: tmpDir,
        chunkSize: 150,
        chunkOverlap: 20,
      });
      const result = loader.load();

      expect(result.chunksProduced).toBeGreaterThan(1);
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

    it("should return empty array for empty file", () => {
      writeFile(tmpDir, "empty.md", "");
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const docs = loader.loadFile(join(tmpDir, "empty.md"));
      expect(docs).toEqual([]);
    });

    it("should use idPrefix for single file load", () => {
      writeFile(tmpDir, "test.md", "content");
      const loader = new DocumentLoader({
        rootDir: tmpDir,
        idPrefix: "proj",
      });
      const docs = loader.loadFile(join(tmpDir, "test.md"));

      expect(docs).toHaveLength(1);
      expect(docs[0].id).toMatch(/^proj:/);
    });

    it("should handle single file without idPrefix", () => {
      writeFile(tmpDir, "test.md", "content");
      const loader = new DocumentLoader({ rootDir: tmpDir });
      const docs = loader.loadFile(join(tmpDir, "test.md"));

      expect(docs).toHaveLength(1);
      expect(docs[0].id).toMatch(/^test\.md:0$/);
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

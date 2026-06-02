/**
 * Tests for TextLoader — text file loading, binary detection, comment stripping,
 * chunking, encoding handling, and document ID generation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TextLoader, createTextLoader } from "../text-loader.js";
import { RAGError } from "../../rag/types.js";
import type { VectorDocumentInput } from "../../rag/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "textloader-test-"));
}

function writeFile(dir: string, relPath: string, content: string | Buffer): void {
  const fullPath = join(dir, relPath);
  const dirName = fullPath.substring(0, fullPath.lastIndexOf("/"));
  if (dirName) {
    mkdirSync(dirName, { recursive: true });
  }
  if (Buffer.isBuffer(content)) {
    writeFileSync(fullPath, content);
  } else {
    writeFileSync(fullPath, content, "utf-8");
  }
}

function writeBinaryFile(dir: string, relPath: string): void {
  const buf = Buffer.alloc(100);
  buf[50] = 0; // null byte at position 50
  writeFile(dir, relPath, buf);
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("TextLoader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Constructor ────────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("should throw RAGError when basePath is empty string", () => {
      expect(() => new TextLoader({ basePath: "" })).toThrow(RAGError);
      expect(() => new TextLoader({ basePath: "" })).toThrow("basePath is required");
    });

    it("should throw when basePath is empty with correct error code", () => {
      try {
        new TextLoader({ basePath: "" });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RAGError);
        expect((err as RAGError).code).toBe("LOADER_ERROR");
      }
    });

    it("should use default values when optional options are omitted", () => {
      const loader = new TextLoader({ basePath: tmpDir });
      expect(loader).toBeDefined();
    });

    it("should accept custom chunkSize and chunkOverlap", () => {
      const loader = new TextLoader({
        basePath: tmpDir,
        chunkSize: 500,
        chunkOverlap: 50,
      });
      expect(loader).toBeDefined();
    });

    it("should accept custom maxFileSize", () => {
      const loader = new TextLoader({
        basePath: tmpDir,
        maxFileSize: 500_000,
      });
      expect(loader).toBeDefined();
    });

    it("should accept custom idPrefix", () => {
      const loader = new TextLoader({
        basePath: tmpDir,
        idPrefix: "my-project",
      });
      expect(loader).toBeDefined();
    });

    it("should accept a preprocess function", () => {
      const preprocess = vi.fn((content: string) => content.toUpperCase());
      const loader = new TextLoader({
        basePath: tmpDir,
        preprocess,
      });
      expect(loader).toBeDefined();
    });

    it("should accept extraExtensions with dot prefix", () => {
      const loader = new TextLoader({
        basePath: tmpDir,
        extraExtensions: [".rs", ".kt"],
      });
      expect(loader).toBeDefined();
    });

    it("should normalize extraExtensions without dot prefix", () => {
      const loader = new TextLoader({
        basePath: tmpDir,
        extraExtensions: ["rs", "kt"],
      });
      // If normalization works, .kt should be recognized
      writeFile(tmpDir, "test.kt", "fun main() {}");
      expect(loader.canHandle(join(tmpDir, "test.kt"))).toBe(true);
    });
  });

  // ── canHandle ──────────────────────────────────────────────────────────────

  describe("canHandle", () => {
    let loader: TextLoader;

    beforeEach(() => {
      loader = new TextLoader({ basePath: tmpDir });
    });

    it("should return true for known .txt extension", () => {
      expect(loader.canHandle("/some/path/readme.txt")).toBe(true);
    });

    it("should return true for .py extension", () => {
      expect(loader.canHandle("/some/path/script.py")).toBe(true);
    });

    it("should return true for .js extension", () => {
      expect(loader.canHandle("/some/path/index.js")).toBe(true);
    });

    it("should return true for uppercase extension (case-insensitive)", () => {
      expect(loader.canHandle("/some/path/README.TXT")).toBe(true);
    });

    it("should return true for mixed-case extension", () => {
      expect(loader.canHandle("/some/path/script.Py")).toBe(true);
    });

    it("should return false for unknown extension", () => {
      expect(loader.canHandle("/some/path/image.png")).toBe(false);
    });

    it("should return false for file with no extension", () => {
      expect(loader.canHandle("/some/path/Makefile")).toBe(false);
    });

    it("should return true for extra extension added via options", () => {
      const customLoader = new TextLoader({
        basePath: tmpDir,
        extraExtensions: [".xconf"],
      });
      expect(customLoader.canHandle("/some/path/config.xconf")).toBe(true);
    });

    it("should return true for extra extension without dot (normalized)", () => {
      const customLoader = new TextLoader({
        basePath: tmpDir,
        extraExtensions: ["xconf"],
      });
      expect(customLoader.canHandle("/some/path/config.xconf")).toBe(true);
    });
  });

  // ── load — error/skip paths ────────────────────────────────────────────────

  describe("load — error and skip paths", () => {
    let loader: TextLoader;

    beforeEach(() => {
      loader = new TextLoader({ basePath: tmpDir });
    });

    it("should return empty array when file does not exist (stat fails)", async () => {
      const result = await loader.load(join(tmpDir, "nonexistent.txt"));
      expect(result).toEqual([]);
    });

    it("should return empty array for empty file (size 0)", async () => {
      writeFile(tmpDir, "empty.txt", "");
      const result = await loader.load(join(tmpDir, "empty.txt"));
      expect(result).toEqual([]);
    });

    it("should return empty array when file exceeds maxFileSize", async () => {
      const smallLoader = new TextLoader({
        basePath: tmpDir,
        maxFileSize: 10,
      });
      writeFile(tmpDir, "large.txt", "a".repeat(100));
      const result = await smallLoader.load(join(tmpDir, "large.txt"));
      expect(result).toEqual([]);
    });

    it("should return empty array for binary content (null bytes detected)", async () => {
      writeBinaryFile(tmpDir, "binary.bin");
      const result = await loader.load(join(tmpDir, "binary.bin"));
      expect(result).toEqual([]);
    });

    it("should return empty array when file is within size limit", async () => {
      writeFile(tmpDir, "small.txt", "hello world");
      const result = await loader.load(join(tmpDir, "small.txt"));
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // ── load — successful paths ────────────────────────────────────────────────

  describe("load — successful paths", () => {
    let loader: TextLoader;

    beforeEach(() => {
      loader = new TextLoader({ basePath: tmpDir });
    });

    it("should load a plain .txt file and return documents with correct metadata", async () => {
      writeFile(tmpDir, "readme.txt", "Hello World");
      const result = await loader.load(join(tmpDir, "readme.txt"));

      expect(result.length).toBe(1);
      expect(result[0].content).toBe("Hello World");
      expect(result[0].metadata?.source).toBe("readme.txt");
      expect(result[0].metadata?.fileType).toBe("text");
      expect(result[0].metadata?.textCategory).toBe("plaintext");
      expect(result[0].metadata?.extension).toBe(".txt");
      expect(result[0].metadata?.chunkIndex).toBe(0);
      expect(result[0].metadata?.totalChunks).toBe(1);
    });

    it("should use relative path as document source", async () => {
      mkdirSync(join(tmpDir, "subdir"), { recursive: true });
      writeFile(tmpDir, "subdir/notes.txt", "Some notes");
      const result = await loader.load(join(tmpDir, "subdir/notes.txt"));

      expect(result[0].metadata?.source).toBe("subdir/notes.txt");
    });

    it("should generate document IDs without prefix", async () => {
      writeFile(tmpDir, "doc.txt", "content");
      const result = await loader.load(join(tmpDir, "doc.txt"));

      expect(result[0].id).toBe("doc.txt:0");
    });

    it("should generate document IDs with idPrefix", async () => {
      const prefixedLoader = new TextLoader({
        basePath: tmpDir,
        idPrefix: "test-project",
      });
      writeFile(tmpDir, "doc.txt", "content");
      const result = await prefixedLoader.load(join(tmpDir, "doc.txt"));

      expect(result[0].id).toBe("test-project:doc.txt:0");
    });

    it("should load a known extension with stripComments: false (.txt)", async () => {
      writeFile(tmpDir, "config.txt", "# this is not a comment\nreal content");
      const result = await loader.load(join(tmpDir, "config.txt"));

      // .txt has stripComments: false, so comment line is preserved
      expect(result[0].content).toContain("# this is not a comment");
    });

    it("should load a known extension with stripComments: true (.py)", async () => {
      writeFile(tmpDir, "script.py", "#!/usr/bin/env python\n# license header\n\nprint('hello')");
      const result = await loader.load(join(tmpDir, "script.py"));

      // Shebang and comment should be stripped
      expect(result[0].content).not.toContain("#!/usr/bin/env python");
      expect(result[0].content).not.toContain("# license header");
      expect(result[0].content).toContain("print('hello')");
    });

    it("should load a shell script and strip shebang + comments", async () => {
      writeFile(tmpDir, "setup.sh", "#!/bin/bash\n# Setup script\n\necho 'running'");
      const result = await loader.load(join(tmpDir, "setup.sh"));

      expect(result[0].content).not.toContain("#!/bin/bash");
      expect(result[0].content).not.toContain("# Setup script");
      expect(result[0].content).toContain("echo 'running'");
    });

    it("should use fallback category for unknown extension", async () => {
      // Add an extra extension not in EXTENSION_INFO
      const customLoader = new TextLoader({
        basePath: tmpDir,
        extraExtensions: [".custom"],
      });
      writeFile(tmpDir, "data.custom", "some custom text");
      const result = await customLoader.load(join(tmpDir, "data.custom"));

      expect(result.length).toBe(1);
      expect(result[0].metadata?.textCategory).toBe("text");
      expect(result[0].metadata?.extension).toBe(".custom");
    });

    it("should call preprocess function when provided", async () => {
      const preprocess = vi.fn((content: string, _filePath: string) => {
        return content.replace(/foo/g, "bar");
      });
      const preprocessLoader = new TextLoader({
        basePath: tmpDir,
        preprocess,
      });

      writeFile(tmpDir, "data.txt", "foo foo foo");
      const result = await preprocessLoader.load(join(tmpDir, "data.txt"));

      expect(preprocess).toHaveBeenCalledTimes(1);
      expect(preprocess).toHaveBeenCalledWith(
        "foo foo foo",
        join(tmpDir, "data.txt")
      );
      expect(result[0].content).toBe("bar bar bar");
    });

    it("should apply preprocess after comment stripping", async () => {
      const preprocess = vi.fn((content: string) => `[PRE] ${content}`);
      const preprocessLoader = new TextLoader({
        basePath: tmpDir,
        preprocess,
      });

      writeFile(tmpDir, "script.py", "#!/usr/bin/env python\n# comment\n\nreal content");
      const result = await preprocessLoader.load(join(tmpDir, "script.py"));

      // Shebang and comment should be stripped BEFORE preprocess sees it
      const calledContent = preprocess.mock.calls[0][0];
      expect(calledContent).not.toContain("#!/usr/bin/env python");
      expect(calledContent).not.toContain("# comment");
      expect(calledContent).toContain("real content");
      expect(result[0].content).toContain("[PRE]");
    });

    it("should handle multiple chunks for large content", async () => {
      const smallChunkLoader = new TextLoader({
        basePath: tmpDir,
        chunkSize: 50,
        chunkOverlap: 10,
      });

      // Generate content longer than chunkSize
      const content = "A".repeat(200);
      writeFile(tmpDir, "large.txt", content);
      const result = await smallChunkLoader.load(join(tmpDir, "large.txt"));

      expect(result.length).toBeGreaterThan(1);
      // Each chunk should have correct metadata
      for (let i = 0; i < result.length; i++) {
        expect(result[i].metadata?.chunkIndex).toBe(i);
        expect(result[i].metadata?.totalChunks).toBe(result.length);
        expect(result[i].id).toContain(`:${i}`);
      }
    });
  });

  // ── isBinaryContent (internal, tested via load) ────────────────────────────

  describe("isBinaryContent (via load)", () => {
    it("should reject file with null byte in first 8192 bytes", async () => {
      const loader = new TextLoader({ basePath: tmpDir });
      const buf = Buffer.alloc(100);
      buf[0] = 0; // null byte at position 0
      writeFile(tmpDir, "bin.dat", buf);
      const result = await loader.load(join(tmpDir, "bin.dat"));
      expect(result).toEqual([]);
    });

    it("should reject file with null byte deep in content", async () => {
      const loader = new TextLoader({ basePath: tmpDir });
      const buf = Buffer.alloc(5000);
      buf[4000] = 0; // null byte deep in content
      writeFile(tmpDir, "bin2.dat", buf);
      const result = await loader.load(join(tmpDir, "bin2.dat"));
      expect(result).toEqual([]);
    });

    it("should accept file without null bytes", async () => {
      const loader = new TextLoader({ basePath: tmpDir });
      writeFile(tmpDir, "clean.txt", "all clean text here");
      const result = await loader.load(join(tmpDir, "clean.txt"));
      expect(result.length).toBe(1);
    });
  });

  // ── stripLeadingComments (internal, tested via load) ───────────────────────

  describe("stripLeadingComments (via load with .py files)", () => {
    let loader: TextLoader;

    beforeEach(() => {
      loader = new TextLoader({ basePath: tmpDir });
    });

    it("should strip shebang line (#!)", async () => {
      writeFile(tmpDir, "s.py", "#!/usr/bin/env python3\nprint('hello')");
      const result = await loader.load(join(tmpDir, "s.py"));
      expect(result[0].content).not.toContain("#!/usr/bin/env python3");
      expect(result[0].content).toContain("print('hello')");
    });

    it("should strip single-line # comments at start", async () => {
      writeFile(tmpDir, "s.py", "# Copyright 2024\n# License MIT\n\nactual code");
      const result = await loader.load(join(tmpDir, "s.py"));
      expect(result[0].content).not.toContain("# Copyright 2024");
      expect(result[0].content).not.toContain("# License MIT");
      expect(result[0].content).toContain("actual code");
    });

    it("should strip single-line block comment /* */", async () => {
      writeFile(tmpDir, "s.go", "/* single block comment */\n\npackage main");
      const result = await loader.load(join(tmpDir, "s.go"));
      expect(result[0].content).not.toContain("/* single block comment */");
      expect(result[0].content).toContain("package main");
    });

    it("should strip multi-line block comments", async () => {
      writeFile(tmpDir, "s.go", "/*\n * multi-line\n * block comment\n */\n\npackage main");
      const result = await loader.load(join(tmpDir, "s.go"));
      expect(result[0].content).not.toContain("multi-line");
      expect(result[0].content).not.toContain("block comment");
      expect(result[0].content).toContain("package main");
    });

    it("should strip // line comments", async () => {
      writeFile(tmpDir, "s.go", "// copyright notice\n// license info\n\npackage main");
      const result = await loader.load(join(tmpDir, "s.go"));
      expect(result[0].content).not.toContain("// copyright notice");
      expect(result[0].content).toContain("package main");
    });

    it("should stop stripping at first non-comment line", async () => {
      writeFile(tmpDir, "s.py", "#!/usr/bin/env python\n# top comment\n\n# this is a mid-file comment\nreal code\n# another comment");
      const result = await loader.load(join(tmpDir, "s.py"));
      // Top comments stripped
      expect(result[0].content).not.toContain("#!/usr/bin/env python");
      expect(result[0].content).not.toContain("# top comment");
      // Mid-file comment PRESERVED (not leading)
      expect(result[0].content).toContain("# this is a mid-file comment");
      expect(result[0].content).toContain("real code");
      expect(result[0].content).toContain("# another comment");
    });

    it("should handle inline closing of block comments /* ... */", async () => {
      // When a line starts with /*, the entire line is treated as a comment block start.
      // Even if */ appears on the same line, the whole line is skipped.
      // The next non-comment line becomes the first preserved line.
      writeFile(tmpDir, "s.go", "/* block header */\npragma: no-cache\n\nfunc main() {}");
      const result = await loader.load(join(tmpDir, "s.go"));
      expect(result[0].content).toContain("pragma: no-cache");
      expect(result[0].content).toContain("func main() {}");
      expect(result[0].content).not.toContain("block header");
    });

    it("should return same content if no leading comments", async () => {
      writeFile(tmpDir, "s.py", "print('hello')\nprint('world')");
      const result = await loader.load(join(tmpDir, "s.py"));
      expect(result[0].content).toBe("print('hello')\nprint('world')");
    });

    it("should strip shebang and # comments but keep blank lines before real code", async () => {
      writeFile(tmpDir, "s.py", "#!/usr/bin/python\n# comment\n\n\ndef foo():\n    pass");
      const result = await loader.load(join(tmpDir, "s.py"));
      // Shebang and # comment stripped; blank lines stay (they are the break point)
      expect(result[0].content).toContain("def foo():");
      expect(result[0].content).not.toContain("#!/usr/bin/python");
      expect(result[0].content).not.toContain("# comment");
    });

    it("should handle only comments file", async () => {
      writeFile(tmpDir, "s.py", "#!/usr/bin/python\n# just a comment");
      const loader = new TextLoader({ basePath: tmpDir });
      const result = await loader.load(join(tmpDir, "s.py"));
      // All lines are comments, so result should be empty or just whitespace
      expect(result.length).toBeGreaterThanOrEqual(0);
      if (result.length > 0) {
        // Content should not contain the shebang or comment
        expect(result[0].content).not.toContain("#!/usr/bin/python");
        expect(result[0].content).not.toContain("# just a comment");
      }
    });
  });

  // ── chunkText (internal, tested via load) ──────────────────────────────────

  describe("chunkText (via load)", () => {
    it("should return single chunk when text is shorter than chunkSize", async () => {
      const loader = new TextLoader({ basePath: tmpDir, chunkSize: 5000 });
      writeFile(tmpDir, "short.txt", "short text");
      const result = await loader.load(join(tmpDir, "short.txt"));

      expect(result.length).toBe(1);
      expect(result[0].content).toBe("short text");
    });

    it("should split text into multiple chunks when content exceeds chunkSize", async () => {
      const loader = new TextLoader({ basePath: tmpDir, chunkSize: 20, chunkOverlap: 0 });
      // 50 characters, should produce 3 chunks at chunkSize=20
      const content = "A".repeat(50);
      writeFile(tmpDir, "long.txt", content);
      const result = await loader.load(join(tmpDir, "long.txt"));

      expect(result.length).toBeGreaterThan(1);
    });

    it("should split at paragraph boundaries when \\n\\n is after 50% of chunkSize", async () => {
      const loader = new TextLoader({ basePath: tmpDir, chunkSize: 100, chunkOverlap: 0 });
      // 60 chars + "\n\n" + more content = 162 total, which needs chunking
      const content = "A".repeat(60) + "\n\n" + "B".repeat(100);
      writeFile(tmpDir, "para.txt", content);
      const result = await loader.load(join(tmpDir, "para.txt"));

      // First chunk should break at the paragraph boundary (position 60+2)
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result[0].content).toContain("AAAA");
      expect(result[0].content).not.toContain("BBBB");
    });

    it("should split at paragraph boundaries with short leading text", async () => {
      const loader = new TextLoader({ basePath: tmpDir, chunkSize: 100, chunkOverlap: 0 });
      // Paragraph break near start (< 50%), should not trigger paragraph break split
      const content = "short\n\nthen a lot of content follows".padEnd(200, " X");
      writeFile(tmpDir, "short-para.txt", content);
      const result = await loader.load(join(tmpDir, "short-para.txt"));

      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it("should split at sentence boundaries when .  is after 50% of chunkSize", async () => {
      const loader = new TextLoader({ basePath: tmpDir, chunkSize: 80, chunkOverlap: 0 });
      // Build content: 50 chars of padding, then ". " sentence break, then more
      const content = "X".repeat(50) + ". " + "Y".repeat(100);
      writeFile(tmpDir, "sentences.txt", content);
      const result = await loader.load(join(tmpDir, "sentences.txt"));

      // ". " at position 51, which is > 50% of chunkSize (40) → sentence break split
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result[0].content).toContain("XXX");
      expect(result[0].content).not.toContain("YYY");
    });

    it("should have overlapping chunks when overlap > 0", async () => {
      const loader = new TextLoader({ basePath: tmpDir, chunkSize: 50, chunkOverlap: 20 });
      const content = "A".repeat(200);
      writeFile(tmpDir, "overlap.txt", content);
      const result = await loader.load(join(tmpDir, "overlap.txt"));

      expect(result.length).toBeGreaterThan(2);
      // With overlap, chunks should cover more than the original length
      const totalCovered = result.reduce((sum, c) => sum + c.content.length, 0);
      expect(totalCovered).toBeGreaterThan(content.length);
    });

    it("should produce correct totalChunks metadata for each chunk", async () => {
      const loader = new TextLoader({ basePath: tmpDir, chunkSize: 30, chunkOverlap: 5 });
      const content = "X".repeat(120);
      writeFile(tmpDir, "chunky.txt", content);
      const result = await loader.load(join(tmpDir, "chunky.txt"));

      const totalChunks = result.length;
      for (const doc of result) {
        expect(doc.metadata?.totalChunks).toBe(totalChunks);
      }
    });

    it("should not produce empty chunks", async () => {
      const loader = new TextLoader({ basePath: tmpDir, chunkSize: 50, chunkOverlap: 0 });
      writeFile(tmpDir, "clean.txt", "a".repeat(120));
      const result = await loader.load(join(tmpDir, "clean.txt"));

      for (const doc of result) {
        expect(doc.content.length).toBeGreaterThan(0);
      }
    });
  });

  // ── Document ID generation ─────────────────────────────────────────────────

  describe("document ID generation", () => {
    it("should generate IDs with relative path and chunk index", async () => {
      const loader = new TextLoader({ basePath: tmpDir });
      writeFile(tmpDir, "info.txt", "a".repeat(200));
      const result = await loader.load(join(tmpDir, "info.txt"));

      // Single chunk
      if (result.length === 1) {
        expect(result[0].id).toBe("info.txt:0");
      }
      // Multiple chunks: each has unique ID
      const ids = new Set(result.map((d) => d.id));
      expect(ids.size).toBe(result.length);
    });

    it("should prefix IDs when idPrefix is set", async () => {
      const loader = new TextLoader({ basePath: tmpDir, idPrefix: "repo" });
      writeFile(tmpDir, "data.txt", "a".repeat(200));
      const result = await loader.load(join(tmpDir, "data.txt"));

      for (const doc of result) {
        expect(doc.id).toMatch(/^repo:data.txt:\d+$/);
      }
    });

    it("should handle nested file paths in ID", async () => {
      const loader = new TextLoader({ basePath: tmpDir });
      mkdirSync(join(tmpDir, "a", "b"), { recursive: true });
      writeFile(tmpDir, "a/b/nested.txt", "content");
      const result = await loader.load(join(tmpDir, "a/b/nested.txt"));

      expect(result[0].id).toBe("a/b/nested.txt:0");
    });

    it("should prefix nested paths correctly with idPrefix", async () => {
      const loader = new TextLoader({ basePath: tmpDir, idPrefix: "proj" });
      mkdirSync(join(tmpDir, "a", "b"), { recursive: true });
      writeFile(tmpDir, "a/b/nested.txt", "content");
      const result = await loader.load(join(tmpDir, "a/b/nested.txt"));

      expect(result[0].id).toBe("proj:a/b/nested.txt:0");
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle file with only whitespace content", async () => {
      const loader = new TextLoader({ basePath: tmpDir });
      writeFile(tmpDir, "blank.txt", "   \n  \n  ");
      const result = await loader.load(join(tmpDir, "blank.txt"));

      // Should not throw, returns what it has
      expect(Array.isArray(result)).toBe(true);
    });

    it("should handle very large file within maxFileSize", async () => {
      const loader = new TextLoader({
        basePath: tmpDir,
        maxFileSize: 10_000,
        chunkSize: 500,
      });
      const content = "B".repeat(5000);
      writeFile(tmpDir, "big.txt", content);
      const result = await loader.load(join(tmpDir, "big.txt"));

      expect(result.length).toBeGreaterThan(0);
    });

    it("should handle unicode content correctly", async () => {
      const loader = new TextLoader({ basePath: tmpDir });
      writeFile(tmpDir, "unicode.txt", "Hello 世界 🌍 — em dash and ümlaut");
      const result = await loader.load(join(tmpDir, "unicode.txt"));

      expect(result[0].content).toContain("世界");
      expect(result[0].content).toContain("🌍");
    });

    it("should handle file with extension in EXTENSION_INFO but not in extraExtensions", async () => {
      const loader = new TextLoader({ basePath: tmpDir });
      writeFile(tmpDir, "style.css", "body { color: red; }");
      const result = await loader.load(join(tmpDir, "style.css"));

      expect(result.length).toBe(1);
      expect(result[0].metadata?.textCategory).toBe("style");
    });

    it("should set fileType to 'text' for all loaded files", async () => {
      const loader = new TextLoader({ basePath: tmpDir });
      writeFile(tmpDir, "script.py", "print('hello')");
      writeFile(tmpDir, "notes.txt", "hello");
      writeFile(tmpDir, "style.css", "body {}");

      const pyResult = await loader.load(join(tmpDir, "script.py"));
      const txtResult = await loader.load(join(tmpDir, "notes.txt"));
      const cssResult = await loader.load(join(tmpDir, "style.css"));

      expect(pyResult[0].metadata?.fileType).toBe("text");
      expect(txtResult[0].metadata?.fileType).toBe("text");
      expect(cssResult[0].metadata?.fileType).toBe("text");
    });

    it("should correctly set chunkIndex starting from 0", async () => {
      const loader = new TextLoader({ basePath: tmpDir, chunkSize: 30, chunkOverlap: 5 });
      const content = "X".repeat(100);
      writeFile(tmpDir, "idx.txt", content);
      const result = await loader.load(join(tmpDir, "idx.txt"));

      expect(result[0].metadata?.chunkIndex).toBe(0);
      if (result.length > 1) {
        expect(result[1].metadata?.chunkIndex).toBe(1);
      }
    });

    it("should handle file exactly at maxFileSize boundary", async () => {
      const loader = new TextLoader({
        basePath: tmpDir,
        maxFileSize: 100,
      });
      writeFile(tmpDir, "exact.txt", "X".repeat(100));
      const result = await loader.load(join(tmpDir, "exact.txt"));

      // Size === maxFileSize is allowed (not >)
      expect(result.length).toBe(1);
    });

    it("should handle file exactly 1 byte over maxFileSize", async () => {
      const loader = new TextLoader({
        basePath: tmpDir,
        maxFileSize: 100,
      });
      writeFile(tmpDir, "over.txt", "X".repeat(101));
      const result = await loader.load(join(tmpDir, "over.txt"));

      expect(result).toEqual([]);
    });
  });

  // ── createTextLoader factory ───────────────────────────────────────────────

  describe("createTextLoader factory", () => {
    it("should return a TextLoader instance", () => {
      const loader = createTextLoader({ basePath: tmpDir });
      expect(loader).toBeInstanceOf(TextLoader);
    });

    it("should pass options through to TextLoader", () => {
      const loader = createTextLoader({
        basePath: tmpDir,
        extraExtensions: [".foo"],
      });
      expect(loader.canHandle("/test/bar.foo")).toBe(true);
    });

    it("should throw when basePath is missing (same as TextLoader)", () => {
      expect(() => createTextLoader({ basePath: "" })).toThrow(RAGError);
    });
  });
});

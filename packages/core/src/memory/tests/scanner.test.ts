/**
 * Comprehensive unit tests for the memory scanner (scanMemoryDir).
 *
 * Covers: parseFrontmatter, isValidMemoryType, readFrontmatterChunk,
 * and scanMemoryDir — all branches and edge cases.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";

// ── Mock fs/promises ─────────────────────────────────────────────────────────

vi.mock("fs/promises", () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}));

import * as fsPromises from "fs/promises";
import { scanMemoryDir } from "../scanner.js";

const mockReaddir = vi.mocked(fsPromises.readdir);
const mockReadFile = vi.mocked(fsPromises.readFile);
const mockStat = vi.mocked(fsPromises.stat);

// ── Constants ────────────────────────────────────────────────────────────────

const MEMORY_DIR = "/fake/memory";

// ── Helpers ──────────────────────────────────────────────────────────────────

type FileDef = {
  /** Relative path from memoryDir (supports subdirectories). */
  name: string;
  content: string;
  mtimeMs: number;
};

/** Register a set of files that the mock fs will serve for a single test case. */
function setupFiles(files: FileDef[]) {
  mockReaddir.mockResolvedValue(files.map((f) => f.name));

  const fileMap = new Map(files.map((f) => [join(MEMORY_DIR, f.name), f]));

  mockReadFile.mockImplementation(async (p: string) => {
    const file = fileMap.get(p);
    if (file) return file.content;
    throw new Error(`ENOENT: no mock for ${p}`);
  });

  mockStat.mockImplementation(async (p: string) => {
    const file = fileMap.get(p);
    if (file) return { mtimeMs: file.mtimeMs };
    throw new Error(`ENOENT: no mock for ${p}`);
  });
}

/** Create a FileDef with YAML-ish frontmatter. */
function frontmatterFile(
  name: string,
  fields: Record<string, string>,
  mtimeMs: number,
  body = "\nBody content.",
): FileDef {
  const fieldLines = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const content = `---\n${fieldLines}\n---\n${body}`;
  return { name, content, mtimeMs };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("scanMemoryDir", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Error handling ──────────────────────────────────────────────────────

  it("returns empty array when readdir throws (e.g., missing directory)", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT: no such directory"));

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toEqual([]);
  });

  it("returns empty array when directory has no entries", async () => {
    mockReaddir.mockResolvedValue([]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toEqual([]);
  });

  // ── File filtering ──────────────────────────────────────────────────────

  it("filters out non-.md files", async () => {
    setupFiles([
      { name: "notes.txt", content: "hello", mtimeMs: 100 },
      { name: "config.json", content: "{}", mtimeMs: 200 },
      { name: "image.png", content: "png", mtimeMs: 300 },
    ]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toEqual([]);
  });

  it("filters out MEMORY.md index file", async () => {
    setupFiles([
      {
        name: "MEMORY.md",
        content: "---\ntype: user\n---\nindex body",
        mtimeMs: 100,
      },
    ]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toEqual([]);
  });

  it("keeps .md files but excludes MEMORY.md in the same listing", async () => {
    setupFiles([
      {
        name: "MEMORY.md",
        content: "---\ntype: user\n---\nindex",
        mtimeMs: 100,
      },
      {
        name: "real.md",
        content: "---\ntype: project\n---\nbody",
        mtimeMs: 200,
      },
    ]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toHaveLength(1);
    expect(result[0]!.filename).toBe("real.md");
    expect(result[0]!.type).toBe("project");
  });

  // ── Frontmatter parsing (parseFrontmatter via scanMemoryDir) ────────────

  it("parses type and description from valid frontmatter", async () => {
    setupFiles([
      frontmatterFile(
        "m1.md",
        { type: "user", description: "Test memory" },
        100,
      ),
    ]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("user");
    expect(result[0]!.description).toBe("Test memory");
  });

  it("returns undefined type when type field is absent from frontmatter", async () => {
    setupFiles([
      frontmatterFile("m1.md", { description: "No type here" }, 100),
    ]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result[0]!.type).toBeUndefined();
    expect(result[0]!.description).toBe("No type here");
  });

  it("returns null description when description field is absent", async () => {
    setupFiles([frontmatterFile("m1.md", { type: "project" }, 100)]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result[0]!.description).toBeNull();
  });

  it("handles file with no frontmatter delimiters at all", async () => {
    setupFiles([
      {
        name: "plain.md",
        content: "Just some markdown content.\nNo frontmatter here.\n",
        mtimeMs: 100,
      },
    ]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBeUndefined();
    expect(result[0]!.description).toBeNull();
  });

  it("handles file with opening --- but no closing ---", async () => {
    setupFiles([
      {
        name: "unclosed.md",
        content: "---\ntype: user\ndescription: test\nBody starts here",
        mtimeMs: 100,
      },
    ]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toHaveLength(1);
    // No closing --- so frontmatter is not parsed
    expect(result[0]!.type).toBeUndefined();
    expect(result[0]!.description).toBeNull();
  });

  it("handles empty frontmatter (only --- delimiters with nothing between)", async () => {
    setupFiles([
      {
        name: "empty.md",
        content: "---\n---\nBody after empty frontmatter.\n",
        mtimeMs: 100,
      },
    ]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBeUndefined();
    expect(result[0]!.description).toBeNull();
  });

  it("skips frontmatter lines that contain no colon", async () => {
    setupFiles([
      {
        name: "no-colon.md",
        content:
          "---\ntype: user\nthis line has no colon\n---\nbody",
        mtimeMs: 100,
      },
    ]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("user");
  });

  it("skips frontmatter lines where the key is empty (colon at position 0)", async () => {
    setupFiles([
      {
        name: "empty-key.md",
        content:
          '---\ntype: user\n: value without key\ndescription: still works\n---\nbody',
        mtimeMs: 100,
      },
    ]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("user");
    expect(result[0]!.description).toBe("still works");
  });

  it("handles frontmatter with key that has no value (empty string after colon)", async () => {
    setupFiles([
      {
        name: "empty-value.md",
        content: "---\ntype: user\ndescription:\n---\nbody",
        mtimeMs: 100,
      },
    ]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("user");
    // "" is falsy, so `fields["description"] || null` yields null
    expect(result[0]!.description).toBeNull();
  });

  it("handles frontmatter with whitespace around key and value", async () => {
    setupFiles([
      {
        name: "whitespace.md",
        content:
          "---\n  type  :  user  \n  description  :  padded value  \n---\nbody",
        mtimeMs: 100,
      },
    ]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("user");
    expect(result[0]!.description).toBe("padded value");
  });

  it("treats --- with surrounding whitespace as delimiter", async () => {
    setupFiles([
      {
        name: "ws-delim.md",
        content: "  ---  \ntype: user\n  ---  \nbody",
        mtimeMs: 100,
      },
    ]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("user");
  });

  it("handles multiple colons on the same line (splits on first colon only)", async () => {
    setupFiles([
      {
        name: "multi-colon.md",
        content: '---\ntype: user\ndescription: check: this: value\n---\nbody',
        mtimeMs: 100,
      },
    ]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toHaveLength(1);
    expect(result[0]!.description).toBe("check: this: value");
  });

  // ── isValidMemoryType coverage ──────────────────────────────────────────

  it("accepts 'user' as a valid memory type", async () => {
    setupFiles([frontmatterFile("m.md", { type: "user" }, 100)]);
    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result[0]!.type).toBe("user");
  });

  it("accepts 'project' as a valid memory type", async () => {
    setupFiles([frontmatterFile("m.md", { type: "project" }, 100)]);
    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result[0]!.type).toBe("project");
  });

  it("accepts 'feedback' as a valid memory type", async () => {
    setupFiles([frontmatterFile("m.md", { type: "feedback" }, 100)]);
    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result[0]!.type).toBe("feedback");
  });

  it("accepts 'reference' as a valid memory type", async () => {
    setupFiles([frontmatterFile("m.md", { type: "reference" }, 100)]);
    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result[0]!.type).toBe("reference");
  });

  it("treats type case-insensitively — uppercase", async () => {
    setupFiles([frontmatterFile("m.md", { type: "USER" }, 100)]);
    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result[0]!.type).toBe("user");
  });

  it("treats type case-insensitively — mixed case", async () => {
    setupFiles([frontmatterFile("m.md", { type: "Project" }, 100)]);
    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result[0]!.type).toBe("project");
  });

  it("returns undefined for an invalid type value", async () => {
    setupFiles([frontmatterFile("m.md", { type: "nonexistent" }, 100)]);
    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result[0]!.type).toBeUndefined();
  });

  it("returns undefined when type is an empty string (falsy)", async () => {
    setupFiles([
      {
        name: "empty-type.md",
        content: "---\ntype:\ndescription: test\n---\nbody",
        mtimeMs: 100,
      },
    ]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result[0]!.type).toBeUndefined();
  });

  // ── File reading (readFrontmatterChunk) ────────────────────────────────

  it("skips a file when readFile throws and continues with the next file", async () => {
    mockReaddir.mockResolvedValue(["bad.md", "good.md"]);

    mockReadFile.mockImplementation(async (p: string) => {
      if (p === join(MEMORY_DIR, "bad.md"))
        throw new Error("EPERM: permission denied");
      if (p === join(MEMORY_DIR, "good.md"))
        return "---\ntype: user\n---\nbody";
      throw new Error(`unexpected: ${p}`);
    });

    mockStat.mockImplementation(async (p: string) => {
      if (p === join(MEMORY_DIR, "bad.md"))
        throw new Error("EPERM");
      if (p === join(MEMORY_DIR, "good.md")) return { mtimeMs: 200 };
      throw new Error(`unexpected: ${p}`);
    });

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toHaveLength(1);
    expect(result[0]!.filename).toBe("good.md");
  });

  it("skips a file when stat throws (Promise.all rejects)", async () => {
    mockReaddir.mockResolvedValue(["exists.md"]);

    mockReadFile.mockResolvedValue("---\ntype: user\n---\nbody");
    mockStat.mockRejectedValue(new Error("EBUSY"));

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toEqual([]);
  });

  // ── Content truncation to FRONTMATTER_READ_LINES (30) ──────────────────

  it("reads frontmatter that fits within the first 30 lines", async () => {
    // 5 frontmatter lines + 35 body lines = 40 total; frontmatter within 30
    const bodyLines = Array.from(
      { length: 35 },
      (_, i) => `Body line ${i + 1}`,
    ).join("\n");
    const content = `---\ntype: user\ndescription: long file\n---\n${bodyLines}`;

    setupFiles([{ name: "long.md", content, mtimeMs: 100 }]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("user");
    expect(result[0]!.description).toBe("long file");
  });

  it("ignores frontmatter that starts after line 30 (truncation)", async () => {
    // 30 non-frontmatter lines, then frontmatter starts at line 31
    const prefix = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join(
      "\n",
    );
    const content = `${prefix}\n---\ntype: user\ndescription: hidden\n---\nbody`;

    setupFiles([{ name: "late.md", content, mtimeMs: 100 }]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toHaveLength(1);
    // frontmatter started after line 30, so it was never seen
    expect(result[0]!.type).toBeUndefined();
    expect(result[0]!.description).toBeNull();
  });

  it("handles file with exactly 30 lines where frontmatter closes at the boundary", async () => {
    // Frontmatter must start at line 1. 28 body lines + opening --- + closing --- = 30
    const bodyLines = Array.from(
      { length: 27 },
      (_, i) => `Body line ${i + 1}`,
    ).join("\n");
    const content = `---\ntype: reference\n${bodyLines}\n---`;

    setupFiles([{ name: "exact.md", content, mtimeMs: 100 }]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("reference");
  });

  // ── Path handling ──────────────────────────────────────────────────────

  it("sets path as absolute and filename as relative to memoryDir", async () => {
    setupFiles([frontmatterFile("sub/dir/m1.md", { type: "user" }, 100)]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result[0]!.path).toBe(join(MEMORY_DIR, "sub/dir/m1.md"));
    expect(result[0]!.filename).toBe("sub/dir/m1.md");
  });

  it("handles nested subdirectories from recursive readdir", async () => {
    setupFiles([
      frontmatterFile("a/b/c/deep.md", { type: "user" }, 100),
      frontmatterFile("shallow.md", { type: "project" }, 200),
    ]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toHaveLength(2);
    const filenames = result.map((r) => r.filename);
    expect(filenames).toContain("a/b/c/deep.md");
    expect(filenames).toContain("shallow.md");
  });

  // ── Sorting by mtimeMs ─────────────────────────────────────────────────

  it("sorts results by mtimeMs descending (newest first)", async () => {
    setupFiles([
      frontmatterFile("old.md", { type: "user" }, 100),
      frontmatterFile("new.md", { type: "project" }, 300),
      frontmatterFile("mid.md", { type: "feedback" }, 200),
    ]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toHaveLength(3);
    expect(result[0]!.filename).toBe("new.md");
    expect(result[1]!.filename).toBe("mid.md");
    expect(result[2]!.filename).toBe("old.md");
  });

  it("sort is stable for files with equal mtimeMs", async () => {
    setupFiles([
      frontmatterFile("a.md", { type: "user" }, 100),
      frontmatterFile("b.md", { type: "project" }, 100),
      frontmatterFile("c.md", { type: "feedback" }, 100),
    ]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result).toHaveLength(3);
    // All have same mtimeMs; V8 sort is stable so insertion order preserved
    // (they all compare equal, so original relative order is kept)
  });

  // ── File cap at MAX_SCAN_FILES (200) ───────────────────────────────────

  it("caps results at MAX_SCAN_FILES (200)", async () => {
    const files: FileDef[] = Array.from({ length: 201 }, (_, i) =>
      frontmatterFile(`file-${i}.md`, { type: "user" }, i),
    );

    setupFiles(files);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result.length).toBe(200);
  });

  it("does not cap when total .md files are fewer than 200", async () => {
    const files: FileDef[] = Array.from({ length: 50 }, (_, i) =>
      frontmatterFile(`file-${i}.md`, { type: "user" }, i),
    );

    setupFiles(files);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result.length).toBe(50);
  });

  it("caps BEFORE filtering, so non-.md files do not consume the cap", async () => {
    // 250 entries: 50 non-.md + 200 .md → cap at 200 .md files, leaving all 200
    mockReaddir.mockResolvedValue([
      ...Array.from({ length: 50 }, (_, i) => `extra-${i}.txt`),
      ...Array.from({ length: 200 }, (_, i) => `mem-${i}.md`),
    ]);

    mockReadFile.mockImplementation(async () => "---\ntype: user\n---\nbody");
    mockStat.mockImplementation(async () => ({ mtimeMs: 100 }));

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result.length).toBe(200);
  });

  it("filters MEMORY.md before capping, so MEMORY.md does NOT waste a slot", async () => {
    // 201 .md files where the first is MEMORY.md → filter removes it before slice
    mockReaddir.mockResolvedValue([
      "MEMORY.md",
      ...Array.from({ length: 200 }, (_, i) => `mem-${i}.md`),
    ]);

    mockReadFile.mockImplementation(async (p: string) => {
      if (p.endsWith("MEMORY.md")) return "---\ntype: user\n---\nindex";
      return "---\ntype: user\n---\nbody";
    });
    mockStat.mockImplementation(async () => ({ mtimeMs: 100 }));

    const result = await scanMemoryDir(MEMORY_DIR);
    // filter removes MEMORY.md first, then slice caps at 200 → all 200 regular files
    expect(result.length).toBe(200);
  });

  // ── Integration: mixed valid/invalid files ─────────────────────────────

  it("correctly processes a mix of valid, invalid, nested, and filtered files", async () => {
    mockReaddir.mockResolvedValue([
      "valid.md",
      "no-frontmatter.md",
      "MEMORY.md",
      "sub/nested.md",
      "bad-type.md",
    ]);

    mockReadFile.mockImplementation(async (p: string) => {
      switch (p) {
        case join(MEMORY_DIR, "valid.md"):
          return "---\ntype: user\ndescription: A valid memory\n---\nBody";
        case join(MEMORY_DIR, "no-frontmatter.md"):
          return "# No frontmatter\nJust some markdown.";
        case join(MEMORY_DIR, "MEMORY.md"):
          return "---\ntype: system\n---\nindex";
        case join(MEMORY_DIR, "sub/nested.md"):
          return "---\ntype: PROJECT\ndescription: Nested file\n---\nBody";
        case join(MEMORY_DIR, "bad-type.md"):
          return "---\ntype: unknown_type\ndescription: Bad type\n---\nBody";
        default:
          throw new Error(`unexpected: ${p}`);
      }
    });

    mockStat.mockImplementation(async (p: string) => {
      const map: Record<string, number> = {
        [join(MEMORY_DIR, "valid.md")]: 500,
        [join(MEMORY_DIR, "no-frontmatter.md")]: 400,
        [join(MEMORY_DIR, "MEMORY.md")]: 300,
        [join(MEMORY_DIR, "sub/nested.md")]: 200,
        [join(MEMORY_DIR, "bad-type.md")]: 100,
      };
      if (p in map) return { mtimeMs: map[p]! };
      throw new Error(`unexpected: ${p}`);
    });

    const result = await scanMemoryDir(MEMORY_DIR);

    // MEMORY.md filtered out, leaving 4 files
    expect(result).toHaveLength(4);

    // Sorted by mtimeMs descending
    expect(result[0]!.filename).toBe("valid.md");
    expect(result[0]!.type).toBe("user");
    expect(result[0]!.description).toBe("A valid memory");

    expect(result[1]!.filename).toBe("no-frontmatter.md");
    expect(result[1]!.type).toBeUndefined();
    expect(result[1]!.description).toBeNull();

    expect(result[2]!.filename).toBe("sub/nested.md");
    expect(result[2]!.type).toBe("project"); // case-insensitive
    expect(result[2]!.description).toBe("Nested file");

    expect(result[3]!.filename).toBe("bad-type.md");
    expect(result[3]!.type).toBeUndefined();
    expect(result[3]!.description).toBe("Bad type");
  });

  // ── mtimeMs propagation ────────────────────────────────────────────────

  it("propagates the mtimeMs from stat into the result", async () => {
    setupFiles([frontmatterFile("m.md", { type: "user" }, 42)]);

    const result = await scanMemoryDir(MEMORY_DIR);
    expect(result[0]!.mtimeMs).toBe(42);
  });

  it("passes readdir the recursive flag", async () => {
    mockReaddir.mockResolvedValue([]);

    await scanMemoryDir(MEMORY_DIR);
    expect(mockReaddir).toHaveBeenCalledWith(MEMORY_DIR, { recursive: true });
  });
});

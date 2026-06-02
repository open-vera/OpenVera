/**
 * Tests for grep tool (grep.ts)
 *
 * Verifies: tool registration, invalid regex, no matches, single/multi-file
 * matches, case-insensitive, context lines, glob filtering, binary skip,
 * error handling (ENOENT, stat errors, read errors), truncation at MAX_MATCHES,
 * custom path, and default cwd search.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { ToolContext } from "../types.js";

vi.mock("node:fs", () => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock("../utils/binary.js", () => ({
  isBinaryPath: vi.fn(),
}));

const mockCtx: ToolContext = {
  cwd: "/tmp/test-project",
  sessionId: "test-session",
};

beforeEach(async () => {
  vi.clearAllMocks();
  const { isBinaryPath } = await import("../utils/binary.js");
  vi.mocked(isBinaryPath).mockReturnValue(false);
});

async function loadTool() {
  const mod = await import("../grep.js");
  return mod.grepTool;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Make statSync report the given path as a regular file. */
function statIsFile(path: string) {
  vi.mocked(statSync).mockImplementation((p: unknown) => {
    if (String(p) === path) {
      return { isFile: () => true, isDirectory: () => false } as ReturnType<typeof statSync>;
    }
    throw Object.assign(new Error(`ENOENT: ${String(p)}`), { code: "ENOENT" });
  });
}

/** Make statSync report the given path as a directory with the listed entries. */
function statIsDir(
  dirPath: string,
  entries: Array<{ name: string; isDir: boolean; content?: string }>,
) {
  vi.mocked(statSync).mockImplementation((p: unknown) => {
    const path = String(p);
    if (path === dirPath) {
      return { isFile: () => false, isDirectory: () => true } as ReturnType<typeof statSync>;
    }
    for (const e of entries) {
      if (path === `${dirPath}/${e.name}`) {
        return {
          isFile: () => !e.isDir,
          isDirectory: () => e.isDir,
        } as ReturnType<typeof statSync>;
      }
    }
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  });

  vi.mocked(readdirSync).mockImplementation((p: unknown) => {
    if (String(p) === dirPath) return entries.map((e) => e.name) as ReturnType<typeof readdirSync>;
    return [] as ReturnType<typeof readdirSync>;
  });

  vi.mocked(readFileSync).mockImplementation((p: unknown, _enc?: unknown) => {
    const path = String(p);
    for (const e of entries) {
      if (`${dirPath}/${e.name}` === path && !e.isDir) {
        return e.content as ReturnType<typeof readFileSync>;
      }
    }
    throw new Error(`ENOENT: ${path}`);
  });
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("grep", () => {
  // 1. tool registration
  it("has correct metadata", async () => {
    const tool = await loadTool();

    expect(tool.name).toBe("grep");
    expect(tool.description).toContain("regex");
    expect(tool.parameters).toHaveProperty("required", ["pattern"]);
    expect(tool.options?.idempotent).toBe(true);
    expect(tool.options?.riskLevel).toBe("low");
    expect(tool.options?.timeoutMs).toBe(30_000);
  });

  // 2. invalid regex
  it("returns error for invalid regex pattern", async () => {
    statIsFile("/tmp/test-project");
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "[invalid" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("Invalid regex");
  });

  // 3. no matches
  it("returns no matches message when pattern not found", async () => {
    statIsFile("/tmp/test-project");
    vi.mocked(readFileSync).mockReturnValue("line one\nline two\n" as any);
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "zzzNOTFOUNDzzz" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toBe("No matches for: zzzNOTFOUNDzzz");
  });

  // 4. single file match
  it("finds match in a specific file and returns file:line:content", async () => {
    vi.mocked(statSync).mockReturnValue({
      isFile: () => true,
      isDirectory: () => false,
    } as ReturnType<typeof statSync>);
    vi.mocked(readFileSync).mockReturnValue("const x = 1;\nconsole.log(x);\n" as any);
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "console", path: "app.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain('1 match(es) for "console"');
    expect(result.content).toContain("app.ts:2:  console.log(x);");
  });

  // 5. directory search — multiple matches across files
  it("searches recursively in a directory and finds matches across files", async () => {
    statIsDir("/tmp/test-project", [
      { name: "a.ts", isDir: false, content: "const x = 1;\n\nhello()\n" },
      { name: "b.ts", isDir: false, content: "const y = 2;\n\nhello()\n" },
    ]);
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "hello", path: "." }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("2 match(es)");
    expect(result.content).toContain("a.ts:3:  hello()");
    expect(result.content).toContain("b.ts:3:  hello()");
  });

  // 6. multiple matches in one file
  it("reports all matches within a single file", async () => {
    vi.mocked(statSync).mockReturnValue({
      isFile: () => true,
      isDirectory: () => false,
    } as ReturnType<typeof statSync>);
    vi.mocked(readFileSync).mockReturnValue("TODO: fix bug\nregular line\nTODO: add test\nTODO: docs\n" as any);
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "TODO", path: "tasks.md" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("3 match(es)");
    expect(result.content).toContain("tasks.md:1:  TODO: fix bug");
    expect(result.content).toContain("tasks.md:3:  TODO: add test");
    expect(result.content).toContain("tasks.md:4:  TODO: docs");
  });

  // 7. case-insensitive search
  it("performs case-insensitive search when flag is set", async () => {
    vi.mocked(statSync).mockReturnValue({
      isFile: () => true,
      isDirectory: () => false,
    } as ReturnType<typeof statSync>);
    vi.mocked(readFileSync).mockReturnValue("function Hello() {}\nconsole.log(HELLO);\nhello world\n" as any);
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "hello", path: "src.ts", case_insensitive: true }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("3 match(es)");
    expect(result.content).toContain("Hello()");
    expect(result.content).toContain("HELLO");
    expect(result.content).toContain("hello world");
  });

  // 7b. case-sensitive by default
  it("respects case by default (no case_insensitive flag)", async () => {
    vi.mocked(statSync).mockReturnValue({
      isFile: () => true,
      isDirectory: () => false,
    } as ReturnType<typeof statSync>);
    vi.mocked(readFileSync).mockReturnValue("hello\nHELLO\nHello\n" as any);
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "hello", path: "src.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    // Only lowercase "hello" matches
    expect(result.content).toContain("1 match(es)");
    expect(result.content).toContain("src.ts:1:  hello");
    expect(result.content).not.toContain("HELLO");
    expect(result.content).not.toContain("Hello");
  });

  // 8. context lines
  it("includes context lines before and after each match", async () => {
    vi.mocked(statSync).mockReturnValue({
      isFile: () => true,
      isDirectory: () => false,
    } as ReturnType<typeof statSync>);
    const content = "line one\nline two\nMATCH HERE\nline four\nline five\n";
    vi.mocked(readFileSync).mockReturnValue(content as any);
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "MATCH", path: "demo.txt", context: 2 }, mockCtx);

    expect(result.ok).toBe(true);
    // Context lines use "lineNum-" suffix and match lines use "lineNum:"
    expect(result.content).toContain("demo.txt:1-  line one");
    expect(result.content).toContain("demo.txt:2-  line two");
    expect(result.content).toContain("demo.txt:3:  MATCH HERE");
    expect(result.content).toContain("demo.txt:4-  line four");
    expect(result.content).toContain("demo.txt:5-  line five");
    // Separator between match groups
    expect(result.content).toContain("---");
  });

  // 8b. context with value 0 — no context lines
  it("omits context lines when context is 0", async () => {
    vi.mocked(statSync).mockReturnValue({
      isFile: () => true,
      isDirectory: () => false,
    } as ReturnType<typeof statSync>);
    vi.mocked(readFileSync).mockReturnValue("line one\nMATCH\nline three\n" as any);
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "MATCH", path: "demo.txt", context: 0 }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).not.toContain("-  ");
    expect(result.content).not.toContain("---");
  });

  // 9. glob filtering
  it("filters files by glob pattern", async () => {
    statIsDir("/tmp/test-project", [
      { name: "app.ts", isDir: false, content: "const x: number = 1;\n\nhello()\n" },
      { name: "readme.md", isDir: false, content: "# Title\n\nhello world\n" },
      { name: "utils.js", isDir: false, content: "function hello() {}\n" },
    ]);
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "hello", path: ".", glob: "*.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    // Only app.ts should appear, not readme.md or utils.js
    expect(result.content).toContain("1 match(es)");
    expect(result.content).toContain("app.ts");
    expect(result.content).not.toContain(".md");
    expect(result.content).not.toContain(".js");
  });

  // 10. binary files skipped
  it("skips files detected as binary", async () => {
    statIsDir("/tmp/test-project", [
      { name: "photo.png", isDir: false, content: "binary\x00data" },
      { name: "code.ts", isDir: false, content: "const x = 1;\n" },
    ]);
    const { isBinaryPath } = await import("../utils/binary.js");
    // Return true only for png files
    vi.mocked(isBinaryPath).mockImplementation((p: unknown) => String(p).endsWith(".png"));
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "const", path: "." }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("1 match(es)");
    expect(result.content).toContain("code.ts");
    expect(result.content).not.toContain("photo.png");
  });

  // 11. file not found (ENOENT) for specific path
  it("returns NOT_FOUND error when the path does not exist", async () => {
    vi.mocked(statSync).mockImplementation(() => {
      const err = new Error("ENOENT: no such file or directory, stat '/tmp/test-project/missing'");
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    });
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "test", path: "missing" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
    expect(result.content).toContain("Not found");
  });

  // 12. other stat errors
  it("returns UNKNOWN error for non-ENOENT stat failures", async () => {
    vi.mocked(statSync).mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "test", path: "secret" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("EACCES");
  });

  // 13. file read error — skip that file, continue with others
  it("skips a file that fails to read and continues with remaining files", async () => {
    statIsDir("/tmp/test-project", [
      { name: "good.ts", isDir: false, content: "const x = 1;\nhello()\n" },
      { name: "bad.ts", isDir: false, content: "SHOULD NOT BE READ" },
    ]);
    // Override readFileSync to throw for bad.ts
    vi.mocked(readFileSync).mockImplementation((p: unknown, _enc?: unknown) => {
      const path = String(p);
      if (path === "/tmp/test-project/good.ts") return "const x = 1;\nhello()\n" as any;
      throw new Error("EIO: i/o error"); // bad.ts throws
    });
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "hello", path: "." }, mockCtx);

    // Should still find the match in good.ts even though bad.ts errored
    expect(result.ok).toBe(true);
    expect(result.content).toContain("1 match(es)");
    expect(result.content).toContain("good.ts");
  });

  // 14. truncation at MAX_MATCHES (200)
  it("truncates output when matches exceed MAX_MATCHES", async () => {
    vi.mocked(statSync).mockReturnValue({
      isFile: () => true,
      isDirectory: () => false,
    } as ReturnType<typeof statSync>);
    // 210 lines each containing "match" → all match the pattern
    const lines = Array.from({ length: 210 }, (_, i) => `match line ${i}`);
    vi.mocked(readFileSync).mockReturnValue(lines.join("\n") as any);
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "match", path: "big.txt" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("200 match(es)"); // capped at MAX_MATCHES
    expect(result.content).toContain("narrow your search");
    // Should NOT contain all 210 matches
    expect(result.content).not.toContain("line 209");
  });

  // 15. custom search path via `path` arg
  it("uses the path argument as the search root", async () => {
    statIsDir("/tmp/test-project/subdir", [
      { name: "nested.ts", isDir: false, content: "function greet() {}\n" },
    ]);
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "greet", path: "subdir" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("1 match(es)");
    expect(result.content).toContain("subdir/nested.ts");
  });

  // 16. default cwd search when no path arg
  it("searches in cwd when no path argument is provided", async () => {
    statIsDir("/tmp/test-project", [
      { name: "index.ts", isDir: false, content: "export default {};\n\nexport function main() {}\n" },
    ]);
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "main" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("1 match(es)");
    expect(result.content).toContain("index.ts");
  });

  // edge: match at very beginning of file (line 1)
  it("handles match on the first line", async () => {
    vi.mocked(statSync).mockReturnValue({
      isFile: () => true,
      isDirectory: () => false,
    } as ReturnType<typeof statSync>);
    vi.mocked(readFileSync).mockReturnValue("#!/usr/bin/env node\n\nconsole.log('hi');\n" as any);
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "usr/bin", path: "cli.js" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("cli.js:1:  #!/usr/bin/env node");
  });

  // edge: match on the last line
  it("handles match on the last line", async () => {
    vi.mocked(statSync).mockReturnValue({
      isFile: () => true,
      isDirectory: () => false,
    } as ReturnType<typeof statSync>);
    vi.mocked(readFileSync).mockReturnValue("line one\nline two\nFINAL\n" as any);
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "FINAL", path: "data.txt" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("data.txt:3:  FINAL");
  });

  // edge: context lines at boundary — no before lines on line 1
  it("context on first line only shows after lines", async () => {
    vi.mocked(statSync).mockReturnValue({
      isFile: () => true,
      isDirectory: () => false,
    } as ReturnType<typeof statSync>);
    vi.mocked(readFileSync).mockReturnValue("MATCH\nline two\nline three\nline four\n" as any);
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "MATCH", path: "data.txt", context: 2 }, mockCtx);

    expect(result.ok).toBe(true);
    // Should NOT have before lines (lineNum 0- or negative)
    expect(result.content).not.toContain("data.txt:0-");
    expect(result.content).not.toContain("data.txt:-");
    // Match line
    expect(result.content).toContain("data.txt:1:  MATCH");
    // After lines
    expect(result.content).toContain("data.txt:2-  line two");
    expect(result.content).toContain("data.txt:3-  line three");
  });

  // edge: context lines at boundary — no after lines on last line
  it("context on last line only shows before lines", async () => {
    vi.mocked(statSync).mockReturnValue({
      isFile: () => true,
      isDirectory: () => false,
    } as ReturnType<typeof statSync>);
    // No trailing newline — avoids empty last element after split
    vi.mocked(readFileSync).mockReturnValue("line one\nline two\nMATCH" as any);
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "MATCH", path: "data.txt", context: 2 }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("data.txt:1-  line one");
    expect(result.content).toContain("data.txt:2-  line two");
    expect(result.content).toContain("data.txt:3:  MATCH");
    // After should stop, no line 4/5
    expect(result.content).not.toContain("data.txt:4-");
    expect(result.content).not.toContain("data.txt:5-");
  });

  // edge: empty file
  it("handles empty files gracefully", async () => {
    vi.mocked(statSync).mockReturnValue({
      isFile: () => true,
      isDirectory: () => false,
    } as ReturnType<typeof statSync>);
    vi.mocked(readFileSync).mockReturnValue("" as any);
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "anything", path: "empty.txt" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toBe("No matches for: anything");
  });

  // edge: skips node_modules and other standard skip dirs
  it("skips node_modules and other standard skip directories", async () => {
    statIsDir("/tmp/test-project", [
      { name: "src", isDir: false, content: "hello()\n" },
      { name: "node_modules", isDir: true },
      { name: ".git", isDir: true },
    ]);
    const tool = await loadTool();

    const result = await tool.execute({ pattern: "hello", path: "." }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("1 match(es)");
  });
});

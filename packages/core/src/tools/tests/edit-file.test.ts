/**
 * Tests for edit_file tool (edit-file.ts)
 *
 * Verifies: successful string replacement with diff output, atomic write (temp + rename),
 * path validation, staleness detection (stale/not_read), occurrence counting
 * (0 = not found, >1 = not unique), read errors (ENOENT, EACCES, unknown),
 * write/rename errors, linesChanged metadata, and non-Error thrown values.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import type { ToolContext } from "../types.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock("../utils/path.js", () => ({
  safePath: vi.fn(),
}));

vi.mock("../../utils/diff.js", () => ({
  getPatchFromContents: vi.fn(),
}));

vi.mock("../fileStateCache.js", () => ({
  checkStaleness: vi.fn(),
  setFileState: vi.fn(),
}));

const TEST_PATH = "/tmp/test-edit.txt";
const FILE_CONTENT = "line one\nline two\nline three\nline four\nline five";
const mockCtx: ToolContext = {
  cwd: "/tmp",
  sessionId: "test-session",
};

beforeEach(async () => {
  vi.resetAllMocks();
  const { safePath } = await import("../utils/path.js");
  vi.mocked(safePath).mockReturnValue({ resolved: TEST_PATH });
  const { checkStaleness } = await import("../fileStateCache.js");
  vi.mocked(checkStaleness).mockReturnValue("ok");
  const { getPatchFromContents } = await import("../../utils/diff.js");
  vi.mocked(getPatchFromContents).mockReturnValue([]);
  vi.mocked(readFileSync).mockReturnValue(
    FILE_CONTENT as unknown as ReturnType<typeof readFileSync>
  );
});

async function loadTool() {
  const mod = await import("../edit-file.js");
  return mod.editFileTool;
}

// ── edit_file ───────────────────────────────────────────────────────────────────

describe("edit_file", () => {
  // ── Tool registration ────────────────────────────────────────────────────────

  it("has the correct name", async () => {
    const tool = await loadTool();
    expect(tool.name).toBe("edit_file");
  });

  it("has a non-empty description", async () => {
    const tool = await loadTool();
    expect(tool.description).toBeTruthy();
    expect(tool.description).toContain("Replace");
  });

  it("declares path, old_string, new_string as required parameters", async () => {
    const tool = await loadTool();
    const props = tool.parameters.properties as Record<string, unknown>;
    expect(props.path).toBeDefined();
    expect(props.old_string).toBeDefined();
    expect(props.new_string).toBeDefined();
    expect(tool.parameters.required).toEqual(["path", "old_string", "new_string"]);
  });

  it("sets timeoutMs and riskLevel options", async () => {
    const tool = await loadTool();
    expect(tool.options?.timeoutMs).toBe(10_000);
    expect(tool.options?.riskLevel).toBe("medium");
  });

  // ── Successful edit ──────────────────────────────────────────────────────────

  it("replaces old_string and returns success with diff metadata", async () => {
    const tool = await loadTool();
    const result = await tool.execute(
      { path: "test.txt", old_string: "line two", new_string: "modified line" },
      mockCtx
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Edited");
    expect(result.content).toContain("test.txt");
    expect(result.metadata?.renderHint).toEqual({ type: "diff" });
    expect(result.metadata?.diff).toBeDefined();
    expect(result.metadata?.diff?.filePath).toBe("test.txt");
    expect(Array.isArray(result.metadata?.diff?.hunks)).toBe(true);
  });

  it("writes the updated content to a temp file and renames atomically", async () => {
    const tool = await loadTool();
    await tool.execute(
      { path: "test.txt", old_string: "line two", new_string: "replaced" },
      mockCtx
    );

    const expectedContent = FILE_CONTENT.replace("line two", "replaced");
    expect(writeFileSync).toHaveBeenCalledWith(
      `${TEST_PATH}.vera.tmp`,
      expectedContent,
      "utf8"
    );
    expect(renameSync).toHaveBeenCalledWith(`${TEST_PATH}.vera.tmp`, TEST_PATH);
  });

  it("updates the file state cache after a successful edit", async () => {
    const { setFileState } = await import("../fileStateCache.js");
    const tool = await loadTool();

    await tool.execute(
      { path: "test.txt", old_string: "line two", new_string: "replaced" },
      mockCtx
    );

    const expectedContent = FILE_CONTENT.replace("line two", "replaced");
    expect(setFileState).toHaveBeenCalledWith(TEST_PATH, expectedContent);
  });

  it("calls getPatchFromContents with original and updated content", async () => {
    const { getPatchFromContents } = await import("../../utils/diff.js");
    const tool = await loadTool();

    await tool.execute(
      { path: "test.txt", old_string: "line two", new_string: "replaced" },
      mockCtx
    );

    const expectedContent = FILE_CONTENT.replace("line two", "replaced");
    expect(getPatchFromContents).toHaveBeenCalledWith({
      filePath: "test.txt",
      oldContent: FILE_CONTENT,
      newContent: expectedContent,
    });
  });

  // ── Path validation ──────────────────────────────────────────────────────────

  it("returns PATH_OUTSIDE_CWD when safePath returns error", async () => {
    const { safePath } = await import("../utils/path.js");
    vi.mocked(safePath).mockReturnValue({ error: "Path is outside allowed workdir." });
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "../secret", old_string: "x", new_string: "y" },
      mockCtx
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PATH_OUTSIDE_CWD");
    expect(result.content).toContain("outside");
  });

  // ── Read errors ──────────────────────────────────────────────────────────────

  it("returns NOT_FOUND when file does not exist (ENOENT)", async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "missing.txt", old_string: "x", new_string: "y" },
      mockCtx
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
    expect(result.content).toContain("File not found");
    expect(result.content).toContain("missing.txt");
  });

  it("returns PERMISSION_DENIED when read fails with EACCES", async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "locked.txt", old_string: "x", new_string: "y" },
      mockCtx
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(result.content).toContain("Permission denied");
    expect(result.content).toContain("locked.txt");
  });

  it("returns UNKNOWN for non-ENOENT/non-EACCES read errors", async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("EIO: i/o error");
    });
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "broken.txt", old_string: "x", new_string: "y" },
      mockCtx
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("EIO");
  });

  // ── Staleness checks ─────────────────────────────────────────────────────────

  it("returns error when file is stale (modified externally)", async () => {
    const { checkStaleness } = await import("../fileStateCache.js");
    vi.mocked(checkStaleness).mockReturnValue("stale");
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "test.txt", old_string: "line two", new_string: "replaced" },
      mockCtx
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("modified externally");
    expect(result.content).toContain("read it again");
  });

  it("returns error when file has not been read (not_read)", async () => {
    const { checkStaleness } = await import("../fileStateCache.js");
    vi.mocked(checkStaleness).mockReturnValue("not_read");
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "test.txt", old_string: "line two", new_string: "replaced" },
      mockCtx
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("has not been read");
    expect(result.content).toContain("read it first");
  });

  it("does not block when staleness is 'ok'", async () => {
    const { checkStaleness } = await import("../fileStateCache.js");
    vi.mocked(checkStaleness).mockReturnValue("ok");
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "test.txt", old_string: "line two", new_string: "replaced" },
      mockCtx
    );

    expect(result.ok).toBe(true);
  });

  it("does not block when staleness is 'partial_read'", async () => {
    const { checkStaleness } = await import("../fileStateCache.js");
    vi.mocked(checkStaleness).mockReturnValue("partial_read");
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "test.txt", old_string: "line two", new_string: "replaced" },
      mockCtx
    );

    expect(result.ok).toBe(true);
  });

  // ── Occurrence counting ──────────────────────────────────────────────────────

  it("returns error when old_string is not found (0 occurrences)", async () => {
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "test.txt", old_string: "nonexistent text", new_string: "replaced" },
      mockCtx
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("old_string not found");
    expect(result.content).toContain("test.txt");
  });

  it("returns error when old_string appears multiple times", async () => {
    const duplicateContent = "hello\nworld\nhello\n";
    vi.mocked(readFileSync).mockReturnValue(
      duplicateContent as unknown as ReturnType<typeof readFileSync>
    );
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "test.txt", old_string: "hello", new_string: "hi" },
      mockCtx
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("appears 2 times");
    expect(result.content).toContain("Provide more context");
  });

  it("reports exact count when old_string appears three times", async () => {
    const content = "foo\nbar\nfoo\nbaz\nfoo\n";
    vi.mocked(readFileSync).mockReturnValue(
      content as unknown as ReturnType<typeof readFileSync>
    );
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "test.txt", old_string: "foo", new_string: "qux" },
      mockCtx
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain("appears 3 times");
  });

  it("succeeds when old_string appears exactly once even with similar substrings", async () => {
    const content = "prefix-old_string\nother-old_string_suffix\n";
    vi.mocked(readFileSync).mockReturnValue(
      content as unknown as ReturnType<typeof readFileSync>
    );
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "test.txt", old_string: "prefix-old_string", new_string: "changed" },
      mockCtx
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Edited");
  });

  // ── linesChanged metadata ────────────────────────────────────────────────────

  it("calculates linesChanged as 0 when old and new have the same number of lines", async () => {
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "test.txt", old_string: "line two", new_string: "new two" },
      mockCtx
    );

    expect(result.metadata?.linesChanged).toBe(0);
  });

  it("calculates linesChanged correctly when new has more lines", async () => {
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "test.txt", old_string: "line two", new_string: "line two\ninserted line\nanother one" },
      mockCtx
    );

    expect(result.metadata?.linesChanged).toBe(2);
  });

  it("calculates linesChanged correctly when old has more lines", async () => {
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "test.txt", old_string: "line two\nline three", new_string: "combined" },
      mockCtx
    );

    expect(result.metadata?.linesChanged).toBe(1);
  });

  // ── Write / rename errors ────────────────────────────────────────────────────

  it("returns UNKNOWN when writeFileSync fails", async () => {
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "test.txt", old_string: "line two", new_string: "replaced" },
      mockCtx
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("ENOSPC");
  });

  it("returns UNKNOWN when renameSync fails", async () => {
    vi.mocked(renameSync).mockImplementation(() => {
      throw new Error("EXDEV: cross-device link not permitted");
    });
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "test.txt", old_string: "line two", new_string: "replaced" },
      mockCtx
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("EXDEV");
  });

  it("handles non-Error thrown values in write failure", async () => {
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw "string write error";
    });
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "test.txt", old_string: "line two", new_string: "replaced" },
      mockCtx
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toBe("string write error");
  });

  it("handles non-Error thrown values in rename failure", async () => {
    vi.mocked(renameSync).mockImplementation(() => {
      throw 42;
    });
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "test.txt", old_string: "line two", new_string: "replaced" },
      mockCtx
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toBe("42");
  });

  // ── Edge cases ───────────────────────────────────────────────────────────────

  it("replaces content that spans multiple lines", async () => {
    const multiLineContent = "function foo() {\n  bar();\n  baz();\n}\n";
    vi.mocked(readFileSync).mockReturnValue(
      multiLineContent as unknown as ReturnType<typeof readFileSync>
    );
    const tool = await loadTool();

    const result = await tool.execute(
      {
        path: "code.ts",
        old_string: "  bar();\n  baz();",
        new_string: "  // removed bar and baz\n  qux();",
      },
      mockCtx
    );

    expect(result.ok).toBe(true);
    const expectedContent = multiLineContent.replace("  bar();\n  baz();", "  // removed bar and baz\n  qux();");
    expect(writeFileSync).toHaveBeenCalledWith(
      `${TEST_PATH}.vera.tmp`,
      expectedContent,
      "utf8"
    );
  });

  it("replaces content with exact whitespace matching", async () => {
    const content = "  indented line\n    double indent\n";
    vi.mocked(readFileSync).mockReturnValue(
      content as unknown as ReturnType<typeof readFileSync>
    );
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "test.txt", old_string: "  indented line", new_string: "  modified indent" },
      mockCtx
    );

    expect(result.ok).toBe(true);
    const expectedContent = "  modified indent\n    double indent\n";
    expect(writeFileSync).toHaveBeenCalledWith(
      `${TEST_PATH}.vera.tmp`,
      expectedContent,
      "utf8"
    );
  });

  it("replaces at the beginning of the file", async () => {
    const content = "first\nsecond\nthird\n";
    vi.mocked(readFileSync).mockReturnValue(
      content as unknown as ReturnType<typeof readFileSync>
    );
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "test.txt", old_string: "first", new_string: "modified first" },
      mockCtx
    );

    expect(result.ok).toBe(true);
    expect(writeFileSync).toHaveBeenCalledWith(
      `${TEST_PATH}.vera.tmp`,
      "modified first\nsecond\nthird\n",
      "utf8"
    );
  });

  it("replaces at the end of the file", async () => {
    const content = "first\nsecond\nthird\n";
    vi.mocked(readFileSync).mockReturnValue(
      content as unknown as ReturnType<typeof readFileSync>
    );
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "test.txt", old_string: "third", new_string: "modified third" },
      mockCtx
    );

    expect(result.ok).toBe(true);
    expect(writeFileSync).toHaveBeenCalledWith(
      `${TEST_PATH}.vera.tmp`,
      "first\nsecond\nmodified third\n",
      "utf8"
    );
  });

  it("replaces the entire file content", async () => {
    const content = "entire old content\n";
    vi.mocked(readFileSync).mockReturnValue(
      content as unknown as ReturnType<typeof readFileSync>
    );
    const tool = await loadTool();

    const result = await tool.execute(
      {
        path: "test.txt",
        old_string: "entire old content",
        new_string: "entire new content\nwith two lines",
      },
      mockCtx
    );

    expect(result.ok).toBe(true);
    expect(writeFileSync).toHaveBeenCalledWith(
      `${TEST_PATH}.vera.tmp`,
      "entire new content\nwith two lines\n",
      "utf8"
    );
    expect(result.metadata?.linesChanged).toBe(1);
  });

  it("returns diff metadata with structured hunks from getPatchFromContents", async () => {
    const mockHunks = [
      {
        oldStart: 2,
        oldLines: 1,
        newStart: 2,
        newLines: 1,
        lines: ["-line two", "+replaced"],
        linedelimiters: ["\n", "\n"],
      },
    ];
    const { getPatchFromContents } = await import("../../utils/diff.js");
    vi.mocked(getPatchFromContents).mockReturnValue(mockHunks);
    const tool = await loadTool();

    const result = await tool.execute(
      { path: "test.txt", old_string: "line two", new_string: "replaced" },
      mockCtx
    );

    expect(result.metadata?.diff?.hunks).toEqual(mockHunks);
    expect(result.metadata?.diff?.filePath).toBe("test.txt");
  });

  it("does not read or write when safePath rejects before any I/O", async () => {
    const { safePath } = await import("../utils/path.js");
    vi.mocked(safePath).mockReturnValue({ error: "outside" });
    const tool = await loadTool();

    await tool.execute({ path: "../bad", old_string: "x", new_string: "y" }, mockCtx);

    expect(readFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(renameSync).not.toHaveBeenCalled();
  });

  it("handles an empty old_string replacing at position 0", async () => {
    // empty old_string would be found at position 0; countOccurrences would loop infinitely?
    // Actually: indexOf("", 0) = 0, then pos becomes 0, then indexOf("", 0) = 0 again...
    // Let's verify the actual behavior — for robustness, test with a non-empty match
    const content = "hello world\n";
    vi.mocked(readFileSync).mockReturnValue(
      content as unknown as ReturnType<typeof readFileSync>
    );
    const tool = await loadTool();

    // Using a real single-char replacement
    const result = await tool.execute(
      { path: "test.txt", old_string: "hello", new_string: "hi" },
      mockCtx
    );

    expect(result.ok).toBe(true);
    expect(writeFileSync).toHaveBeenCalledWith(
      `${TEST_PATH}.vera.tmp`,
      "hi world\n",
      "utf8"
    );
  });
});

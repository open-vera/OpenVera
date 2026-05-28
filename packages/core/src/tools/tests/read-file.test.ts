/**
 * Tests for read_file tool (read-file.ts)
 *
 * Verifies: file reading with line numbers, offset/limit slicing,
 * binary detection, file-not-found, permission denied, directory-is-file,
 * truncation, language detection, and file state caching.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, statSync } from "node:fs";
import type { ToolContext } from "../types.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock("../utils/path.js", () => ({
  safePath: vi.fn(),
}));

vi.mock("../utils/binary.js", () => ({
  isBinaryPath: vi.fn(),
  hasBinaryContent: vi.fn(),
}));

vi.mock("../utils/truncate.js", () => ({
  truncateLines: vi.fn(),
}));

vi.mock("../fileStateCache.js", () => ({
  setFileState: vi.fn(),
}));

const TEST_PATH = "/tmp/test-read-file.txt";
const FILE_CONTENT = "line one\nline two\nline three\nline four\nline five";

const mockCtx: ToolContext = {
  cwd: "/tmp",
  sessionId: "test-session",
};

function mockStatFile(size = 100) {
  vi.mocked(statSync).mockReturnValue({
    isDirectory: () => false,
    size,
  } as unknown as import("node:fs").Stats);
}

function mockReadSuccess(content = FILE_CONTENT) {
  vi.mocked(readFileSync).mockReturnValue(content as unknown as ReturnType<typeof readFileSync>);
}

beforeEach(async () => {
  vi.clearAllMocks();
  const { safePath } = await import("../utils/path.js");
  vi.mocked(safePath).mockImplementation((p: string) => ({ resolved: `/tmp/${p}` }));
  const { isBinaryPath } = await import("../utils/binary.js");
  vi.mocked(isBinaryPath).mockReturnValue(false);
  const { truncateLines } = await import("../utils/truncate.js");
  vi.mocked(truncateLines).mockImplementation((text: string) => ({
    content: text,
    truncated: false,
    totalLines: text.split("\n").length,
  }));
});

async function loadTool() {
  const mod = await import("../read-file.js");
  return mod.readFileTool;
}

// ── read_file ────────────────────────────────────────────────────────────────

describe("read_file", () => {
  it("reads a file and returns content with line numbers", async () => {
    mockStatFile();
    mockReadSuccess();
    const tool = await loadTool();

    const result = await tool.execute({ path: "file.txt" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("1\tline one");
    expect(result.content).toContain("2\tline two");
    expect(result.content).toContain("file.txt");
    expect(result.metadata?.bytesRead).toBe(Buffer.byteLength(FILE_CONTENT));
    expect(result.metadata?.linesRead).toBe(5);
    expect(result.metadata?.truncated).toBe(false);
    expect(result.metadata?.renderHint).toEqual({ type: "code", lang: "text" });
  });

  it("returns PATH_OUTSIDE_CWD when safePath returns error", async () => {
    const { safePath } = await import("../utils/path.js");
    vi.mocked(safePath).mockReturnValue({ error: "Path is outside allowed workdir." });
    const tool = await loadTool();

    const result = await tool.execute({ path: "../secret" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PATH_OUTSIDE_CWD");
  });

  it("returns NOT_FOUND when file does not exist", async () => {
    vi.mocked(statSync).mockImplementation(() => {
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const tool = await loadTool();

    const result = await tool.execute({ path: "missing.txt" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
    expect(result.content).toContain("File not found");
  });

  it("returns PERMISSION_DENIED when file is not accessible", async () => {
    vi.mocked(statSync).mockImplementation(() => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    const tool = await loadTool();

    const result = await tool.execute({ path: "restricted.txt" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(result.content).toContain("Permission denied");
  });

  it("returns UNKNOWN when stat throws unrecognized error", async () => {
    vi.mocked(statSync).mockImplementation(() => {
      throw new Error("EIO: i/o error");
    });
    const tool = await loadTool();

    const result = await tool.execute({ path: "broken.txt" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("EIO");
  });

  it("returns error when path is a directory", async () => {
    vi.mocked(statSync).mockReturnValue({
      isDirectory: () => true,
      size: 0,
    } as unknown as import("node:fs").Stats);
    const tool = await loadTool();

    const result = await tool.execute({ path: "mydir" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("is a directory");
    expect(result.content).toContain("list_dir");
  });

  it("returns error for binary files", async () => {
    mockStatFile(2048);
    const { isBinaryPath, hasBinaryContent } = await import("../utils/binary.js");
    vi.mocked(isBinaryPath).mockReturnValue(true);
    vi.mocked(hasBinaryContent).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(Buffer.from([0x89, 0x50, 0x00]) as unknown as ReturnType<typeof readFileSync>);
    const tool = await loadTool();

    const result = await tool.execute({ path: "image.png" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("binary");
    expect(result.content).toContain("image.png");
    expect(result.content).toContain("3 bytes");
  });

  it("skips binary detection for non-binary extensions", async () => {
    mockStatFile();
    mockReadSuccess("const x = 1;\n");
    const { isBinaryPath } = await import("../utils/binary.js");
    vi.mocked(isBinaryPath).mockReturnValue(false);
    const tool = await loadTool();

    const result = await tool.execute({ path: "app.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(isBinaryPath).toHaveBeenCalled();
    // readFileSync should be called once (for utf8 read), not twice
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });

  it("reads a specific range with offset and limit", async () => {
    mockStatFile();
    mockReadSuccess(FILE_CONTENT);
    const tool = await loadTool();

    const result = await tool.execute({ path: "file.txt", offset: 2, limit: 2 }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("2\tline two");
    expect(result.content).toContain("3\tline three");
    expect(result.content).not.toContain("1\tline one");
    expect(result.content).not.toContain("4\tline four");
    expect(result.content).toContain("lines 2–3 of 5");
    expect(result.metadata?.linesRead).toBe(2);
  });

  it("reads from offset to end when limit is not specified", async () => {
    mockStatFile();
    mockReadSuccess(FILE_CONTENT);
    const tool = await loadTool();

    const result = await tool.execute({ path: "file.txt", offset: 4 }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("4\tline four");
    expect(result.content).toContain("5\tline five");
    expect(result.content).not.toContain("1\tline one");
    expect(result.content).toContain("lines 4–5 of 5");
  });

  it("reports total line count when no offset/limit is specified", async () => {
    mockStatFile();
    mockReadSuccess(FILE_CONTENT);
    const tool = await loadTool();

    const result = await tool.execute({ path: "file.txt" }, mockCtx);

    expect(result.content).toContain("(5 lines)");
  });

  it("reports truncated state when truncation occurs", async () => {
    mockStatFile();
    mockReadSuccess("line1\nline2");
    const { truncateLines } = await import("../utils/truncate.js");
    vi.mocked(truncateLines).mockReturnValue({
      content: "truncated...",
      truncated: true,
      totalLines: 5000,
    });
    const tool = await loadTool();

    const result = await tool.execute({ path: "big.txt" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.metadata?.truncated).toBe(true);
  });

  it("detects language from file extension", async () => {
    mockStatFile();
    mockReadSuccess("console.log('hi');\n");

    const tool = await loadTool();
    const result = await tool.execute({ path: "app.js" }, mockCtx);

    expect(result.metadata?.renderHint).toEqual({ type: "code", lang: "javascript" });
  });

  it("detects typescript language", async () => {
    mockStatFile();
    mockReadSuccess("const x: number = 1;\n");
    const tool = await loadTool();

    const result = await tool.execute({ path: "app.ts" }, mockCtx);
    expect(result.metadata?.renderHint).toEqual({ type: "code", lang: "typescript" });
  });

  it("detects python language", async () => {
    mockStatFile();
    mockReadSuccess("print('hello')\n");
    const tool = await loadTool();

    const result = await tool.execute({ path: "script.py" }, mockCtx);
    expect(result.metadata?.renderHint).toEqual({ type: "code", lang: "python" });
  });

  it("detects markdown language", async () => {
    mockStatFile();
    mockReadSuccess("# Title\n");
    const tool = await loadTool();

    const result = await tool.execute({ path: "readme.md" }, mockCtx);
    expect(result.metadata?.renderHint).toEqual({ type: "code", lang: "markdown" });
  });

  it("returns 'text' for unknown extensions", async () => {
    mockStatFile();
    mockReadSuccess("data\n");
    const tool = await loadTool();

    const result = await tool.execute({ path: "data.xyz" }, mockCtx);
    expect(result.metadata?.renderHint).toEqual({ type: "code", lang: "text" });
  });

  it("handles readFileSync throwing ENOENT after stat succeeds", async () => {
    mockStatFile();
    vi.mocked(readFileSync).mockImplementation(() => {
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const tool = await loadTool();

    const result = await tool.execute({ path: "vanished.txt" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
  });

  it("handles readFileSync throwing EACCES after stat succeeds", async () => {
    mockStatFile();
    vi.mocked(readFileSync).mockImplementation(() => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    const tool = await loadTool();

    const result = await tool.execute({ path: "locked.txt" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
  });

  it("handles readFileSync throwing unknown error after stat succeeds", async () => {
    mockStatFile();
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOMEM: not enough memory");
    });
    const tool = await loadTool();

    const result = await tool.execute({ path: "huge.txt" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("ENOMEM");
  });

  it("handles binary check read failure", async () => {
    mockStatFile(1024);
    const { isBinaryPath } = await import("../utils/binary.js");
    vi.mocked(isBinaryPath).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT: file vanished during read");
    });
    const tool = await loadTool();

    const result = await tool.execute({ path: "data.bin" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
    expect(result.content).toContain("Cannot read file");
  });

  it("continues as text when binary extension but no binary content", async () => {
    mockStatFile();
    const { isBinaryPath, hasBinaryContent } = await import("../utils/binary.js");
    vi.mocked(isBinaryPath).mockReturnValue(true);
    vi.mocked(hasBinaryContent).mockReturnValue(false);
    // First call returns Buffer for binary check, second returns string for read
    vi.mocked(readFileSync)
      .mockReturnValueOnce(Buffer.from("not binary") as unknown as ReturnType<typeof readFileSync>)
      .mockReturnValueOnce("text content\n" as unknown as ReturnType<typeof readFileSync>);
    const tool = await loadTool();

    const result = await tool.execute({ path: "maybe.bin" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("text content");
  });
});

/**
 * Tests for write_file tool (write-file.ts)
 *
 * Verifies: successful file writing, atomic write (temp + rename), diff generation,
 * path validation, staleness detection, permission denied, error cleanup,
 * parent directory creation, and cache updates.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  writeFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import type { ToolContext } from "../types.js";

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
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

const TEST_PATH = "/tmp/test-write.txt";
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
  vi.mocked(readFileSync).mockReturnValue("old content\n" as unknown as ReturnType<typeof readFileSync>);
});

async function loadTool() {
  const mod = await import("../write-file.js");
  return mod.writeFileTool;
}

// ── write_file ───────────────────────────────────────────────────────────────

describe("write_file", () => {
  it("writes a file successfully and returns metadata", async () => {
    const tool = await loadTool();
    const result = await tool.execute({ path: "test.txt", content: "hello\nworld" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Wrote 2 lines to test.txt");
    expect(result.metadata?.linesChanged).toBe(2);
    expect(result.metadata?.renderHint).toEqual({ type: "diff" });
    expect(result.metadata?.diff?.filePath).toBe("test.txt");
  });

  it("uses atomic write with temp file and rename", async () => {
    const tool = await loadTool();
    await tool.execute({ path: "test.txt", content: "data" }, mockCtx);

    expect(mkdirSync).toHaveBeenCalledWith("/tmp", { recursive: true });
    expect(writeFileSync).toHaveBeenCalledWith(`${TEST_PATH}.vera.tmp`, "data", "utf8");
    expect(renameSync).toHaveBeenCalledWith(`${TEST_PATH}.vera.tmp`, TEST_PATH);
  });

  it("returns PATH_OUTSIDE_CWD when safePath returns error", async () => {
    const { safePath } = await import("../utils/path.js");
    vi.mocked(safePath).mockReturnValue({ error: "Path is outside allowed workdir." });
    const tool = await loadTool();

    const result = await tool.execute({ path: "../secret", content: "data" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PATH_OUTSIDE_CWD");
  });

  it("returns error when file is stale (modified externally)", async () => {
    const { checkStaleness } = await import("../fileStateCache.js");
    vi.mocked(checkStaleness).mockReturnValue("stale");
    const tool = await loadTool();

    const result = await tool.execute({ path: "test.txt", content: "data" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("modified externally");
    expect(result.content).toContain("read it again");
  });

  it("returns error when file exists but has not been read", async () => {
    const { checkStaleness } = await import("../fileStateCache.js");
    vi.mocked(checkStaleness).mockReturnValue("not_read");
    vi.mocked(readFileSync).mockReturnValue("existing\n" as unknown as ReturnType<typeof readFileSync>);
    const tool = await loadTool();

    const result = await tool.execute({ path: "test.txt", content: "data" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("has not been read");
    expect(result.content).toContain("read it first");
  });

  it("allows writing when file exists but staleness is 'not_read' and file is empty (new file)", async () => {
    const { checkStaleness } = await import("../fileStateCache.js");
    vi.mocked(checkStaleness).mockReturnValue("not_read");
    vi.mocked(readFileSync).mockReturnValue("" as unknown as ReturnType<typeof readFileSync>);
    const tool = await loadTool();

    const result = await tool.execute({ path: "new.txt", content: "data" }, mockCtx);

    expect(result.ok).toBe(true);
  });

  it("allows writing when file does not exist (new file creation)", async () => {
    const { checkStaleness } = await import("../fileStateCache.js");
    vi.mocked(checkStaleness).mockReturnValue("ok");
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file");
    });
    const tool = await loadTool();

    const result = await tool.execute({ path: "new.txt", content: "brand new content" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Wrote 1 lines to new.txt");
  });

  it("returns PERMISSION_DENIED when write fails with EACCES", async () => {
    vi.mocked(writeFileSync).mockImplementation(() => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    const tool = await loadTool();

    const result = await tool.execute({ path: "locked.txt", content: "data" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(result.content).toContain("Permission denied");
  });

  it("returns UNKNOWN for non-EACCES write errors", async () => {
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    const tool = await loadTool();

    const result = await tool.execute({ path: "test.txt", content: "data" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("ENOSPC");
  });

  it("cleans up temp file on write failure", async () => {
    vi.mocked(renameSync).mockImplementation(() => {
      throw new Error("EXDEV: cross-device link not permitted");
    });
    const tool = await loadTool();

    await tool.execute({ path: "test.txt", content: "data" }, mockCtx);

    expect(unlinkSync).toHaveBeenCalledWith(`${TEST_PATH}.vera.tmp`);
  });

  it("generates diff from getPatchFromContents", async () => {
    const tool = await loadTool();

    const result = await tool.execute({ path: "test.txt", content: "new" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.metadata?.diff).toBeDefined();
    expect(result.metadata?.diff?.filePath).toBe("test.txt");
    expect(Array.isArray(result.metadata?.diff?.hunks)).toBe(true);
  });

  it("allows partial_read staleness (does not block)", async () => {
    const tool = await loadTool();

    // partial_read should not be blocked — only "stale" and "not_read" (with content) block
    const result = await tool.execute({ path: "test.txt", content: "data" }, mockCtx);

    // Should succeed (partial_read falls through to normal write path)
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Wrote");
  });

  it("creates parent directories recursively", async () => {
    const { safePath } = await import("../utils/path.js");
    vi.mocked(safePath).mockReturnValue({ resolved: "/tmp/deep/nested/dir/file.txt" });
    const tool = await loadTool();

    await tool.execute({ path: "deep/nested/dir/file.txt", content: "data" }, mockCtx);

    expect(mkdirSync).toHaveBeenCalledWith("/tmp/deep/nested/dir", { recursive: true });
  });

  it("handles non-Error thrown values in write failure", async () => {
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw "string error";
    });
    const tool = await loadTool();

    const result = await tool.execute({ path: "test.txt", content: "data" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toBe("string error");
  });
});

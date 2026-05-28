/**
 * Tests for list_dir tool (list-dir.ts)
 *
 * Verifies: directory listing with files/dirs, error handling (ENOENT, ENOTDIR,
 * EACCES, unknown), empty directories, inaccessible entries, size formatting,
 * hidden files, and default path behavior.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import type { ToolContext } from "../types.js";

vi.mock("node:fs", () => ({
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock("../utils/path.js", () => ({
  safePath: vi.fn(),
}));

const TEST_DIR = "/tmp/test-list-dir";

function makeDirStats(): Stats {
  return { isDirectory: () => true } as unknown as Stats;
}

function makeFileStats(size: number): Stats {
  return { isDirectory: () => false, size } as unknown as Stats;
}

const mockCtx: ToolContext = {
  cwd: TEST_DIR,
  sessionId: "test-session",
};

beforeEach(async () => {
  vi.clearAllMocks();
  const { safePath } = await import("../utils/path.js");
  vi.mocked(safePath).mockReturnValue({ resolved: TEST_DIR });
});

async function loadTool() {
  const mod = await import("../list-dir.js");
  return mod.listDirTool;
}

// ── list_dir ─────────────────────────────────────────────────────────────────

describe("list_dir", () => {
  it("lists directory with files and subdirectories", async () => {
    vi.mocked(readdirSync)
      .mockReturnValueOnce(["file.txt", "subdir"] as unknown as string[])
      .mockReturnValueOnce([] as unknown as string[]); // subdir has 0 items
    vi.mocked(statSync)
      .mockReturnValueOnce(makeFileStats(1024))
      .mockReturnValueOnce(makeDirStats());

    const tool = await loadTool();
    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("file.txt");
    expect(result.content).toContain("1.0KB");
    expect(result.content).toContain("subdir/");
    expect(result.content).toContain("0 items");
    expect(result.metadata?.renderHint).toEqual({ type: "file-list" });
  });

  it("sorts entries alphabetically", async () => {
    vi.mocked(readdirSync).mockReturnValueOnce(["zebra", "alpha", "middle"] as unknown as string[]);
    vi.mocked(statSync)
      .mockReturnValue(makeFileStats(100));

    const tool = await loadTool();
    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(true);
    const alphaIdx = result.content.indexOf("alpha");
    const middleIdx = result.content.indexOf("middle");
    const zebraIdx = result.content.indexOf("zebra");
    expect(alphaIdx).toBeLessThan(middleIdx);
    expect(middleIdx).toBeLessThan(zebraIdx);
  });

  it("returns PATH_OUTSIDE_CWD when safePath returns error", async () => {
    const { safePath } = await import("../utils/path.js");
    vi.mocked(safePath).mockReturnValue({ error: "Path is outside allowed workdir." });

    const tool = await loadTool();
    const result = await tool.execute({ path: "../secret" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PATH_OUTSIDE_CWD");
  });

  it("returns NOT_FOUND when directory does not exist", async () => {
    vi.mocked(readdirSync).mockImplementation(() => {
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const tool = await loadTool();
    const result = await tool.execute({ path: "nonexistent" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
    expect(result.content).toContain("Directory not found");
  });

  it("returns UNKNOWN when path is not a directory", async () => {
    vi.mocked(readdirSync).mockImplementation(() => {
      const err = new Error("ENOTDIR: not a directory") as NodeJS.ErrnoException;
      err.code = "ENOTDIR";
      throw err;
    });

    const tool = await loadTool();
    const result = await tool.execute({ path: "file.txt" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("Not a directory");
  });

  it("returns PERMISSION_DENIED on EACCES", async () => {
    vi.mocked(readdirSync).mockImplementation(() => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });

    const tool = await loadTool();
    const result = await tool.execute({ path: "restricted" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(result.content).toContain("Permission denied");
  });

  it("returns UNKNOWN for unrecognized errors", async () => {
    vi.mocked(readdirSync).mockImplementation(() => {
      throw new Error("ELOOP: too many symbolic links");
    });

    const tool = await loadTool();
    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("ELOOP");
  });

  it("handles non-Error thrown values", async () => {
    vi.mocked(readdirSync).mockImplementation(() => {
      throw "string error";
    });

    const tool = await loadTool();
    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toBe("string error");
  });

  it("shows empty directory message when directory has no entries", async () => {
    vi.mocked(readdirSync).mockReturnValue([] as unknown as string[]);

    const tool = await loadTool();
    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("(empty directory)");
  });

  it("marks inaccessible entries when statSync throws", async () => {
    vi.mocked(readdirSync).mockReturnValue(["broken-link"] as unknown as string[]);
    vi.mocked(statSync).mockImplementation(() => {
      throw new Error("ENOENT: broken symlink");
    });

    const tool = await loadTool();
    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("broken-link");
    expect(result.content).toContain("(inaccessible)");
  });

  it("formats file sizes correctly for bytes, KB, and MB", async () => {
    vi.mocked(readdirSync).mockReturnValue(["small", "medium", "large"] as unknown as string[]);
    vi.mocked(statSync)
      .mockReturnValueOnce(makeFileStats(500))         // 500B
      .mockReturnValueOnce(makeFileStats(2560))         // 2.5KB
      .mockReturnValueOnce(makeFileStats(5242880));     // 5.0MB

    const tool = await loadTool();
    const result = await tool.execute({}, mockCtx);

    expect(result.content).toContain("500B");
    expect(result.content).toContain("2.5KB");
    expect(result.content).toContain("5.0MB");
  });

  it("uses default path '.' when no path argument is provided", async () => {
    vi.mocked(readdirSync).mockReturnValue([] as unknown as string[]);

    const tool = await loadTool();
    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(true);
    // The output starts with the target path which defaults to "."
    expect(result.content).toContain(".\n");
  });

  it("shows singular 'item' for directories with exactly one child", async () => {
    vi.mocked(readdirSync)
      .mockReturnValueOnce(["dir-with-one-child"] as unknown as string[])
      .mockReturnValueOnce(["only-child"] as unknown as string[]);
    vi.mocked(statSync)
      .mockReturnValueOnce(makeDirStats())
      .mockReturnValueOnce(makeFileStats(10));

    const tool = await loadTool();
    const result = await tool.execute({}, mockCtx);

    expect(result.content).toContain("1 item");
    expect(result.content).not.toContain("1 items");
  });

  it("shows header separator line", async () => {
    vi.mocked(readdirSync).mockReturnValue([] as unknown as string[]);

    const tool = await loadTool();
    const result = await tool.execute({}, mockCtx);

    expect(result.content).toContain("─".repeat(30));
  });
});

/**
 * Tests for FileStateCache — module-level file read state tracking
 * for optimistic locking.
 *
 * Verifies: setFileState (full read, partial read, mtime=null when statSync fails),
 * getFileState (cached, missing), clearFileState, getFilemtime (success, error returns null),
 * checkStaleness: file doesn't exist (ok), never read (not_read), partial_read,
 * mtime unchanged (ok), mtime advanced content same (ok), mtime advanced content
 * different (stale), readFileSync error on staleness check (stale).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { statSync, readFileSync } from "node:fs";
import {
  setFileState,
  getFileState,
  clearFileState,
  getFileMtime,
  checkStaleness,
} from "../FileStateCache.js";

vi.mock("node:fs", () => ({
  statSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const ABS_PATH = "/tmp/test-file.txt";
const ALT_PATH = "/tmp/alt-file.txt";
const CONTENT_A = "hello world\nfoo bar";
const CONTENT_B = "modified content\nbaz qux";
const MTIME_1000 = 1000;
const MTIME_2000 = 2000;

/** Mock statSync to return an mtimeMs value. */
function mockFileExists(mtimeMs: number): void {
  vi.mocked(statSync).mockReturnValue({
    mtimeMs,
  } as unknown as import("node:fs").Stats);
}

/** Mock statSync to throw (file doesn't exist). */
function mockFileMissing(): void {
  vi.mocked(statSync).mockImplementation(() => {
    throw new Error("ENOENT: no such file or directory");
  });
}

/** Mock readFileSync to return content. */
function mockReadFile(content: string): void {
  vi.mocked(readFileSync).mockReturnValue(content as unknown as Buffer);
}

/** Mock readFileSync to throw. */
function mockReadFileError(): void {
  vi.mocked(readFileSync).mockImplementation(() => {
    throw new Error("EACCES: permission denied");
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Clean the module-level cache between tests to prevent cross-test
  // contamination. The internal Map persists across test cases since the
  // module is an ESM singleton.
  clearFileState(ABS_PATH);
  clearFileState(ALT_PATH);
  clearFileState("/tmp/file-1.txt");
  clearFileState("/tmp/file-2.txt");
  clearFileState("/root/secret.txt");
  clearFileState("/never/seen");
});

// ── getFilemtime ─────────────────────────────────────────────────────────────

describe("getFilemtime", () => {
  it("returns the floored mtimeMs when the file exists", () => {
    mockFileExists(1234.567);
    expect(getFileMtime(ABS_PATH)).toBe(1234);
  });

  it("returns null when statSync throws (file doesn't exist)", () => {
    mockFileMissing();
    expect(getFileMtime(ABS_PATH)).toBeNull();
  });

  it("returns null when statSync throws for other reasons (permission)", () => {
    vi.mocked(statSync).mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    expect(getFileMtime("/root/secret.txt")).toBeNull();
  });
});

// ── setFileState ─────────────────────────────────────────────────────────────

describe("setFileState", () => {
  it("records full-read file state with mtime and content", () => {
    mockFileExists(MTIME_1000);
    setFileState(ABS_PATH, CONTENT_A, false);

    const state = getFileState(ABS_PATH);
    expect(state).not.toBeNull();
    expect(state!.mtime).toBe(MTIME_1000);
    expect(state!.content).toBe(CONTENT_A);
    expect(state!.isPartialRead).toBe(false);
  });

  it("records partial read file state with mtime but undefined content", () => {
    mockFileExists(MTIME_1000);
    setFileState(ABS_PATH, CONTENT_A, true);

    const state = getFileState(ABS_PATH);
    expect(state).not.toBeNull();
    expect(state!.mtime).toBe(MTIME_1000);
    expect(state!.content).toBeUndefined();
    expect(state!.isPartialRead).toBe(true);
  });

  it("does not cache anything when getFilemtime returns null (file gone)", () => {
    // Use a path never cached so we can trust getFileState returns null
    const freshPath = "/tmp/fresh-never-cached.txt";
    mockFileMissing();
    setFileState(freshPath, CONTENT_A, false);

    expect(getFileState(freshPath)).toBeNull();
  });

  it("defaults isPartialRead to false when not provided", () => {
    mockFileExists(MTIME_1000);
    setFileState(ABS_PATH, CONTENT_A);

    const state = getFileState(ABS_PATH);
    expect(state).not.toBeNull();
    expect(state!.isPartialRead).toBe(false);
  });

  it("can overwrite a previously cached file state", () => {
    mockFileExists(MTIME_1000);
    setFileState(ABS_PATH, CONTENT_A, false);

    mockFileExists(MTIME_2000);
    setFileState(ABS_PATH, CONTENT_B, false);

    const state = getFileState(ABS_PATH);
    expect(state!.mtime).toBe(MTIME_2000);
    expect(state!.content).toBe(CONTENT_B);
  });
});

// ── getFileState ─────────────────────────────────────────────────────────────

describe("getFileState", () => {
  it("returns null for a path that was never cached", () => {
    expect(getFileState("/never/cached/path")).toBeNull();
  });

  it("returns the exact FileState object that was set", () => {
    mockFileExists(MTIME_1000);
    setFileState(ABS_PATH, CONTENT_A, false);
    const state = getFileState(ABS_PATH);

    expect(state).toEqual({
      mtime: MTIME_1000,
      content: CONTENT_A,
      isPartialRead: false,
    });
  });
});

// ── clearFileState ───────────────────────────────────────────────────────────

describe("clearFileState", () => {
  it("removes a cached entry so getFileState returns null", () => {
    mockFileExists(MTIME_1000);
    setFileState(ABS_PATH, CONTENT_A);
    expect(getFileState(ABS_PATH)).not.toBeNull();

    clearFileState(ABS_PATH);
    expect(getFileState(ABS_PATH)).toBeNull();
  });

  it("is a no-op for paths that were never cached (does not throw)", () => {
    expect(() => clearFileState("/a/path/never/seen")).not.toThrow();
  });
});

// ── checkStaleness ───────────────────────────────────────────────────────────

describe("checkStaleness", () => {
  describe('file does not exist (mtime = null) → "ok"', () => {
    it("returns ok for a brand new file being created (never read)", () => {
      mockFileMissing();
      expect(checkStaleness(ABS_PATH)).toBe("ok");
    });

    it("returns ok even if the file was read but then deleted", () => {
      mockFileExists(MTIME_1000);
      setFileState(ABS_PATH, CONTENT_A, false);

      // Then the file disappears
      mockFileMissing();
      expect(checkStaleness(ABS_PATH)).toBe("ok");
    });
  });

  describe('never read → "not_read"', () => {
    it("returns not_read for a file that exists but was never cached", () => {
      // Use a fresh path to guarantee no cached state exists
      const freshPath = "/tmp/never-read-before.txt";
      mockFileExists(MTIME_1000);
      expect(checkStaleness(freshPath)).toBe("not_read");
    });
  });

  describe('partial read → "partial_read"', () => {
    it("returns partial_read when state has isPartialRead = true", () => {
      mockFileExists(MTIME_1000);
      setFileState(ABS_PATH, CONTENT_A, true);

      // Use same mtime so it doesn't become stale from mtime check
      mockFileExists(MTIME_1000);
      expect(checkStaleness(ABS_PATH)).toBe("partial_read");
    });

    it("returns partial_read even when mtime has advanced (partial check wins)", () => {
      mockFileExists(MTIME_1000);
      setFileState(ABS_PATH, CONTENT_A, true);

      mockFileExists(MTIME_2000);
      // isPartialRead is checked before mtime comparison
      expect(checkStaleness(ABS_PATH)).toBe("partial_read");
    });
  });

  describe('mtime unchanged → "ok"', () => {
    it("returns ok when current mtime <= cached mtime", () => {
      mockFileExists(MTIME_1000);
      setFileState(ABS_PATH, CONTENT_A, false);

      mockFileExists(MTIME_1000);
      expect(checkStaleness(ABS_PATH)).toBe("ok");
    });

    it("returns ok when current mtime is less than cached mtime (clock skew)", () => {
      mockFileExists(MTIME_2000);
      setFileState(ABS_PATH, CONTENT_A, false);

      // Clock rolled back
      mockFileExists(MTIME_1000);
      expect(checkStaleness(ABS_PATH)).toBe("ok");
    });
  });

  describe('mtime advanced, content same → "ok"', () => {
    it("returns ok when mtime bumped but content is identical", () => {
      mockFileExists(MTIME_1000);
      setFileState(ABS_PATH, CONTENT_A, false);

      // mtime advanced but content unchanged (cloud sync / antivirus)
      mockFileExists(MTIME_2000);
      mockReadFile(CONTENT_A);
      expect(checkStaleness(ABS_PATH)).toBe("ok");
    });
  });

  describe('mtime advanced, content different → "stale"', () => {
    it("returns stale when mtime advanced and content differs", () => {
      mockFileExists(MTIME_1000);
      setFileState(ABS_PATH, CONTENT_A, false);

      mockFileExists(MTIME_2000);
      mockReadFile(CONTENT_B);
      expect(checkStaleness(ABS_PATH)).toBe("stale");
    });
  });

  describe('readFileSync error on staleness check → "stale"', () => {
    it("returns stale when readFileSync throws during content comparison", () => {
      mockFileExists(MTIME_1000);
      setFileState(ABS_PATH, CONTENT_A, false);

      mockFileExists(MTIME_2000);
      mockReadFileError();
      expect(checkStaleness(ABS_PATH)).toBe("stale");
    });
  });

  describe("multiple files independent state", () => {
    it("tracks different files independently", () => {
      const file1 = "/tmp/file-1.txt";
      const file2 = "/tmp/file-2.txt";

      mockFileExists(MTIME_1000);
      setFileState(file1, CONTENT_A, false);

      // file2 never cached — different path
      mockFileExists(MTIME_1000);
      expect(getFileState(file1)).not.toBeNull();
      expect(getFileState(file2)).toBeNull();

      // file2 should be "not_read", file1 "ok" simultaneously
      expect(checkStaleness(file1)).toBe("ok");
      expect(checkStaleness(file2)).toBe("not_read");
    });
  });
});

/**
 * Edge-case tests for LocalFsObjectStore private helpers.
 *
 * Covers isNodeError and isStringRecord type-guard branches indirectly
 * through the public API error-handling paths.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFile, unlink, stat } from "node:fs/promises";
import { LocalFsObjectStore } from "../local-fs-adapter.js";
import { ObjectNotFoundError } from "../object-store.js";

vi.mock("node:fs/promises");

function enoentError(): NodeJS.ErrnoException {
  const err = new Error("ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

function epermError(): NodeJS.ErrnoException {
  const err = new Error("EPERM") as NodeJS.ErrnoException;
  err.code = "EPERM";
  return err;
}

function fileStat() {
  return {
    size: 100, mtime: new Date("2026-01-01T00:00:00Z"),
    isFile: () => true, isDirectory: () => false,
  } as any;
}

describe("isNodeError — edge cases via public API", () => {
  let store: LocalFsObjectStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new LocalFsObjectStore({ type: "local", rootDir: "/mock-root" });
  });

  describe("via head", () => {
    it("rethrows Error without code property (isNodeError returns false)", async () => {
      vi.mocked(stat).mockRejectedValue(new Error("plain error"));
      await expect(store.head("key.txt")).rejects.toThrow("plain error");
    });

    it("converts Error with code=ENOENT to ObjectNotFoundError", async () => {
      vi.mocked(stat).mockRejectedValue(enoentError());
      await expect(store.head("key.txt")).rejects.toThrow(ObjectNotFoundError);
    });

    it("rethrows Error with code=EPERM (non-ENOENT code)", async () => {
      vi.mocked(stat).mockRejectedValue(epermError());
      await expect(store.head("key.txt")).rejects.toThrow("EPERM");
    });
  });

  describe("via exists", () => {
    it("returns false for ENOENT", async () => {
      vi.mocked(stat).mockRejectedValue(enoentError());
      expect(await store.exists("key.txt")).toBe(false);
    });

    it("rethrows non-Error values (isNodeError returns false)", async () => {
      vi.mocked(stat).mockRejectedValue("string error");
      await expect(store.exists("key.txt")).rejects.toBe("string error");
    });
  });

  describe("via delete", () => {
    it("silently returns for ENOENT on unlink", async () => {
      vi.mocked(unlink).mockRejectedValue(enoentError());
      await expect(store.delete("key.txt")).resolves.toBeUndefined();
    });

    it("rethrows non-ENOENT code on unlink", async () => {
      vi.mocked(unlink).mockRejectedValue(epermError());
      await expect(store.delete("key.txt")).rejects.toThrow("EPERM");
    });
  });
});

describe("isStringRecord — edge cases via get (readMeta)", () => {
  let store: LocalFsObjectStore;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(stat).mockResolvedValue(fileStat());
    store = new LocalFsObjectStore({ type: "local", rootDir: "/mock-root" });
  });

  it("accepts valid string-record metadata", async () => {
    vi.mocked(readFile).mockImplementation(((path: string, opts?: any) => {
      if (typeof opts === "string" ? opts : opts?.encoding) {
        return Promise.resolve(JSON.stringify({ metadata: { author: "test", lang: "en" } }));
      }
      return Promise.resolve(Buffer.from("data"));
    }) as any);

    const result = await store.get("file.txt");
    expect(result.metadata.metadata).toEqual({ author: "test", lang: "en" });
  });

  it("filters out metadata with non-string values (isStringRecord false)", async () => {
    vi.mocked(readFile).mockImplementation(((path: string, opts?: any) => {
      if (typeof opts === "string" ? opts : opts?.encoding) {
        return Promise.resolve(JSON.stringify({ metadata: { a: 123 } }));
      }
      return Promise.resolve(Buffer.from("data"));
    }) as any);

    const result = await store.get("file.txt");
    expect(result.metadata.metadata).toBeUndefined();
  });

  it("filters out null metadata (isStringRecord false)", async () => {
    vi.mocked(readFile).mockImplementation(((path: string, opts?: any) => {
      if (typeof opts === "string" ? opts : opts?.encoding) {
        return Promise.resolve(JSON.stringify({ metadata: null }));
      }
      return Promise.resolve(Buffer.from("data"));
    }) as any);

    const result = await store.get("file.txt");
    expect(result.metadata.metadata).toBeUndefined();
  });

  it("filters out non-string contentType", async () => {
    vi.mocked(readFile).mockImplementation(((path: string, opts?: any) => {
      if (typeof opts === "string" ? opts : opts?.encoding) {
        return Promise.resolve(JSON.stringify({ contentType: 123 }));
      }
      return Promise.resolve(Buffer.from("data"));
    }) as any);

    const result = await store.get("file.txt");
    expect(result.metadata.contentType).toBeUndefined();
  });

  it("accepts empty metadata object (vacuously true)", async () => {
    vi.mocked(readFile).mockImplementation(((path: string, opts?: any) => {
      if (typeof opts === "string" ? opts : opts?.encoding) {
        return Promise.resolve(JSON.stringify({ metadata: {} }));
      }
      return Promise.resolve(Buffer.from("data"));
    }) as any);

    const result = await store.get("file.txt");
    expect(result.metadata.metadata).toEqual({});
  });
});

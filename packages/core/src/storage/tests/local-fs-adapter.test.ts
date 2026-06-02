/**
 * Unit tests for LocalFsObjectStore using mocked node:fs/promises.
 *
 * Covers all public methods (put, get, delete, deleteMany, list, exists, head,
 * presignUrl, close), internal helpers (resolvePath, readMeta, writeMeta,
 * walkDir) tested indirectly, and the factory createLocalFsStore.
 *
 * Private helpers isNodeError and isStringRecord are covered in
 * local-fs-adapter-edge.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdir, readFile, writeFile, unlink, stat, readdir } from "node:fs/promises";
import { LocalFsObjectStore, createLocalFsStore } from "../local-fs-adapter.js";
import { ObjectNotFoundError, ObjectAlreadyExistsError } from "../object-store.js";

vi.mock("node:fs/promises");

// ── Helpers ───────────────────────────────────────────────────────────────────

function dirent(name: string, isDir: boolean) {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function fileStat(size = 100, mtime: Date = new Date("2026-01-01T00:00:00Z")) {
  return {
    size, mtime,
    isFile: () => true, isDirectory: () => false,
    isBlockDevice: () => false, isCharacterDevice: () => false,
    isSymbolicLink: () => false, isFIFO: () => false, isSocket: () => false,
    dev: 0, ino: 0, mode: 0, nlink: 0, uid: 0, gid: 0,
    rdev: 0, blksize: 0, blocks: 0,
    atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0,
    atime: new Date(0), ctime: new Date(0), birthtime: new Date(0),
  };
}

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

// ── LocalFsObjectStore ────────────────────────────────────────────────────────

describe("LocalFsObjectStore", () => {
  let store: LocalFsObjectStore;
  const rootDir = "/mock-root";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(unlink).mockResolvedValue(undefined);
    vi.mocked(stat).mockResolvedValue(fileStat());
    vi.mocked(readdir).mockResolvedValue([] as any);
    vi.mocked(readFile).mockResolvedValue(Buffer.from("default"));
    store = new LocalFsObjectStore({ type: "local", rootDir });
  });

  // ── constructor ──────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("sets name to 'local-fs'", () => {
      expect(store.name).toBe("local-fs");
    });

    it("uses rootDir from config", async () => {
      await store.put("key.txt", Buffer.from("data"));
      expect(mkdir).toHaveBeenCalledWith(
        expect.stringContaining(rootDir), { recursive: true },
      );
    });

    it("uses custom rootDir when provided", async () => {
      const s = new LocalFsObjectStore({ type: "local", rootDir: "/custom" });
      await s.put("k.txt", Buffer.from("x"));
      expect(mkdir).toHaveBeenCalledWith(
        expect.stringContaining("/custom"), { recursive: true },
      );
    });
  });

  // ── put ──────────────────────────────────────────────────────────────────

  describe("put", () => {
    it("writes file content and returns metadata", async () => {
      const content = Buffer.from("hello world");
      const meta = await store.put("test.txt", content);

      expect(meta.key).toBe("test.txt");
      expect(meta.size).toBe(11);
      expect(meta.lastModified).toBeInstanceOf(Date);
      expect(mkdir).toHaveBeenCalledWith(expect.stringContaining("mock-root"), { recursive: true });
      expect(writeFile).toHaveBeenCalledWith(expect.stringContaining("test.txt"), content);
    });

    it("returns the correct contentType from options", async () => {
      const meta = await store.put("doc.pdf", Buffer.from("pdf"), {
        contentType: "application/pdf",
      });
      expect(meta.contentType).toBe("application/pdf");
    });

    it("stores custom metadata in metadata field", async () => {
      const meta = await store.put("img.png", Buffer.from("png"), {
        metadata: { author: "test", version: "1" },
      });
      expect(meta.metadata).toEqual({ author: "test", version: "1" });
    });

    it("persists cacheControl and contentDisposition in sidecar", async () => {
      await store.put("download.zip", Buffer.from("zip"), {
        cacheControl: "max-age=3600",
        contentDisposition: 'attachment; filename="file.zip"',
      });

      const metaCall = vi.mocked(writeFile).mock.calls.find(
        (c: any) => (c[0] as string).endsWith(".meta.json"),
      );
      expect(metaCall).toBeDefined();
      const parsed = JSON.parse(metaCall![1] as string);
      expect(parsed.cacheControl).toBe("max-age=3600");
      expect(parsed.contentDisposition).toBe('attachment; filename="file.zip"');
    });

    it("creates parent directories recursively", async () => {
      await store.put("deep/nested/path/file.txt", Buffer.from("deep"));
      expect(mkdir).toHaveBeenCalledWith(
        expect.stringContaining("deep/nested/path"), { recursive: true },
      );
    });

    it("writes metadata sidecar file", async () => {
      await store.put("key.txt", Buffer.from("data"), {
        contentType: "text/plain", metadata: { k: "v" },
      });

      const metaCall = vi.mocked(writeFile).mock.calls.find(
        (c: any) => (c[0] as string).endsWith(".meta.json"),
      );
      expect(metaCall).toBeDefined();
      const metaContent = JSON.parse(metaCall![1] as string);
      expect(metaContent.contentType).toBe("text/plain");
      expect(metaContent.metadata).toEqual({ k: "v" });
    });

    describe("overwrite option", () => {
      it("overwrites by default when file exists (stat succeeds)", async () => {
        vi.mocked(stat).mockResolvedValue(fileStat());
        const meta = await store.put("existing.txt", Buffer.from("new"));
        expect(meta.key).toBe("existing.txt");
      });

      it("throws ObjectAlreadyExistsError when overwrite=false and file exists", async () => {
        vi.mocked(stat).mockResolvedValue(fileStat());
        await expect(
          store.put("exists.txt", Buffer.from("new"), { overwrite: false }),
        ).rejects.toThrow(ObjectAlreadyExistsError);
      });

      it("proceeds when overwrite=false and file does not exist (ENOENT)", async () => {
        vi.mocked(stat).mockRejectedValue(enoentError());
        const meta = await store.put("new.txt", Buffer.from("data"), { overwrite: false });
        expect(meta.key).toBe("new.txt");
        expect(stat).toHaveBeenCalled();
        expect(writeFile).toHaveBeenCalled();
      });

      it("treats non-ENOENT stat errors as file-not-exists and proceeds", async () => {
        vi.mocked(stat).mockRejectedValue(epermError());
        const meta = await store.put("file.txt", Buffer.from("data"), { overwrite: false });
        expect(meta.key).toBe("file.txt");
        expect(writeFile).toHaveBeenCalled();
      });
    });
  });

  // ── get ──────────────────────────────────────────────────────────────────

  describe("get", () => {
    it("returns content and metadata for an existing file", async () => {
      const content = Buffer.from("hello world");
      const mtime = new Date("2026-01-15T00:00:00Z");

      let callCount = 0;
      vi.mocked(readFile).mockImplementation(((path: string, opts?: any) => {
        callCount++;
        const enc = typeof opts === "string" ? opts : opts?.encoding;
        if (enc === "utf-8" || enc === "utf8") {
          return Promise.resolve(JSON.stringify({ contentType: "text/plain", metadata: { key: "val" } }));
        }
        return Promise.resolve(content);
      }) as any);

      vi.mocked(stat).mockResolvedValue(fileStat(11, mtime));

      const result = await store.get("test.txt");
      expect(result.content.toString()).toBe("hello world");
      expect(result.metadata.key).toBe("test.txt");
      expect(result.metadata.size).toBe(11);
      expect(result.metadata.contentType).toBe("text/plain");
      expect(result.metadata.metadata).toEqual({ key: "val" });
    });

    it("throws ObjectNotFoundError when file does not exist (ENOENT)", async () => {
      vi.mocked(readFile).mockRejectedValue(enoentError());
      await expect(store.get("missing.txt")).rejects.toThrow(ObjectNotFoundError);
    });

    it("rethrows non-ENOENT errors from readFile", async () => {
      vi.mocked(readFile).mockRejectedValue(epermError());
      await expect(store.get("file.txt")).rejects.toThrow("EPERM");
    });

    it("rethrows non-ENOENT errors from stat", async () => {
      vi.mocked(readFile).mockResolvedValue(Buffer.from("content"));
      vi.mocked(stat).mockRejectedValue(epermError());
      await expect(store.get("file.txt")).rejects.toThrow("EPERM");
    });

    it("returns undefined contentType/metadata when meta read fails", async () => {
      vi.mocked(readFile).mockImplementation(((path: string, opts?: any) => {
        if (typeof opts === "string" ? opts : opts?.encoding) {
          return Promise.reject(new Error("meta read failure"));
        }
        return Promise.resolve(Buffer.from("content"));
      }) as any);

      const result = await store.get("file.txt");
      expect(result.metadata.contentType).toBeUndefined();
      expect(result.metadata.metadata).toBeUndefined();
    });

    it("handles invalid JSON in meta file gracefully", async () => {
      vi.mocked(readFile).mockImplementation(((path: string, opts?: any) => {
        if (typeof opts === "string" ? opts : opts?.encoding) {
          return Promise.resolve("not valid json {{{");
        }
        return Promise.resolve(Buffer.from("content"));
      }) as any);

      const result = await store.get("file.txt");
      expect(result.metadata.contentType).toBeUndefined();
    });

    it("filters out metadata field that is not a string record", async () => {
      vi.mocked(readFile).mockImplementation(((path: string, opts?: any) => {
        if (typeof opts === "string" ? opts : opts?.encoding) {
          return Promise.resolve(JSON.stringify({
            contentType: "text/plain",
            metadata: { a: 123, b: true },
          }));
        }
        return Promise.resolve(Buffer.from("content"));
      }) as any);

      const result = await store.get("file.txt");
      expect(result.metadata.contentType).toBe("text/plain");
      expect(result.metadata.metadata).toBeUndefined();
    });

    it("uses lastModified from file stat", async () => {
      const mtime = new Date("2025-06-01T12:00:00Z");
      vi.mocked(readFile).mockImplementation(((path: string, opts?: any) => {
        if (typeof opts === "string" ? opts : opts?.encoding) {
          return Promise.resolve(JSON.stringify({}));
        }
        return Promise.resolve(Buffer.from("data"));
      }) as any);
      vi.mocked(stat).mockResolvedValue(fileStat(4, mtime));

      const result = await store.get("file.txt");
      expect(result.metadata.lastModified).toEqual(mtime);
    });
  });

  // ── delete ───────────────────────────────────────────────────────────────

  describe("delete", () => {
    it("deletes the file and its metadata sidecar", async () => {
      await store.delete("file.txt");
      expect(unlink).toHaveBeenCalledWith(expect.stringContaining("file.txt"));
      expect(unlink).toHaveBeenCalledWith(expect.stringContaining("file.txt.meta.json"));
    });

    it("returns silently when file does not exist (ENOENT on unlink)", async () => {
      vi.mocked(unlink).mockRejectedValueOnce(enoentError());
      await expect(store.delete("missing.txt")).resolves.toBeUndefined();
      expect(unlink).toHaveBeenCalledTimes(1);
    });

    it("deletes file even if metadata sidecar is missing", async () => {
      vi.mocked(unlink)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("meta gone"));
      await expect(store.delete("file.txt")).resolves.toBeUndefined();
      expect(unlink).toHaveBeenCalledTimes(2);
    });

    it("rethrows non-ENOENT errors from unlink", async () => {
      vi.mocked(unlink).mockRejectedValue(epermError());
      await expect(store.delete("file.txt")).rejects.toThrow("EPERM");
    });
  });

  // ── deleteMany ───────────────────────────────────────────────────────────

  describe("deleteMany", () => {
    it("deletes multiple files in parallel", async () => {
      await store.deleteMany(["a.txt", "b.txt", "c.txt"]);
      expect(unlink).toHaveBeenCalledTimes(6);
    });

    it("handles empty array", async () => {
      await expect(store.deleteMany([])).resolves.toBeUndefined();
      expect(unlink).not.toHaveBeenCalled();
    });

    it("does not throw when some files are missing (ENOENT)", async () => {
      vi.mocked(unlink)
        .mockRejectedValueOnce(enoentError())
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);
      await expect(store.deleteMany(["a.txt", "b.txt"])).resolves.toBeUndefined();
    });
  });

  // ── list ─────────────────────────────────────────────────────────────────

  describe("list", () => {
    it("returns empty listing for an empty store", async () => {
      const result = await store.list();
      expect(result.objects).toEqual([]);
      expect(result.prefixes).toEqual([]);
      expect(result.isTruncated).toBe(false);
    });

    it("returns all objects sorted by key", async () => {
      vi.mocked(readdir).mockResolvedValue([
        dirent("c.txt", false), dirent("a.txt", false), dirent("b.txt", false),
      ] as any);
      vi.mocked(stat).mockResolvedValue(fileStat(50));

      const result = await store.list();
      expect(result.objects.map((o) => o.key)).toEqual(["a.txt", "b.txt", "c.txt"]);
    });

    it("skips .meta.json files", async () => {
      vi.mocked(readdir).mockResolvedValue([
        dirent("a.txt", false), dirent("a.txt.meta.json", false),
        dirent("b.txt", false), dirent("b.txt.meta.json", false),
      ] as any);

      const result = await store.list();
      expect(result.objects).toHaveLength(2);
      expect(result.objects.map((o) => o.key)).toEqual(["a.txt", "b.txt"]);
    });

    it("respects maxKeys limit", async () => {
      vi.mocked(readdir).mockResolvedValue([
        dirent("a.txt", false), dirent("b.txt", false), dirent("c.txt", false),
      ] as any);

      const result = await store.list({ maxKeys: 2 });
      expect(result.objects.length).toBeLessThanOrEqual(2);
    });

    it("filters by prefix", async () => {
      vi.mocked(readdir).mockImplementation(((dir: string) => {
        if (dir.includes("reports")) {
          return Promise.resolve([dirent("jan.txt", false), dirent("feb.txt", false)] as any);
        }
        return Promise.resolve([] as any);
      }) as any);

      const result = await store.list({ prefix: "reports/" });
      expect(result.objects).toHaveLength(2);
      expect(result.objects.every((o) => o.key.startsWith("reports/"))).toBe(true);
    });

    it("groups by delimiter", async () => {
      vi.mocked(readdir).mockImplementation(((dir: string) => {
        if (dir === rootDir) return Promise.resolve([dirent("a", true), dirent("b", true)] as any);
        if (dir.endsWith("/a")) return Promise.resolve([dirent("1.txt", false), dirent("2.txt", false)] as any);
        if (dir.endsWith("/b")) return Promise.resolve([dirent("3.txt", false)] as any);
        return Promise.resolve([] as any);
      }) as any);

      const result = await store.list({ delimiter: "/" });
      expect(result.prefixes).toContain("a/");
      expect(result.prefixes).toContain("b/");
      expect(result.objects).toHaveLength(0);
    });

    it("combines prefix and delimiter correctly", async () => {
      vi.mocked(readdir).mockImplementation(((dir: string) => {
        if (dir.includes("data") && !dir.includes("sub")) {
          return Promise.resolve([dirent("sub", true), dirent("root.txt", false)] as any);
        }
        if (dir.includes("data/sub")) {
          return Promise.resolve([dirent("nested.txt", false)] as any);
        }
        return Promise.resolve([] as any);
      }) as any);

      const result = await store.list({ prefix: "data/", delimiter: "/" });
      expect(result.prefixes).toContain("data/sub/");
      expect(result.objects.some((o) => o.key === "data/root.txt")).toBe(true);
    });

    it("returns empty listing when walkDir encounters ENOENT", async () => {
      vi.mocked(readdir).mockRejectedValue(enoentError());
      const result = await store.list({ prefix: "nonexistent/" });
      expect(result.objects).toEqual([]);
      expect(result.prefixes).toEqual([]);
    });

    it("rethrows non-ENOENT errors from walkDir", async () => {
      vi.mocked(readdir).mockRejectedValue(epermError());
      await expect(store.list({ prefix: "blocked/" })).rejects.toThrow("EPERM");
    });

    it("walks nested directories recursively", async () => {
      vi.mocked(readdir).mockImplementation(((dir: string) => {
        if (dir === rootDir) return Promise.resolve([dirent("nested", true)] as any);
        if (dir.endsWith("nested")) return Promise.resolve([dirent("deep", true), dirent("shallow.txt", false)] as any);
        if (dir.endsWith("deep")) return Promise.resolve([dirent("file.txt", false)] as any);
        return Promise.resolve([] as any);
      }) as any);

      const result = await store.list();
      expect(result.objects).toHaveLength(2);
      const keys = result.objects.map((o) => o.key).sort();
      expect(keys).toContain("nested/shallow.txt");
      expect(keys).toContain("nested/deep/file.txt");
    });

    it("creates sorted unique prefixes with delimiter", async () => {
      vi.mocked(readdir).mockImplementation(((dir: string) => {
        if (dir === rootDir) return Promise.resolve([dirent("x", true), dirent("y", true)] as any);
        if (dir.endsWith("/x")) return Promise.resolve([dirent("a.txt", false)] as any);
        if (dir.endsWith("/y")) return Promise.resolve([dirent("b.txt", false)] as any);
        return Promise.resolve([] as any);
      }) as any);

      const result = await store.list({ delimiter: "/" });
      expect(result.prefixes).toEqual(["x/", "y/"]);
    });

    it("includes root-level objects when delimiter is set", async () => {
      vi.mocked(readdir).mockResolvedValue([dirent("root.txt", false)] as any);
      const result = await store.list({ delimiter: "/" });
      expect(result.objects).toHaveLength(1);
      expect(result.objects[0].key).toBe("root.txt");
      expect(result.prefixes).toEqual([]);
    });
  });

  // ── exists ───────────────────────────────────────────────────────────────

  describe("exists", () => {
    it("returns true when file exists", async () => {
      expect(await store.exists("file.txt")).toBe(true);
    });

    it("returns false when file does not exist (ENOENT)", async () => {
      vi.mocked(stat).mockRejectedValue(enoentError());
      expect(await store.exists("missing.txt")).toBe(false);
    });

    it("rethrows non-ENOENT errors from stat", async () => {
      vi.mocked(stat).mockRejectedValue(epermError());
      await expect(store.exists("blocked.txt")).rejects.toThrow("EPERM");
    });

    it("rethrows non-Error values from stat (isNodeError returns false)", async () => {
      vi.mocked(stat).mockRejectedValue("string error");
      await expect(store.exists("key.txt")).rejects.toBe("string error");
    });
  });

  // ── head ─────────────────────────────────────────────────────────────────

  describe("head", () => {
    it("returns metadata without downloading file content", async () => {
      const mtime = new Date("2026-03-01T08:00:00Z");
      vi.mocked(stat).mockResolvedValue(fileStat(42, mtime));

      vi.mocked(readFile).mockImplementation(((path: string, opts?: any) => {
        if (typeof opts === "string" ? opts : opts?.encoding) {
          return Promise.resolve(JSON.stringify({ contentType: "image/png", metadata: { w: "100" } }));
        }
        return Promise.resolve(Buffer.from("data"));
      }) as any);

      const meta = await store.head("img.png");
      expect(meta.key).toBe("img.png");
      expect(meta.size).toBe(42);
      expect(meta.contentType).toBe("image/png");
      expect(meta.metadata).toEqual({ w: "100" });
      expect(meta.lastModified).toEqual(mtime);
    });

    it("throws ObjectNotFoundError when file missing", async () => {
      vi.mocked(stat).mockRejectedValue(enoentError());
      await expect(store.head("ghost.txt")).rejects.toThrow(ObjectNotFoundError);
    });

    it("rethrows non-ENOENT errors from stat", async () => {
      vi.mocked(stat).mockRejectedValue(epermError());
      await expect(store.head("file.txt")).rejects.toThrow("EPERM");
    });

    it("returns undefined contentType when meta file unavailable", async () => {
      vi.mocked(readFile).mockRejectedValue(new Error("no meta"));
      const meta = await store.head("file.txt");
      expect(meta.contentType).toBeUndefined();
      expect(meta.metadata).toBeUndefined();
    });
  });

  // ── presignUrl ───────────────────────────────────────────────────────────

  describe("presignUrl", () => {
    it("returns file:// URL for existing file", async () => {
      const url = await store.presignUrl("doc.pdf");
      expect(url).toMatch(/^file:\/\//);
      expect(url).toContain("doc.pdf");
      expect(url).toContain(rootDir);
    });

    it("throws ObjectNotFoundError when file missing", async () => {
      vi.mocked(stat).mockRejectedValue(enoentError());
      await expect(store.presignUrl("ghost.pdf")).rejects.toThrow(ObjectNotFoundError);
    });

    it("rethrows non-ENOENT errors from stat via exists", async () => {
      vi.mocked(stat).mockRejectedValue(epermError());
      await expect(store.presignUrl("blocked.pdf")).rejects.toThrow("EPERM");
    });
  });

  // ── close ────────────────────────────────────────────────────────────────

  describe("close", () => {
    it("resolves without error (no-op)", async () => {
      await expect(store.close()).resolves.toBeUndefined();
    });
  });

  // ── resolvePath behavior (tested via public API) ─────────────────────────

  describe("resolvePath", () => {
    it("normalizes backslashes to forward slashes", async () => {
      await store.put("sub\\file.txt", Buffer.from("data"));
      expect(vi.mocked(mkdir).mock.calls[0][0]).not.toContain("\\");
    });

    it("strips path traversal sequences (..)", async () => {
      await store.put("a/../b.txt", Buffer.from("data"));
      const writeCall = vi.mocked(writeFile).mock.calls.find(
        (c: any) => !(c[0] as string).endsWith(".meta.json"),
      );
      expect(writeCall).toBeDefined();
      expect(writeCall![0] as string).not.toContain("..");
    });

    it("joins key with rootDir", async () => {
      await store.put("data.csv", Buffer.from("csv"));
      expect(vi.mocked(writeFile).mock.calls[0][0]).toContain(rootDir);
      expect(vi.mocked(writeFile).mock.calls[0][0]).toContain("data.csv");
    });
  });
});

// ── createLocalFsStore ─────────────────────────────────────────────────────────

describe("createLocalFsStore", () => {
  it("creates a LocalFsObjectStore with the given rootDir", () => {
    const s = createLocalFsStore("/data");
    expect(s).toBeInstanceOf(LocalFsObjectStore);
    expect(s.name).toBe("local-fs");
  });

  it("creates stores with different rootDirs", () => {
    const s1 = createLocalFsStore("/dir1");
    const s2 = createLocalFsStore("/dir2");
    expect(s1).toBeInstanceOf(LocalFsObjectStore);
    expect(s2).toBeInstanceOf(LocalFsObjectStore);
  });
});

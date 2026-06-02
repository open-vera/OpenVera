/**
 * OssObjectStore unit tests — Alibaba OSS storage adapter
 *
 * Coverage targets:
 * - Constructor (with/without prefix)
 * - getClient (cache hit, first-time create, import failure)
 * - fullKey / stripPrefix (private helpers exercised via public API)
 * - put (basic, contentType, cacheControl, contentDisposition, metadata)
 * - get (success, ObjectNotFoundError, generic error rethrow)
 * - delete (success, not-found no-op, generic error rethrow)
 * - deleteMany (empty array, non-empty array)
 * - list (with prefix option, config prefix, delimiter, maxKeys,
 *   continuationToken, startAfter, empty result)
 * - exists (found, not-found, error rethrow)
 * - head (all fields, not-found, error rethrow)
 * - presignUrl (GET default, PUT, custom expires, default expires)
 * - close
 * - encodeMetadata / decodeMetadata (exercised via put/head)
 * - isOssNotFound (status 404, code NoSuchKey, non-error, generic)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OssObjectStore } from "../oss-adapter.js";
import {
  ObjectNotFoundError,
  ObjectStoreConnectionError,
} from "../object-store.js";
import type { OssConfig, PutOptions, ListOptions, PresignOptions } from "../object-store.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockPut = vi.fn();
const mockGet = vi.fn();
const mockHead = vi.fn();
const mockDelete = vi.fn();
const mockDeleteMulti = vi.fn();
const mockList = vi.fn();
const mockSignatureUrl = vi.fn();

const mockOssClass = vi.fn();

// Mock the dynamic import of ali-oss
vi.mock("ali-oss", () => ({
  default: mockOssClass,
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<OssConfig>): OssConfig {
  return {
    type: "oss",
    accessKeyId: "test-access-key",
    accessKeySecret: "test-secret",
    bucket: "test-bucket",
    endpoint: "oss-cn-hangzhou.aliyuncs.com",
    ...overrides,
  };
}

function makeOSSNotFound(statusOrCode: "status" | "code" = "code"): Error {
  if (statusOrCode === "status") {
    return Object.assign(new Error("Not Found"), { status: 404 });
  }
  return Object.assign(new Error("NoSuchKey"), { code: "NoSuchKey" });
}

function makeGenericError(): Error {
  return new Error("Network failure");
}

function createClient() {
  return {
    put: mockPut,
    get: mockGet,
    head: mockHead,
    delete: mockDelete,
    deleteMulti: mockDeleteMulti,
    list: mockList,
    signatureUrl: mockSignatureUrl,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("OssObjectStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: construct a client with all the mock methods
    mockOssClass.mockImplementation(function () { return createClient(); });

    // Default successful responses
    mockPut.mockResolvedValue({
      name: "test-key",
      url: "https://example.com/test-key",
      res: { status: 200, headers: { etag: '"abc123"' } },
    });

    mockGet.mockResolvedValue({
      content: Buffer.from("hello world"),
      res: { headers: { etag: '"abc123"', "content-type": "text/plain" } },
    });

    mockHead.mockResolvedValue({
      res: {
        status: 200,
        headers: {
          etag: '"abc123"',
          "content-type": "text/plain",
          "content-length": "11",
          "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT",
        },
        meta: {},
      },
    });

    mockDelete.mockResolvedValue(undefined);
    mockDeleteMulti.mockResolvedValue(undefined);
    mockList.mockResolvedValue({
      objects: [],
      prefixes: [],
      isTruncated: false,
    });
    mockSignatureUrl.mockReturnValue("https://signed.example.com/test-key");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Constructor ─────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("should set name to 'oss'", () => {
      const store = new OssObjectStore(makeConfig());
      expect(store.name).toBe("oss");
    });

    it("should use the provided prefix", async () => {
      const store = new OssObjectStore(makeConfig({ prefix: "app" }));

      await store.delete("x"); // triggers fullKey internally

      const OSS = mockOssClass;
      expect(OSS).not.toHaveBeenCalledWith(
        expect.objectContaining({ prefix: "app" }),
      );
      // prefix is only used in fullKey, not passed to OSS constructor
    });

    it("should default prefix to empty string", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.delete("plain-key");
      expect(mockDelete).toHaveBeenCalledWith("plain-key");
    });
  });

  // ── getClient (via public methods) ───────────────────────────────────────

  describe("client lazy initialization", () => {
    it("should create client on first usage", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.delete("key1");

      const OSS = mockOssClass;
      expect(OSS).toHaveBeenCalledOnce();
      expect(OSS).toHaveBeenCalledWith({
        accessKeyId: "test-access-key",
        accessKeySecret: "test-secret",
        bucket: "test-bucket",
        endpoint: "oss-cn-hangzhou.aliyuncs.com",
        secure: true,
      });
    });

    it("should reuse cached client on subsequent calls", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.delete("key1");
      await store.delete("key2");

      const OSS = mockOssClass;
      expect(OSS).toHaveBeenCalledOnce();
    });

    it("should respect secure:false config", async () => {
      const store = new OssObjectStore(makeConfig({ secure: false }));

      await store.delete("key1");

      const OSS = mockOssClass;
      expect(OSS).toHaveBeenCalledWith(
        expect.objectContaining({ secure: false }),
      );
    });

    it("should default secure to true when not specified", async () => {
      const { secure: _, ...cfg } = makeConfig();
      const store = new OssObjectStore(cfg);

      await store.delete("key1");

      const OSS = mockOssClass;
      expect(OSS).toHaveBeenCalledWith(
        expect.objectContaining({ secure: true }),
      );
    });
  });

  describe("getClient import failure", () => {
    it("should throw ObjectStoreConnectionError when OSS constructor throws", async () => {
      // Override implementation to throw inside the constructor.
      // The catch{} block in getClient catches ALL errors (import failure
      // and constructor failure) and wraps them as ObjectStoreConnectionError.
      mockOssClass.mockImplementation(function () {
        throw new Error("Connection refused");
      });

      const store = new OssObjectStore(makeConfig());
      await expect(store.delete("key1")).rejects.toThrow(
        ObjectStoreConnectionError,
      );
      await expect(store.delete("key1")).rejects.toThrow(
        /ali-oss/,
      );
    });
  });

  // ── fullKey / stripPrefix ────────────────────────────────────────────────

  describe("key prefixing (fullKey / stripPrefix)", () => {
    it("should prepend prefix to keys in put", async () => {
      const store = new OssObjectStore(makeConfig({ prefix: "app" }));

      await store.put("file.txt", Buffer.from("data"));
      expect(mockPut).toHaveBeenCalledWith(
        "app/file.txt",
        expect.any(Buffer),
        expect.any(Object),
      );
    });

    it("should not modify keys when no prefix is set", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.put("file.txt", Buffer.from("data"));
      expect(mockPut).toHaveBeenCalledWith(
        "file.txt",
        expect.any(Buffer),
        expect.any(Object),
      );
    });

    it("should strip prefix from listed objects' keys", async () => {
      const store = new OssObjectStore(makeConfig({ prefix: "app" }));

      mockList.mockResolvedValue({
        objects: [
          { name: "app/photo.jpg", size: 1024, etag: '"x1"', lastModified: "2024-01-01" },
          { name: "app/docs/report.pdf", size: 2048, etag: '"x2"', lastModified: "2024-01-02" },
        ],
        prefixes: ["app/images/"],
        isTruncated: false,
      });

      const result = await store.list();
      expect(result.objects[0]!.key).toBe("photo.jpg");
      expect(result.objects[1]!.key).toBe("docs/report.pdf");
      expect(result.prefixes[0]).toBe("images/");
    });

    it("should not strip prefix when key does not start with prefix", async () => {
      const store = new OssObjectStore(makeConfig({ prefix: "app" }));

      mockList.mockResolvedValue({
        objects: [
          { name: "other/file.txt", size: 100, etag: '"y1"', lastModified: "2024-01-01" },
        ],
        prefixes: [],
        isTruncated: false,
      });

      const result = await store.list();
      expect(result.objects[0]!.key).toBe("other/file.txt");
    });
  });

  // ── put ──────────────────────────────────────────────────────────────────

  describe("put", () => {
    it("should upload content and return metadata", async () => {
      const store = new OssObjectStore(makeConfig());
      const content = Buffer.from("hello oss");

      const result = await store.put("test.txt", content);

      expect(mockPut).toHaveBeenCalledWith(
        "test.txt",
        expect.any(Buffer),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/octet-stream",
          }),
        }),
      );

      expect(result.key).toBe("test.txt");
      expect(result.size).toBe(9);
      expect(result.etag).toBe('"abc123"');
    });

    it("should use specified contentType", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.put("image.png", Buffer.from("data"), { contentType: "image/png" });

      expect(mockPut).toHaveBeenCalledWith(
        "image.png",
        expect.any(Buffer),
        expect.objectContaining({
          headers: expect.objectContaining({ "Content-Type": "image/png" }),
        }),
      );
    });

    it("should include Cache-Control header when specified", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.put("file.js", Buffer.from("code"), {
        cacheControl: "max-age=3600",
      });

      expect(mockPut).toHaveBeenCalledWith(
        "file.js",
        expect.any(Buffer),
        expect.objectContaining({
          headers: expect.objectContaining({ "Cache-Control": "max-age=3600" }),
        }),
      );
    });

    it("should include Content-Disposition header when specified", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.put("report.pdf", Buffer.from("pdf-data"), {
        contentDisposition: 'attachment; filename="report.pdf"',
      });

      expect(mockPut).toHaveBeenCalledWith(
        "report.pdf",
        expect.any(Buffer),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Disposition": 'attachment; filename="report.pdf"',
          }),
        }),
      );
    });

    it("should encode custom metadata with x-oss-meta- prefix", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.put("data.bin", Buffer.from("binary"), {
        metadata: { author: "test-user", version: "1.0" },
      });

      expect(mockPut).toHaveBeenCalledWith(
        "data.bin",
        expect.any(Buffer),
        expect.objectContaining({
          headers: expect.objectContaining({
            "x-oss-meta-author": "test-user",
            "x-oss-meta-version": "1.0",
          }),
        }),
      );
    });

    it("should omit x-oss-meta- headers when no metadata", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.put("clean.txt", Buffer.from("data"));

      const callHeaders = mockPut.mock.calls[0]![2]!.headers;
      const metaKeys = Object.keys(callHeaders).filter((k: string) =>
        k.startsWith("x-oss-meta-"),
      );
      expect(metaKeys).toHaveLength(0);
    });

    it("should include all optional fields together", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.put("full.txt", Buffer.from("data"), {
        contentType: "text/markdown",
        cacheControl: "no-cache",
        contentDisposition: "inline",
        metadata: { source: "generated" },
      });

      expect(mockPut).toHaveBeenCalledWith(
        "full.txt",
        expect.any(Buffer),
        expect.objectContaining({
          headers: {
            "Content-Type": "text/markdown",
            "Cache-Control": "no-cache",
            "Content-Disposition": "inline",
            "x-oss-meta-source": "generated",
          },
        }),
      );
    });

    it("should return metadata without contentType when not specified", async () => {
      const store = new OssObjectStore(makeConfig());
      const result = await store.put("key", Buffer.from("abc"));
      expect(result.contentType).toBeUndefined();
    });

    it("should return metadata with contentType when specified", async () => {
      const store = new OssObjectStore(makeConfig());
      const result = await store.put("key", Buffer.from("abc"), {
        contentType: "text/csv",
      });
      expect(result.contentType).toBe("text/csv");
    });

    it("should return user metadata in result", async () => {
      const store = new OssObjectStore(makeConfig());
      const result = await store.put("key", Buffer.from("abc"), {
        metadata: { foo: "bar" },
      });
      expect(result.metadata).toEqual({ foo: "bar" });
    });

    it("should return a Date for lastModified", async () => {
      const store = new OssObjectStore(makeConfig());
      const result = await store.put("key", Buffer.from("x"));
      expect(result.lastModified).toBeInstanceOf(Date);
    });
  });

  // ── get ──────────────────────────────────────────────────────────────────

  describe("get", () => {
    it("should download content as Buffer", async () => {
      const store = new OssObjectStore(makeConfig());
      mockGet.mockResolvedValue({
        content: Buffer.from("downloaded content"),
        res: { headers: { etag: '"tag1"' } },
      });

      const result = await store.get("file.txt");

      expect(result.content).toEqual(Buffer.from("downloaded content"));
      expect(result.metadata).toBeDefined();
    });

    it("should call head to get metadata as part of get", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.get("file.txt");

      // get calls head() internally
      expect(mockHead).toHaveBeenCalledWith("file.txt");
    });

    it("should throw ObjectNotFoundError when object does not exist (status 404)", async () => {
      const store = new OssObjectStore(makeConfig());
      mockGet.mockRejectedValue(makeOSSNotFound("status"));

      await expect(store.get("missing.txt")).rejects.toThrow(
        ObjectNotFoundError,
      );
      await expect(store.get("missing.txt")).rejects.toThrow(
        "Object not found: missing.txt",
      );
    });

    it("should throw ObjectNotFoundError when object does not exist (code NoSuchKey)", async () => {
      const store = new OssObjectStore(makeConfig());
      mockGet.mockRejectedValue(makeOSSNotFound("code"));

      await expect(store.get("missing.txt")).rejects.toThrow(
        ObjectNotFoundError,
      );
    });

    it("should rethrow non-404 errors", async () => {
      const store = new OssObjectStore(makeConfig());
      const err = makeGenericError();
      mockGet.mockRejectedValue(err);

      await expect(store.get("file.txt")).rejects.toThrow("Network failure");
    });
  });

  // ── delete ───────────────────────────────────────────────────────────────

  describe("delete", () => {
    it("should call client.delete with the full key", async () => {
      const store = new OssObjectStore(makeConfig({ prefix: "data" }));

      await store.delete("temp.txt");

      expect(mockDelete).toHaveBeenCalledWith("data/temp.txt");
    });

    it("should return void on successful delete", async () => {
      const store = new OssObjectStore(makeConfig());

      const result = await store.delete("temp.txt");
      expect(result).toBeUndefined();
    });

    it("should silently ignore not-found errors (status 404)", async () => {
      const store = new OssObjectStore(makeConfig());
      mockDelete.mockRejectedValue(makeOSSNotFound("status"));

      // Should not throw
      await expect(store.delete("missing.txt")).resolves.toBeUndefined();
    });

    it("should silently ignore not-found errors (code NoSuchKey)", async () => {
      const store = new OssObjectStore(makeConfig());
      mockDelete.mockRejectedValue(makeOSSNotFound("code"));

      await expect(store.delete("missing.txt")).resolves.toBeUndefined();
    });

    it("should rethrow non-404 errors on delete", async () => {
      const store = new OssObjectStore(makeConfig());
      mockDelete.mockRejectedValue(makeGenericError());

      await expect(store.delete("file.txt")).rejects.toThrow(
        "Network failure",
      );
    });
  });

  // ── deleteMany ───────────────────────────────────────────────────────────

  describe("deleteMany", () => {
    it("should call deleteMulti with full keys", async () => {
      const store = new OssObjectStore(makeConfig({ prefix: "app" }));

      await store.deleteMany(["a.txt", "b.txt"]);

      expect(mockDeleteMulti).toHaveBeenCalledWith(
        ["app/a.txt", "app/b.txt"],
        { quiet: true },
      );
    });

    it("should use quiet:true to suppress individual errors", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.deleteMany(["x"]);
      expect(mockDeleteMulti).toHaveBeenCalledWith(["x"], { quiet: true });
    });

    it("should do nothing for empty keys array", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.deleteMany([]);

      expect(mockDeleteMulti).not.toHaveBeenCalled();
    });

    it("should not call getClient for empty array", async () => {
      const store = new OssObjectStore(makeConfig());

      // First call to establish client
      await store.delete("warm");
      expect(mockDelete).toHaveBeenCalledOnce();
      vi.clearAllMocks();

      // deleteMany with empty array — should NOT call anything
      await store.deleteMany([]);
      expect(mockDelete).not.toHaveBeenCalled();
      expect(mockDeleteMulti).not.toHaveBeenCalled();
    });

    it("should handle large batch of keys", async () => {
      const store = new OssObjectStore(makeConfig());
      const keys = Array.from({ length: 100 }, (_, i) => `file-${i}.txt`);

      await store.deleteMany(keys);

      expect(mockDeleteMulti).toHaveBeenCalledWith(
        keys,
        { quiet: true },
      );
    });
  });

  // ── list ─────────────────────────────────────────────────────────────────

  describe("list", () => {
    it("should list objects with default options", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.list();

      expect(mockList).toHaveBeenCalledWith({
        prefix: "",
        delimiter: undefined,
        "max-keys": 1000,
        marker: "",
      });
    });

    it("should use config prefix in list when no option prefix", async () => {
      const store = new OssObjectStore(makeConfig({ prefix: "app" }));

      await store.list();

      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ prefix: "app/" }),
      );
    });

    it("should combine config prefix with option prefix", async () => {
      const store = new OssObjectStore(makeConfig({ prefix: "app" }));

      await store.list({ prefix: "images" });

      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ prefix: "app/images" }),
      );
    });

    it("should use option prefix alone when no config prefix", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.list({ prefix: "logs" });

      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ prefix: "logs" }),
      );
    });

    it("should pass through delimiter option", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.list({ delimiter: "/" });

      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ delimiter: "/" }),
      );
    });

    it("should use custom maxKeys", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.list({ maxKeys: 50 });

      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ "max-keys": 50 }),
      );
    });

    it("should default maxKeys to 1000", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.list();

      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ "max-keys": 1000 }),
      );
    });

    it("should use continuationToken as marker", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.list({ continuationToken: "token-abc" });

      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ marker: "token-abc" }),
      );
    });

    it("should use startAfter as marker when no continuationToken", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.list({ startAfter: "file-50.txt" });

      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ marker: "file-50.txt" }),
      );
    });

    it("should prefer continuationToken over startAfter", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.list({
        continuationToken: "ct-token",
        startAfter: "ignored-key",
      });

      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ marker: "ct-token" }),
      );
    });

    it("should return mapped objects with stripped keys", async () => {
      const store = new OssObjectStore(makeConfig());
      mockList.mockResolvedValue({
        objects: [
          {
            name: "report-2024.pdf",
            size: 4096,
            etag: '"etag1"',
            lastModified: "2024-06-01T12:00:00.000Z",
          },
        ],
        prefixes: [],
        isTruncated: false,
      });

      const result = await store.list();

      expect(result.objects).toHaveLength(1);
      expect(result.objects[0]!.key).toBe("report-2024.pdf");
      expect(result.objects[0]!.size).toBe(4096);
      expect(result.objects[0]!.etag).toBe('"etag1"');
      expect(result.objects[0]!.lastModified).toBeInstanceOf(Date);
    });

    it("should return prefixes", async () => {
      const store = new OssObjectStore(makeConfig());
      mockList.mockResolvedValue({
        objects: [],
        prefixes: ["photos/", "docs/"],
        isTruncated: false,
      });

      const result = await store.list({ delimiter: "/" });

      expect(result.prefixes).toEqual(["photos/", "docs/"]);
    });

    it("should return isTruncated and continuationToken", async () => {
      const store = new OssObjectStore(makeConfig());
      mockList.mockResolvedValue({
        objects: [],
        prefixes: [],
        isTruncated: true,
        nextMarker: "page2-marker",
      });

      const result = await store.list();

      expect(result.isTruncated).toBe(true);
      expect(result.continuationToken).toBe("page2-marker");
    });

    it("should handle null objects and prefixes in response", async () => {
      const store = new OssObjectStore(makeConfig());
      mockList.mockResolvedValue({
        // objects and prefixes missing from response
        isTruncated: false,
      });

      const result = await store.list();

      expect(result.objects).toEqual([]);
      expect(result.prefixes).toEqual([]);
    });

    it("should handle empty prefix in config (no trailing slash added)", async () => {
      const store = new OssObjectStore(makeConfig());
      // No prefix in config

      await store.list();
      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ prefix: "" }),
      );
    });
  });

  // ── exists ───────────────────────────────────────────────────────────────

  describe("exists", () => {
    it("should return true when head succeeds", async () => {
      const store = new OssObjectStore(makeConfig());

      const exists = await store.exists("real-file.txt");

      expect(exists).toBe(true);
      expect(mockHead).toHaveBeenCalledWith("real-file.txt");
    });

    it("should return false when head throws ObjectNotFoundError", async () => {
      const store = new OssObjectStore(makeConfig());
      mockHead.mockRejectedValue(makeOSSNotFound("code"));

      const exists = await store.exists("missing.txt");

      expect(exists).toBe(false);
    });

    it("should rethrow non-not-found errors", async () => {
      const store = new OssObjectStore(makeConfig());
      mockHead.mockRejectedValue(makeGenericError());

      await expect(store.exists("file.txt")).rejects.toThrow(
        "Network failure",
      );
    });

    it("should catch ObjectNotFoundError (not generic ObjectStoreError)", async () => {
      const store = new OssObjectStore(makeConfig());
      // A generic non-ObjectNotFoundError should be rethrown
      mockHead.mockRejectedValue(new Error("Any other error"));

      await expect(store.exists("file.txt")).rejects.toThrow(
        "Any other error",
      );
    });
  });

  // ── head ─────────────────────────────────────────────────────────────────

  describe("head", () => {
    it("should return metadata without downloading content", async () => {
      const store = new OssObjectStore(makeConfig());

      const meta = await store.head("file.txt");

      expect(mockHead).toHaveBeenCalledWith("file.txt");
      expect(meta.key).toBe("file.txt");
      expect(meta.size).toBe(11);
      expect(meta.contentType).toBe("text/plain");
      expect(meta.etag).toBe('"abc123"');
      expect(meta.lastModified).toBeInstanceOf(Date);
    });

    it("should throw ObjectNotFoundError for missing object", async () => {
      const store = new OssObjectStore(makeConfig());
      mockHead.mockRejectedValue(makeOSSNotFound("status"));

      await expect(store.head("missing.txt")).rejects.toThrow(
        ObjectNotFoundError,
      );
    });

    it("should rethrow non-404 errors", async () => {
      const store = new OssObjectStore(makeConfig());
      mockHead.mockRejectedValue(makeGenericError());

      await expect(store.head("file.txt")).rejects.toThrow("Network failure");
    });

    it("should handle missing content-length header", async () => {
      const store = new OssObjectStore(makeConfig());
      mockHead.mockResolvedValue({
        res: {
          status: 200,
          headers: {
            etag: '"tag"',
            "content-type": "application/json",
          },
          meta: {},
        },
      });

      const meta = await store.head("file.json");
      expect(meta.size).toBe(0); // parseInt("0", 10)
    });

    it("should handle missing last-modified header", async () => {
      const store = new OssObjectStore(makeConfig());
      mockHead.mockResolvedValue({
        res: {
          status: 200,
          headers: {
            etag: '"tag"',
            "content-type": "text/html",
            "content-length": "42",
          },
          meta: {},
        },
      });

      const meta = await store.head("file.html");
      expect(meta.lastModified).toBeUndefined();
    });

    it("should decode OSS custom metadata headers", async () => {
      const store = new OssObjectStore(makeConfig());
      mockHead.mockResolvedValue({
        res: {
          status: 200,
          headers: {
            etag: '"tag"',
            "content-type": "binary",
            "content-length": "100",
          },
          meta: {
            "x-oss-meta-creator": "alice",
            "x-oss-meta-version": "2",
          },
        },
      });

      const meta = await store.head("data.bin");
      expect(meta.metadata).toEqual({
        creator: "alice",
        version: "2",
      });
    });

    it("should filter out non-x-oss-meta keys from metadata", async () => {
      const store = new OssObjectStore(makeConfig());
      mockHead.mockResolvedValue({
        res: {
          status: 200,
          headers: {
            etag: '"tag"',
            "content-type": "text/plain",
            "content-length": "5",
          },
          meta: {
            "x-oss-meta-key1": "val1",
            "other-header": "should-not-appear",
            "x-oss-meta-key2": "val2",
          },
        },
      });

      const meta = await store.head("file.txt");
      expect(meta.metadata).toEqual({
        key1: "val1",
        key2: "val2",
      });
    });
  });

  // ── presignUrl ───────────────────────────────────────────────────────────

  describe("presignUrl", () => {
    it("should generate a presigned GET URL by default", async () => {
      const store = new OssObjectStore(makeConfig());

      const url = await store.presignUrl("file.pdf");

      expect(mockSignatureUrl).toHaveBeenCalledWith("file.pdf", {
        expires: 3600,
        method: "get",
      });
      expect(url).toBe("https://signed.example.com/test-key");
    });

    it("should generate a presigned PUT URL", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.presignUrl("upload.bin", { method: "PUT" });

      expect(mockSignatureUrl).toHaveBeenCalledWith("upload.bin", {
        expires: 3600,
        method: "put",
      });
    });

    it("should use custom expiry", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.presignUrl("file.pdf", { expiresIn: 7200 });

      expect(mockSignatureUrl).toHaveBeenCalledWith("file.pdf", {
        expires: 7200,
        method: "get",
      });
    });

    it("should combine method and expiry options", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.presignUrl("data.csv", {
        method: "PUT",
        expiresIn: 1800,
      });

      expect(mockSignatureUrl).toHaveBeenCalledWith("data.csv", {
        expires: 1800,
        method: "put",
      });
    });

    it("should default expires to 3600 when not specified", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.presignUrl("key", {});

      expect(mockSignatureUrl).toHaveBeenCalledWith("key", {
        expires: 3600,
        method: "get",
      });
    });

    it("should use config prefix in presigned URL key", async () => {
      const store = new OssObjectStore(makeConfig({ prefix: "private" }));

      await store.presignUrl("secret.pdf");

      expect(mockSignatureUrl).toHaveBeenCalledWith("private/secret.pdf", expect.any(Object));
    });

    it("should default method to 'get' for undefined options", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.presignUrl("file.txt");

      expect(mockSignatureUrl).toHaveBeenCalledWith(expect.any(String), {
        expires: 3600,
        method: "get",
      });
    });

    it("should default method to 'get' when method is 'GET'", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.presignUrl("file.txt", { method: "GET" });

      expect(mockSignatureUrl).toHaveBeenCalledWith(expect.any(String), {
        expires: 3600,
        method: "get",
      });
    });
  });

  // ── close ─────────────────────────────────────────────────────────────────

  describe("close", () => {
    it("should release the client reference", async () => {
      const store = new OssObjectStore(makeConfig());

      // Create client first
      await store.put("key", Buffer.from("data"));

      // Close — sets client to null
      await store.close();

      // After close, a new client should be created on next operation
      vi.clearAllMocks();
      await store.put("key2", Buffer.from("data2"));

      // Should have re-created the client (dynamic import called again)
      const OSS = mockOssClass;
      expect(OSS).toHaveBeenCalledOnce();
    });

    it("should be idempotent — calling close multiple times", async () => {
      const store = new OssObjectStore(makeConfig());

      await store.close();
      await store.close();

      // No error thrown, clean shutdown
    });
  });

  // ── isOssNotFound (via public methods) ───────────────────────────────────

  describe("isOssNotFound edge cases", () => {
    it("should treat status 404 as not-found in get", async () => {
      const store = new OssObjectStore(makeConfig());
      mockGet.mockRejectedValue({ status: 404, message: "Not Found" });

      await expect(store.get("x")).rejects.toThrow(ObjectNotFoundError);
    });

    it("should treat code NoSuchKey as not-found in get", async () => {
      const store = new OssObjectStore(makeConfig());
      mockGet.mockRejectedValue({ code: "NoSuchKey", message: "No such key" });

      await expect(store.get("x")).rejects.toThrow(ObjectNotFoundError);
    });

    it("should rethrow error with unknown code", async () => {
      const store = new OssObjectStore(makeConfig());
      mockGet.mockRejectedValue({ code: "AccessDenied", message: "Denied" });

      await expect(store.get("x")).rejects.toThrow("Denied");
    });

    it("should treat null error as not a not-found", async () => {
      const store = new OssObjectStore(makeConfig());
      // null is falsy so isOssNotFound returns false, rethrows null
      // get wraps in try/catch — null won't match ObjectNotFoundError
      // So the catch rethrows null. Let's verify behavior:
      mockGet.mockRejectedValue(null);

      // The catch in get: if (isOssNotFound(err)) throw ObjectNotFoundError, else throw err
      // null && typeof null === "object" → false, "status" in null → TypeError
      // Actually: "status" in null throws TypeError in strict mode
      await expect(store.get("x")).rejects.toBeNull();
    });
  });

  // ── Uint8Array support ───────────────────────────────────────────────────

  describe("Uint8Array content", () => {
    it("should accept Uint8Array as content for put", async () => {
      const store = new OssObjectStore(makeConfig());
      const content = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"

      const result = await store.put("hello.bin", content);

      expect(result.size).toBe(5);
      expect(mockPut).toHaveBeenCalledWith(
        "hello.bin",
        expect.any(Buffer),
        expect.any(Object),
      );
    });
  });

  // ── Integration-style scenarios ──────────────────────────────────────────

  describe("complex workflows", () => {
    it("should handle put → exists → get → delete lifecycle", async () => {
      const store = new OssObjectStore(makeConfig());

      // put
      const putResult = await store.put("lifecycle.txt", Buffer.from("test"));
      expect(putResult.key).toBe("lifecycle.txt");

      // exists
      mockHead.mockResolvedValue({
        res: {
          status: 200,
          headers: { "content-length": "4", "content-type": "text/plain" },
          meta: {},
        },
      });
      const exists = await store.exists("lifecycle.txt");
      expect(exists).toBe(true);

      // get
      mockGet.mockResolvedValue({
        content: Buffer.from("test"),
        res: { headers: {} },
      });
      const getResult = await store.get("lifecycle.txt");
      expect(getResult.content.toString()).toBe("test");

      // delete
      await store.delete("lifecycle.txt");
      expect(mockDelete).toHaveBeenCalledWith("lifecycle.txt");
    });

    it("should reuse client across sequential operations", async () => {
      const store = new OssObjectStore(makeConfig());

      // Sequential operations all reuse the same client
      const r1 = await store.put("a.txt", Buffer.from("a"));
      const r2 = await store.put("b.txt", Buffer.from("bb"));
      const r3 = await store.put("c.txt", Buffer.from("ccc"));

      expect(r1.key).toBe("a.txt");
      expect(r2.key).toBe("b.txt");
      expect(r3.key).toBe("c.txt");

      // All should reuse the same client
      expect(mockOssClass).toHaveBeenCalledOnce();
    });

    it("should handle list with full config prefix and option prefix chain", async () => {
      const store = new OssObjectStore(makeConfig({ prefix: "prod" }));

      await store.list({ prefix: "2024", delimiter: "/", maxKeys: 10 });

      expect(mockList).toHaveBeenCalledWith({
        prefix: "prod/2024",
        delimiter: "/",
        "max-keys": 10,
        marker: "",
      });
    });

    it("should handle presign then upload workflow", async () => {
      const store = new OssObjectStore(makeConfig());

      // Generate upload URL
      const uploadUrl = await store.presignUrl("upload.dat", {
        method: "PUT",
        expiresIn: 600,
      });

      expect(uploadUrl).toBe("https://signed.example.com/test-key");

      // Also upload via put
      await store.put("upload.dat", Buffer.from("content"), {
        contentType: "application/octet-stream",
      });
      expect(mockPut).toHaveBeenCalled();
    });

    it("should handle no prefix and no options at all", async () => {
      const store = new OssObjectStore(makeConfig());

      // list with no args
      await store.list();
      expect(mockList).toHaveBeenCalledWith({
        prefix: "",
        delimiter: undefined,
        "max-keys": 1000,
        marker: "",
      });

      // presignUrl with no options
      await store.presignUrl("key");
      expect(mockSignatureUrl).toHaveBeenCalledWith("key", {
        expires: 3600,
        method: "get",
      });

      // put with no options
      await store.put("key", Buffer.from("x"));
      expect(mockPut).toHaveBeenCalledWith(
        "key",
        expect.any(Buffer),
        expect.objectContaining({
          headers: { "Content-Type": "application/octet-stream" },
        }),
      );
    });
  });
});

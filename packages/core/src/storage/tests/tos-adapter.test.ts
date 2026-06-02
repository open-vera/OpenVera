/**
 * TOS Object Store Adapter — Unit Tests
 *
 * Mocks the `tos-sdk` module via vi.mock() to control the dynamic import
 * inside TosObjectStore.getClient(). All branches are covered.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { TosObjectStore } from "../tos-adapter.js";
import { ObjectStoreConnectionError, ObjectNotFoundError } from "../object-store.js";
import type { TosConfig } from "../object-store.js";

// ── Mock functions ───────────────────────────────────────────────────────────
//
// These are declared at module scope so vi.mock can capture them (vi.mock is
// hoisted). We NEVER reassign these variables in beforeEach — we only call
// .mockReset(), .mockResolvedValue(), or .mockImplementation() on them.

const mockPutObject = vi.fn();
const mockGetObject = vi.fn();
const mockDeleteObject = vi.fn();
const mockListObjects = vi.fn();
const mockHeadObject = vi.fn();
const mockGetPreSignedUrl = vi.fn();

function createClient() {
  return {
    putObject: mockPutObject,
    getObject: mockGetObject,
    deleteObject: mockDeleteObject,
    listObjects: mockListObjects,
    headObject: mockHeadObject,
    getPreSignedUrl: mockGetPreSignedUrl,
  };
}

const mockTosConstructor = vi.fn(function () {
  return createClient();
});

vi.mock("tos-sdk", () => ({
  default: mockTosConstructor,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function createConfig(overrides?: Partial<TosConfig>): TosConfig {
  return {
    type: "tos",
    secretId: "test-secret-id",
    secretKey: "test-secret-key",
    bucket: "test-bucket",
    region: "ap-guangzhou",
    ...overrides,
  };
}

function tosNotFoundByStatus(): Error & { statusCode: number } {
  const err = new Error("Not Found") as Error & { statusCode: number };
  err.statusCode = 404;
  return err;
}

function tosNotFoundByCode(): Error & { code: string } {
  const err = new Error("NoSuchKey") as Error & { code: string };
  err.code = "NoSuchKey";
  return err;
}

describe("TosObjectStore", () => {
  beforeEach(() => {
    // Reset all mocks to their default state. We use mockReset() (not just
    // mockClear()) to drop any test-specific rejections/implementations.
    // But we re-apply default implementations right after.
    mockPutObject.mockReset();
    mockGetObject.mockReset();
    mockDeleteObject.mockReset();
    mockListObjects.mockReset();
    mockHeadObject.mockReset();
    mockGetPreSignedUrl.mockReset();
    mockTosConstructor.mockReset();

    // Default: TOS constructor returns a working client
    mockTosConstructor.mockImplementation(function () {
      return createClient();
    });

    // Default: all client methods resolve successfully
    mockPutObject.mockResolvedValue(undefined);
    mockGetObject.mockResolvedValue({ data: Buffer.from("ok") });
    mockDeleteObject.mockResolvedValue(undefined);
    mockListObjects.mockResolvedValue({
      contents: [],
      commonPrefixes: [],
      isTruncated: false,
    });
    mockHeadObject.mockResolvedValue({ headers: { "content-length": "3" } });
    mockGetPreSignedUrl.mockResolvedValue("https://presigned.test.url");
  });

  // ── Constructor ──────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("stores config and sets empty prefix when none provided", () => {
      const store = new TosObjectStore(createConfig({ prefix: undefined }));
      expect(store).toBeDefined();
      expect(store.name).toBe("tos");
    });

    it("stores config and sets prefix when provided", () => {
      const store = new TosObjectStore(createConfig({ prefix: "myapp" }));
      expect(store).toBeDefined();
      expect(store.name).toBe("tos");
    });
  });

  // ── getClient (lazy init) ─────────────────────────────────────────────────

  describe("getClient", () => {
    it("creates a client on first access", async () => {
      const store = new TosObjectStore(createConfig());
      mockPutObject.mockResolvedValue(undefined);
      mockHeadObject.mockResolvedValue({ headers: { "content-length": "5" } });

      await store.put("test.txt", Buffer.from("hello"));

      expect(mockTosConstructor).toHaveBeenCalledOnce();
      expect(mockTosConstructor).toHaveBeenCalledWith({
        accessKeyId: "test-secret-id",
        accessKeySecret: "test-secret-key",
        bucket: "test-bucket",
        region: "ap-guangzhou",
        endpoint: undefined,
      });
    });

    it("reuses the cached client on subsequent calls", async () => {
      const store = new TosObjectStore(createConfig());

      await store.put("a.txt", Buffer.from("abc"));
      await store.put("b.txt", Buffer.from("def"));
      await store.get("a.txt");

      expect(mockTosConstructor).toHaveBeenCalledTimes(1);
    });

    it("throws ObjectStoreConnectionError when TOS constructor throws", async () => {
      // Override just the constructor to simulate SDK load failure
      mockTosConstructor.mockImplementation(() => {
        throw new Error("Cannot find module");
      });

      const store = new TosObjectStore(createConfig());

      await expect(store.put("test.txt", Buffer.from("hello"))).rejects.toThrow(
        ObjectStoreConnectionError,
      );
      await expect(store.put("test.txt", Buffer.from("hello"))).rejects.toThrow(
        /tos-sdk package not installed/,
      );
    });
  });

  // ── put ───────────────────────────────────────────────────────────────────

  describe("put", () => {
    it("uploads a Buffer and returns metadata", async () => {
      const store = new TosObjectStore(createConfig());

      const meta = await store.put("report.pdf", Buffer.from("data"));

      expect(mockPutObject).toHaveBeenCalledOnce();
      expect(mockPutObject).toHaveBeenCalledWith({
        bucket: "test-bucket",
        key: "report.pdf",
        body: expect.any(Buffer),
        contentType: "application/octet-stream",
        cacheControl: undefined,
        contentDisposition: undefined,
        meta: undefined,
      });
      expect(meta.key).toBe("report.pdf");
      expect(meta.size).toBe(4);
      // Source: contentType: options?.contentType → undefined when no options
      expect(meta.contentType).toBeUndefined();
      expect(meta.lastModified).toBeInstanceOf(Date);
      expect(meta.metadata).toBeUndefined();
    });

    it("uploads a Uint8Array and returns metadata", async () => {
      const store = new TosObjectStore(createConfig());

      const arr = new Uint8Array([1, 2, 3, 4, 5]);
      const meta = await store.put("data.bin", arr);

      expect(meta.size).toBe(5);
      expect(meta.key).toBe("data.bin");
    });

    it("passes all put options to the client", async () => {
      const store = new TosObjectStore(createConfig());

      await store.put("doc.txt", Buffer.from("hello"), {
        contentType: "text/plain",
        cacheControl: "max-age=3600",
        contentDisposition: 'attachment; filename="doc.txt"',
        metadata: { author: "test" },
      });

      expect(mockPutObject).toHaveBeenCalledWith({
        bucket: "test-bucket",
        key: "doc.txt",
        body: expect.any(Buffer),
        contentType: "text/plain",
        cacheControl: "max-age=3600",
        contentDisposition: 'attachment; filename="doc.txt"',
        meta: { author: "test" },
      });
    });

    it("when options passed, contentType reflects options", async () => {
      const store = new TosObjectStore(createConfig());

      const meta = await store.put("file.bin", Buffer.from("x"), {
        contentType: "image/png",
      });

      expect(meta.contentType).toBe("image/png");
    });

    it("prepends the config prefix to the key", async () => {
      const store = new TosObjectStore(createConfig({ prefix: "app1" }));

      await store.put("my-file.txt", Buffer.from("data"));

      expect(mockPutObject).toHaveBeenCalledWith(
        expect.objectContaining({ key: "app1/my-file.txt" }),
      );
    });

    it("returns the original key (not the full key) in metadata", async () => {
      const store = new TosObjectStore(createConfig({ prefix: "app1" }));

      const meta = await store.put("my-file.txt", Buffer.from("data"));

      expect(meta.key).toBe("my-file.txt");
    });
  });

  // ── get ───────────────────────────────────────────────────────────────────

  describe("get", () => {
    it("returns content and metadata for an existing object", async () => {
      const store = new TosObjectStore(createConfig());
      mockGetObject.mockResolvedValue({ data: Buffer.from("hello world") });
      mockHeadObject.mockResolvedValue({
        headers: {
          "content-length": "11",
          etag: '"abc123"',
          "content-type": "text/plain",
          "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT",
        },
      });

      const result = await store.get("hello.txt");

      expect(result.content.toString()).toBe("hello world");
      expect(result.metadata.key).toBe("hello.txt");
      expect(result.metadata.size).toBe(11);
      expect(result.metadata.etag).toBe('"abc123"');
      expect(result.metadata.contentType).toBe("text/plain");
      expect(result.metadata.lastModified).toEqual(
        new Date("Mon, 01 Jan 2024 00:00:00 GMT"),
      );
    });

    it("throws ObjectNotFoundError for non-existent object (statusCode 404)", async () => {
      const store = new TosObjectStore(createConfig());
      mockGetObject.mockRejectedValue(tosNotFoundByStatus());

      await expect(store.get("missing.txt")).rejects.toThrow(ObjectNotFoundError);
      await expect(store.get("missing.txt")).rejects.toThrow(
        /Object not found: missing.txt/,
      );
    });

    it("throws ObjectNotFoundError for non-existent object (code NoSuchKey)", async () => {
      const store = new TosObjectStore(createConfig());
      mockGetObject.mockRejectedValue(tosNotFoundByCode());

      await expect(store.get("missing.txt")).rejects.toThrow(ObjectNotFoundError);
    });

    it("re-throws non-404 errors from the client", async () => {
      const store = new TosObjectStore(createConfig());
      mockGetObject.mockRejectedValue(new Error("Access Denied"));

      await expect(store.get("secret.txt")).rejects.toThrow("Access Denied");
    });

    it("uses the config prefix on get", async () => {
      const store = new TosObjectStore(createConfig({ prefix: "app1" }));
      mockGetObject.mockResolvedValue({ data: Buffer.from("x") });

      await store.get("data.json");

      expect(mockGetObject).toHaveBeenCalledWith({
        bucket: "test-bucket",
        key: "app1/data.json",
      });
    });
  });

  // ── delete ────────────────────────────────────────────────────────────────

  describe("delete", () => {
    it("deletes an existing object", async () => {
      const store = new TosObjectStore(createConfig());

      await store.delete("temp.txt");

      expect(mockDeleteObject).toHaveBeenCalledWith({
        bucket: "test-bucket",
        key: "temp.txt",
      });
    });

    it("no-ops when the object does not exist (statusCode 404)", async () => {
      const store = new TosObjectStore(createConfig());
      mockDeleteObject.mockRejectedValue(tosNotFoundByStatus());

      await expect(store.delete("nonexistent.txt")).resolves.toBeUndefined();
    });

    it("no-ops when the object does not exist (code NoSuchKey)", async () => {
      const store = new TosObjectStore(createConfig());
      mockDeleteObject.mockRejectedValue(tosNotFoundByCode());

      await expect(store.delete("nonexistent.txt")).resolves.toBeUndefined();
    });

    it("re-throws non-404 errors from the client", async () => {
      const store = new TosObjectStore(createConfig());
      mockDeleteObject.mockRejectedValue(new Error("Permission Denied"));

      await expect(store.delete("protected.txt")).rejects.toThrow("Permission Denied");
    });

    it("uses the config prefix on delete", async () => {
      const store = new TosObjectStore(createConfig({ prefix: "app1" }));

      await store.delete("data.json");

      expect(mockDeleteObject).toHaveBeenCalledWith({
        bucket: "test-bucket",
        key: "app1/data.json",
      });
    });
  });

  // ── deleteMany ────────────────────────────────────────────────────────────

  describe("deleteMany", () => {
    it("deletes multiple keys in parallel", async () => {
      const store = new TosObjectStore(createConfig());

      // Pre-warm the client to avoid concurrent dynamic import in Promise.all.
      // Without this, all N deletes race to `await import("tos-sdk")` which
      // hits a Vitest edge case with vi.mock + concurrent dynamic imports.
      await store.put("_warmup.txt", Buffer.from("x"));
      mockDeleteObject.mockClear();

      await store.deleteMany(["a.txt", "b.txt", "c.txt"]);

      expect(mockDeleteObject).toHaveBeenCalledTimes(3);
      expect(mockDeleteObject).toHaveBeenCalledWith({
        bucket: "test-bucket",
        key: "a.txt",
      });
      expect(mockDeleteObject).toHaveBeenCalledWith({
        bucket: "test-bucket",
        key: "b.txt",
      });
      expect(mockDeleteObject).toHaveBeenCalledWith({
        bucket: "test-bucket",
        key: "c.txt",
      });
    });

    it("no-ops on empty array", async () => {
      const store = new TosObjectStore(createConfig());

      await store.deleteMany([]);

      expect(mockDeleteObject).not.toHaveBeenCalled();
    });

    it("no-ops when all keys are non-existent (404 swallowed)", async () => {
      const store = new TosObjectStore(createConfig());
      // Pre-warm client to avoid Vitest concurrent dynamic import edge case
      await store.put("_warmup.txt", Buffer.from("x"));
      mockDeleteObject.mockReset();
      mockDeleteObject.mockRejectedValue(tosNotFoundByStatus());

      await expect(
        store.deleteMany(["missing1.txt", "missing2.txt"]),
      ).resolves.toBeUndefined();
    });

    it("uses prefix for each key in the array", async () => {
      const store = new TosObjectStore(createConfig({ prefix: "app1" }));
      // Pre-warm client to avoid Vitest concurrent dynamic import edge case
      await store.put("_warmup.txt", Buffer.from("x"));
      mockDeleteObject.mockClear();

      await store.deleteMany(["a.txt", "b.txt"]);

      expect(mockDeleteObject).toHaveBeenCalledWith({
        bucket: "test-bucket",
        key: "app1/a.txt",
      });
      expect(mockDeleteObject).toHaveBeenCalledWith({
        bucket: "test-bucket",
        key: "app1/b.txt",
      });
    });
  });

  // ── list ──────────────────────────────────────────────────────────────────

  describe("list", () => {
    it("lists objects with no options", async () => {
      const store = new TosObjectStore(createConfig());
      mockListObjects.mockResolvedValue({
        contents: [
          { key: "file1.txt", size: 100, etag: '"etag1"', lastModified: "2024-01-01T00:00:00.000Z" },
          { key: "file2.pdf", size: 200, etag: '"etag2"', lastModified: "2024-01-02T00:00:00.000Z" },
        ],
        commonPrefixes: [],
        isTruncated: false,
      });

      const result = await store.list();

      expect(mockListObjects).toHaveBeenCalledWith({
        bucket: "test-bucket",
        prefix: "",
        delimiter: undefined,
        maxKeys: 1000,
        marker: "",
      });
      expect(result.objects).toHaveLength(2);
      expect(result.objects[0].key).toBe("file1.txt");
      expect(result.objects[0].size).toBe(100);
      expect(result.objects[0].etag).toBe('"etag1"');
      expect(result.objects[0].lastModified).toEqual(new Date("2024-01-01T00:00:00.000Z"));
      expect(result.prefixes).toEqual([]);
      expect(result.continuationToken).toBeUndefined();
      expect(result.isTruncated).toBe(false);
    });

    it("uses config prefix fallback when no options.prefix", async () => {
      const store = new TosObjectStore(createConfig({ prefix: "app1" }));

      await store.list();

      expect(mockListObjects).toHaveBeenCalledWith(
        expect.objectContaining({ prefix: "app1/" }),
      );
    });

    it("transforms options.prefix using fullKey when prefix is set", async () => {
      const store = new TosObjectStore(createConfig({ prefix: "app1" }));

      await store.list({ prefix: "uploads" });

      expect(mockListObjects).toHaveBeenCalledWith(
        expect.objectContaining({ prefix: "app1/uploads" }),
      );
    });

    it("passes all list options to the client", async () => {
      const store = new TosObjectStore(createConfig());
      mockListObjects.mockResolvedValue({
        contents: [],
        commonPrefixes: [],
        isTruncated: true,
        nextMarker: "marker-token",
      });

      const result = await store.list({
        prefix: "logs/",
        delimiter: "/",
        maxKeys: 50,
        continuationToken: "next-page-token",
      });

      expect(mockListObjects).toHaveBeenCalledWith({
        bucket: "test-bucket",
        prefix: "logs/",
        delimiter: "/",
        maxKeys: 50,
        marker: "next-page-token",
      });
      expect(result.isTruncated).toBe(true);
      expect(result.continuationToken).toBe("marker-token");
    });

    it("uses startAfter as marker when continuationToken is not set", async () => {
      const store = new TosObjectStore(createConfig());

      await store.list({ startAfter: "zebra.txt" });

      expect(mockListObjects).toHaveBeenCalledWith(
        expect.objectContaining({ marker: "zebra.txt" }),
      );
    });

    it("prioritizes continuationToken over startAfter", async () => {
      const store = new TosObjectStore(createConfig());

      await store.list({
        continuationToken: "token-abc",
        startAfter: "other-key",
      });

      expect(mockListObjects).toHaveBeenCalledWith(
        expect.objectContaining({ marker: "token-abc" }),
      );
    });

    it("strips prefix from returned object keys", async () => {
      const store = new TosObjectStore(createConfig({ prefix: "app1" }));
      mockListObjects.mockResolvedValue({
        contents: [
          { key: "app1/file1.txt", size: 10, etag: '"e1"', lastModified: "2024-01-01T00:00:00.000Z" },
          { key: "app1/sub/file2.pdf", size: 20, etag: '"e2"', lastModified: "2024-01-02T00:00:00.000Z" },
        ],
        commonPrefixes: [
          { prefix: "app1/dir1/" },
          { prefix: "app1/dir2/" },
        ],
        isTruncated: false,
      });

      const result = await store.list();

      expect(result.objects[0].key).toBe("file1.txt");
      expect(result.objects[1].key).toBe("sub/file2.pdf");
      expect(result.prefixes).toEqual(["dir1/", "dir2/"]);
    });

    it("does not strip prefix when key does not start with prefix + slash", async () => {
      const store = new TosObjectStore(createConfig({ prefix: "app1" }));
      mockListObjects.mockResolvedValue({
        contents: [
          { key: "app1-extra.txt", size: 10, etag: '"e1"', lastModified: "2024-01-01T00:00:00.000Z" },
        ],
        commonPrefixes: [],
        isTruncated: false,
      });

      const result = await store.list();
      expect(result.objects[0].key).toBe("app1-extra.txt");
    });

    it("defaults isTruncated to false when undefined", async () => {
      const store = new TosObjectStore(createConfig());
      mockListObjects.mockResolvedValue({ isTruncated: undefined });

      const result = await store.list();

      expect(result.isTruncated).toBe(false);
    });

    it("handles undefined contents and commonPrefixes gracefully", async () => {
      const store = new TosObjectStore(createConfig());
      mockListObjects.mockResolvedValue({ isTruncated: false });

      const result = await store.list();

      expect(result.objects).toEqual([]);
      expect(result.prefixes).toEqual([]);
      expect(result.isTruncated).toBe(false);
    });

    it("defaults maxKeys to 1000 when not provided", async () => {
      const store = new TosObjectStore(createConfig());

      await store.list({ prefix: "test/" });

      expect(mockListObjects).toHaveBeenCalledWith(
        expect.objectContaining({ maxKeys: 1000 }),
      );
    });
  });

  // ── exists ────────────────────────────────────────────────────────────────

  describe("exists", () => {
    it("returns true when object exists", async () => {
      const store = new TosObjectStore(createConfig());
      mockHeadObject.mockResolvedValue({ headers: { "content-length": "42" } });

      const exists = await store.exists("real.txt");

      expect(exists).toBe(true);
    });

    it("returns false when object does not exist (statusCode 404)", async () => {
      const store = new TosObjectStore(createConfig());
      mockHeadObject.mockRejectedValue(tosNotFoundByStatus());

      const exists = await store.exists("nope.txt");

      expect(exists).toBe(false);
    });

    it("returns false when NoSuchKey code is returned", async () => {
      const store = new TosObjectStore(createConfig());
      mockHeadObject.mockRejectedValue(tosNotFoundByCode());

      const exists = await store.exists("nope.txt");

      expect(exists).toBe(false);
    });

    it("re-throws non-NotFound errors", async () => {
      const store = new TosObjectStore(createConfig());
      mockHeadObject.mockRejectedValue(new Error("Network Error"));

      await expect(store.exists("anything.txt")).rejects.toThrow("Network Error");
    });

    it("uses config prefix", async () => {
      const store = new TosObjectStore(createConfig({ prefix: "app1" }));
      mockHeadObject.mockResolvedValue({ headers: { "content-length": "1" } });

      await store.exists("my-key");

      expect(mockHeadObject).toHaveBeenCalledWith({
        bucket: "test-bucket",
        key: "app1/my-key",
      });
    });
  });

  // ── head ──────────────────────────────────────────────────────────────────

  describe("head", () => {
    it("returns metadata for an existing object", async () => {
      const store = new TosObjectStore(createConfig());
      mockHeadObject.mockResolvedValue({
        headers: {
          "content-length": "1024",
          etag: '"abc123-def"',
          "content-type": "application/json",
          "last-modified": "Wed, 15 Feb 2024 08:30:00 GMT",
        },
        meta: { custom: "value" },
      });

      const meta = await store.head("data.json");

      expect(meta.key).toBe("data.json");
      expect(meta.size).toBe(1024);
      expect(meta.etag).toBe('"abc123-def"');
      expect(meta.contentType).toBe("application/json");
      expect(meta.lastModified).toEqual(new Date("Wed, 15 Feb 2024 08:30:00 GMT"));
      expect(meta.metadata).toEqual({ custom: "value" });
    });

    it("returns defaults when headers are missing", async () => {
      const store = new TosObjectStore(createConfig());
      mockHeadObject.mockResolvedValue({});

      const meta = await store.head("minimal.txt");

      expect(meta.key).toBe("minimal.txt");
      expect(meta.size).toBe(0);
      expect(meta.etag).toBeUndefined();
      expect(meta.contentType).toBeUndefined();
      expect(meta.lastModified).toBeUndefined();
      expect(meta.metadata).toBeUndefined();
    });

    it("throws ObjectNotFoundError on 404 (statusCode)", async () => {
      const store = new TosObjectStore(createConfig());
      mockHeadObject.mockRejectedValue(tosNotFoundByStatus());

      await expect(store.head("missing.txt")).rejects.toThrow(ObjectNotFoundError);
    });

    it("throws ObjectNotFoundError on NoSuchKey code", async () => {
      const store = new TosObjectStore(createConfig());
      mockHeadObject.mockRejectedValue(tosNotFoundByCode());

      await expect(store.head("missing.txt")).rejects.toThrow(ObjectNotFoundError);
    });

    it("re-throws non-404 errors", async () => {
      const store = new TosObjectStore(createConfig());
      mockHeadObject.mockRejectedValue(new Error("Service Unavailable"));

      await expect(store.head("oops.txt")).rejects.toThrow("Service Unavailable");
    });

    it("uses config prefix", async () => {
      const store = new TosObjectStore(createConfig({ prefix: "app1" }));
      mockHeadObject.mockResolvedValue({ headers: { "content-length": "1" } });

      await store.head("my-key");

      expect(mockHeadObject).toHaveBeenCalledWith({
        bucket: "test-bucket",
        key: "app1/my-key",
      });
    });

    it("handles content-length as '0' string", async () => {
      const store = new TosObjectStore(createConfig());
      mockHeadObject.mockResolvedValue({ headers: { "content-length": "0" } });

      const meta = await store.head("empty.bin");

      expect(meta.size).toBe(0);
    });
  });

  // ── presignUrl ────────────────────────────────────────────────────────────

  describe("presignUrl", () => {
    it("generates a GET presigned URL by default", async () => {
      const store = new TosObjectStore(createConfig());
      mockGetPreSignedUrl.mockResolvedValue("https://test-bucket.tos.cn/presigned-url");

      const url = await store.presignUrl("share.pdf");

      expect(url).toBe("https://test-bucket.tos.cn/presigned-url");
      expect(mockGetPreSignedUrl).toHaveBeenCalledWith({
        bucket: "test-bucket",
        key: "share.pdf",
        method: "GET",
        expires: 3600,
      });
    });

    it("generates a PUT presigned URL when method is PUT", async () => {
      const store = new TosObjectStore(createConfig());

      await store.presignUrl("upload.pdf", { method: "PUT" });

      expect(mockGetPreSignedUrl).toHaveBeenCalledWith(
        expect.objectContaining({ method: "PUT" }),
      );
    });

    it("generates a GET presigned URL when method is GET (explicit)", async () => {
      const store = new TosObjectStore(createConfig());

      await store.presignUrl("read.pdf", { method: "GET" });

      expect(mockGetPreSignedUrl).toHaveBeenCalledWith(
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("uses custom expiry when provided", async () => {
      const store = new TosObjectStore(createConfig());
      mockGetPreSignedUrl.mockResolvedValue("https://custom-expiry.url");

      const url = await store.presignUrl("file.pdf", { expiresIn: 7200 });

      expect(url).toBe("https://custom-expiry.url");
      expect(mockGetPreSignedUrl).toHaveBeenCalledWith(
        expect.objectContaining({ expires: 7200 }),
      );
    });

    it("uses config prefix", async () => {
      const store = new TosObjectStore(createConfig({ prefix: "app1" }));
      mockGetPreSignedUrl.mockResolvedValue("https://prefixed.url");

      await store.presignUrl("my-file.pdf");

      expect(mockGetPreSignedUrl).toHaveBeenCalledWith({
        bucket: "test-bucket",
        key: "app1/my-file.pdf",
        method: "GET",
        expires: 3600,
      });
    });

    it("defaults to GET when method is not PUT", async () => {
      const store = new TosObjectStore(createConfig());

      await store.presignUrl("file.pdf", {
        method: "POST" as unknown as "GET" | "PUT",
      });

      expect(mockGetPreSignedUrl).toHaveBeenCalledWith(
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("defaults expiresIn to 3600 when not provided", async () => {
      const store = new TosObjectStore(createConfig());

      await store.presignUrl("file.pdf");

      expect(mockGetPreSignedUrl).toHaveBeenCalledWith(
        expect.objectContaining({ expires: 3600 }),
      );
    });
  });

  // ── close ─────────────────────────────────────────────────────────────────

  describe("close", () => {
    it("sets client to null so next call creates a fresh one", async () => {
      const store = new TosObjectStore(createConfig());

      // Trigger client creation
      await store.put("warmup.txt", Buffer.from("x"));
      expect(mockTosConstructor).toHaveBeenCalledTimes(1);

      await store.close();

      // After close, a new call should create a new client
      await store.put("after-close.txt", Buffer.from("y"));

      expect(mockTosConstructor).toHaveBeenCalledTimes(2);
    });
  });

  // ── fullKey / stripPrefix edge cases ─────────────────────────────────────

  describe("fullKey and stripPrefix edge cases", () => {
    it("fullKey joins prefix and key without trailing slash", async () => {
      const store = new TosObjectStore(createConfig({ prefix: "app1" }));

      await store.put("my-key", Buffer.from("data"));

      expect(mockPutObject).toHaveBeenCalledWith(
        expect.objectContaining({ key: "app1/my-key" }),
      );
    });

    it("stripPrefix returns key unchanged when prefix is empty string", async () => {
      const store = new TosObjectStore(createConfig({ prefix: undefined }));
      mockListObjects.mockResolvedValue({
        contents: [
          { key: "some/key.txt", size: 5, etag: '"e1"', lastModified: "2024-01-01T00:00:00.000Z" },
        ],
        commonPrefixes: [],
        isTruncated: false,
      });

      const result = await store.list();
      expect(result.objects[0].key).toBe("some/key.txt");
    });

    it("stripPrefix removes prefix and separator from key", async () => {
      const store = new TosObjectStore(createConfig({ prefix: "app1" }));
      mockListObjects.mockResolvedValue({
        contents: [
          { key: "app1/sub/deep/file.txt", size: 5, etag: '"e1"', lastModified: "2024-01-01T00:00:00.000Z" },
        ],
        commonPrefixes: [],
        isTruncated: false,
      });

      const result = await store.list();
      expect(result.objects[0].key).toBe("sub/deep/file.txt");
    });

    it("stripPrefix preserves key when it does not match prefix + slash", async () => {
      const store = new TosObjectStore(createConfig({ prefix: "app1" }));
      mockListObjects.mockResolvedValue({
        contents: [
          { key: "app1-extra.txt", size: 5, etag: '"e1"', lastModified: "2024-01-01T00:00:00.000Z" },
        ],
        commonPrefixes: [],
        isTruncated: false,
      });

      const result = await store.list();
      expect(result.objects[0].key).toBe("app1-extra.txt");
    });
  });

  // ── isTosNotFound helper (exercised via public API) ──────────────────────

  describe("isTosNotFound helper", () => {
    it("detects 404 with statusCode property", async () => {
      const store = new TosObjectStore(createConfig());
      const err = new Error() as Error & { statusCode: number };
      err.statusCode = 404;
      mockHeadObject.mockRejectedValue(err);

      const exists = await store.exists("test-key");
      expect(exists).toBe(false);
    });

    it("detects NoSuchKey with code property", async () => {
      const store = new TosObjectStore(createConfig());
      const err = new Error() as Error & { code: string };
      err.code = "NoSuchKey";
      mockHeadObject.mockRejectedValue(err);

      const exists = await store.exists("test-key");
      expect(exists).toBe(false);
    });

    it("does not match non-404 statusCode (e.g., 403)", async () => {
      const store = new TosObjectStore(createConfig());
      const err = new Error("Forbidden") as Error & { statusCode: number };
      err.statusCode = 403;
      mockHeadObject.mockRejectedValue(err);

      await expect(store.head("test-key")).rejects.toThrow("Forbidden");
    });

    it("does not match non-NoSuchKey code", async () => {
      const store = new TosObjectStore(createConfig());
      const err = new Error("AccessDenied") as Error & { code: string };
      err.code = "AccessDenied";
      mockHeadObject.mockRejectedValue(err);

      await expect(store.head("test-key")).rejects.toThrow("AccessDenied");
    });

    it("does not match null error", async () => {
      const store = new TosObjectStore(createConfig());
      mockHeadObject.mockRejectedValue(null);

      await expect(store.head("test-key")).rejects.toBeNull();
    });

    it("does not match primitive error (string)", async () => {
      const store = new TosObjectStore(createConfig());
      mockHeadObject.mockRejectedValue("Something went wrong");

      await expect(store.head("test-key")).rejects.toBe("Something went wrong");
    });

    it("does not match undefined error", async () => {
      const store = new TosObjectStore(createConfig());
      mockHeadObject.mockRejectedValue(undefined);

      await expect(store.head("test-key")).rejects.toBeUndefined();
    });

    it("does not match plain object without statusCode or code", async () => {
      const store = new TosObjectStore(createConfig());
      mockHeadObject.mockRejectedValue({ message: "Unknown" });

      await expect(store.head("test-key")).rejects.toEqual({ message: "Unknown" });
    });

    it("prioritizes statusCode 404 over code (both present)", async () => {
      const store = new TosObjectStore(createConfig());
      const err = new Error("Not Found") as Error & { statusCode: number; code: string };
      err.statusCode = 404;
      err.code = "AccessDenied";
      mockHeadObject.mockRejectedValue(err);

      const exists = await store.exists("test-key");
      expect(exists).toBe(false);
    });
  });

  // ── Config passthrough ────────────────────────────────────────────────────

  describe("config passthrough", () => {
    it("passes endpoint to the TOS constructor", async () => {
      const store = new TosObjectStore(
        createConfig({ endpoint: "https://custom.tos.example.com" }),
      );

      await store.put("test.txt", Buffer.from("x"));

      expect(mockTosConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: "https://custom.tos.example.com" }),
      );
    });

    it("passes region to the TOS constructor", async () => {
      const store = new TosObjectStore(createConfig({ region: "us-west-1" }));

      await store.put("test.txt", Buffer.from("x"));

      expect(mockTosConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ region: "us-west-1" }),
      );
    });
  });

  // ── delete error path coverage ───────────────────────────────────────────

  describe("delete error handling", () => {
    it("treats NoSuchKey code as not-found (no-op)", async () => {
      const store = new TosObjectStore(createConfig());
      const err = new Error() as Error & { code: string };
      err.code = "NoSuchKey";
      mockDeleteObject.mockRejectedValue(err);

      await expect(store.delete("noop.txt")).resolves.toBeUndefined();
    });

    it("treats 404 statusCode as not-found (no-op)", async () => {
      const store = new TosObjectStore(createConfig());
      const err = new Error() as Error & { statusCode: number };
      err.statusCode = 404;
      mockDeleteObject.mockRejectedValue(err);

      await expect(store.delete("noop.txt")).resolves.toBeUndefined();
    });
  });

  // ── get error path coverage ──────────────────────────────────────────────

  describe("get error handling", () => {
    it("re-throws non-404 statusCode errors", async () => {
      const store = new TosObjectStore(createConfig());
      const err = new Error("Server Error") as Error & { statusCode: number };
      err.statusCode = 500;
      mockGetObject.mockRejectedValue(err);

      await expect(store.get("key.txt")).rejects.toThrow("Server Error");
    });

    it("re-throws non-NoSuchKey code errors", async () => {
      const store = new TosObjectStore(createConfig());
      const err = new Error("Access Denied") as Error & { code: string };
      err.code = "AccessDenied";
      mockGetObject.mockRejectedValue(err);

      await expect(store.get("key.txt")).rejects.toThrow("Access Denied");
    });
  });
});

/**
 * AWS S3 ObjectStore adapter — comprehensive unit tests.
 *
 * Mocks the entire @aws-sdk/* surface so no real AWS SDK installation is required.
 * Uses vi.hoisted() to create mock references visible to both vi.mock factories
 * and the test suite.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { S3ObjectStore } from "../s3-adapter.js";
import {
  ObjectNotFoundError,
  ObjectStoreConnectionError,
} from "../object-store.js";
import type { S3Config } from "../object-store.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function mockAsyncIterable(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < chunks.length) {
            return { done: false, value: chunks[i++] as Uint8Array };
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
}

// ── vi.hoisted mock references ─────────────────────────────────────────────

const m = vi.hoisted(() => {
  const mockSend = vi.fn();
  const mockDestroy = vi.fn();
  const mockS3Client = vi.fn();
  const mockPutObjectCommand = vi.fn();
  const mockGetObjectCommand = vi.fn();
  const mockDeleteObjectCommand = vi.fn();
  const mockDeleteObjectsCommand = vi.fn();
  const mockListObjectsV2Command = vi.fn();
  const mockHeadObjectCommand = vi.fn();
  const mockGetSignedUrl = vi.fn();

  return {
    mockSend,
    mockDestroy,
    mockS3Client,
    mockPutObjectCommand,
    mockGetObjectCommand,
    mockDeleteObjectCommand,
    mockDeleteObjectsCommand,
    mockListObjectsV2Command,
    mockHeadObjectCommand,
    mockGetSignedUrl,
  };
});

// ── vi.mock registrations ──────────────────────────────────────────────────

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: m.mockS3Client,
  PutObjectCommand: m.mockPutObjectCommand,
  GetObjectCommand: m.mockGetObjectCommand,
  DeleteObjectCommand: m.mockDeleteObjectCommand,
  DeleteObjectsCommand: m.mockDeleteObjectsCommand,
  ListObjectsV2Command: m.mockListObjectsV2Command,
  HeadObjectCommand: m.mockHeadObjectCommand,
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: m.mockGetSignedUrl,
}));

// ── Test suite ──────────────────────────────────────────────────────────────

describe("S3ObjectStore", () => {
  const config: S3Config = {
    type: "s3",
    bucket: "test-bucket",
    region: "us-east-1",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
  };

  const configWithPrefix: S3Config = {
    ...config,
    prefix: "my-app",
  };

  beforeEach(() => {
    // ── Reset call history only (preserve or re-set implementations below) ──
    m.mockSend.mockClear();
    m.mockDestroy.mockClear();
    m.mockS3Client.mockClear();
    m.mockPutObjectCommand.mockClear();
    m.mockGetObjectCommand.mockClear();
    m.mockDeleteObjectCommand.mockClear();
    m.mockDeleteObjectsCommand.mockClear();
    m.mockListObjectsV2Command.mockClear();
    m.mockHeadObjectCommand.mockClear();
    m.mockGetSignedUrl.mockClear();

    // ── Default implementations ─────────────────────────────────────────────
    m.mockSend.mockResolvedValue(undefined);
    m.mockDestroy.mockReturnValue(undefined);

    // S3Client constructor — sets send/destroy on the instance.
    // Using a regular (non-arrow) function so `new` binds `this` correctly.
    m.mockS3Client.mockImplementation(function (
      this: Record<string, unknown>,
    ) {
      this["send"] = m.mockSend;
      this["destroy"] = m.mockDestroy;
    });

    // Command constructors — passthrough args for inspection.
    m.mockPutObjectCommand.mockImplementation(
      function (this: Record<string, unknown>, args: unknown) {
        Object.assign(this, args as Record<string, unknown>);
      },
    );
    m.mockGetObjectCommand.mockImplementation(
      function (this: Record<string, unknown>, args: unknown) {
        Object.assign(this, args as Record<string, unknown>);
      },
    );
    m.mockDeleteObjectCommand.mockImplementation(
      function (this: Record<string, unknown>, args: unknown) {
        Object.assign(this, args as Record<string, unknown>);
      },
    );
    m.mockDeleteObjectsCommand.mockImplementation(
      function (this: Record<string, unknown>, args: unknown) {
        Object.assign(this, args as Record<string, unknown>);
      },
    );
    m.mockListObjectsV2Command.mockImplementation(
      function (this: Record<string, unknown>, args: unknown) {
        Object.assign(this, args as Record<string, unknown>);
      },
    );
    m.mockHeadObjectCommand.mockImplementation(
      function (this: Record<string, unknown>, args: unknown) {
        Object.assign(this, args as Record<string, unknown>);
      },
    );

    // Presigner default.
    m.mockGetSignedUrl.mockResolvedValue(
      "https://signed.example.com/test-key",
    );
  });

  // ── Constructor ─────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("sets name to s3", () => {
      const store = new S3ObjectStore(config);
      expect(store.name).toBe("s3");
    });

    it("stores prefix from config (verified via fullKey behavior)", async () => {
      const store = new S3ObjectStore(configWithPrefix);

      await store.delete("file.txt");

      expect(m.mockDeleteObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Key: "my-app/file.txt" }),
      );
    });

    it("defaults prefix to empty string when not configured", async () => {
      const store = new S3ObjectStore(config);

      await store.delete("file.txt");

      expect(m.mockDeleteObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Key: "file.txt" }),
      );
    });
  });

  // ── getClient: caching & error handling ──────────────────────────────────

  describe("getClient", () => {
    it("caches the S3 client across multiple operations", async () => {
      const store = new S3ObjectStore(config);

      await store.delete("a.txt");
      await store.delete("b.txt");
      await store.delete("c.txt");

      // S3Client constructor should only be called once.
      expect(m.mockS3Client).toHaveBeenCalledTimes(1);
    });

    it("creates S3Client with full configuration including endpoint", async () => {
      const store = new S3ObjectStore({
        ...config,
        endpoint: "https://minio.example.com",
        forcePathStyle: true,
      });

      await store.delete("test");

      expect(m.mockS3Client).toHaveBeenCalledWith({
        region: "us-east-1",
        endpoint: "https://minio.example.com",
        forcePathStyle: true,
        credentials: {
          accessKeyId: "test-access-key",
          secretAccessKey: "test-secret-key",
        },
      });
    });

    it("defaults forcePathStyle to true when endpoint is set and forcePathStyle is omitted", async () => {
      const store = new S3ObjectStore({
        ...config,
        endpoint: "https://s3.example.com",
      });

      await store.delete("test");

      expect(m.mockS3Client).toHaveBeenCalledWith(
        expect.objectContaining({ forcePathStyle: true }),
      );
    });

    it("defaults forcePathStyle to false when endpoint is not set", async () => {
      const store = new S3ObjectStore(config);

      await store.delete("test");

      expect(m.mockS3Client).toHaveBeenCalledWith(
        expect.objectContaining({ forcePathStyle: false }),
      );
    });

    it("throws ObjectStoreConnectionError when S3Client constructor throws", async () => {
      m.mockS3Client.mockImplementation(() => {
        throw new Error("Connection refused");
      });
      const store = new S3ObjectStore(config);

      const promise = store.put("test", Buffer.from("data"));
      await expect(promise).rejects.toThrow(ObjectStoreConnectionError);
      await expect(promise).rejects.toThrow(
        expect.objectContaining({
          message: expect.stringContaining("@aws-sdk/client-s3"),
        }),
      );
    });
  });

  // ── put ──────────────────────────────────────────────────────────────────

  describe("put", () => {
    it("uploads Buffer content and returns metadata", async () => {
      const store = new S3ObjectStore(config);

      const content = Buffer.from("hello world");
      const meta = await store.put("greeting.txt", content, {
        contentType: "text/plain",
      });

      expect(m.mockSend).toHaveBeenCalledTimes(1);
      expect(m.mockPutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Bucket: "test-bucket",
          Key: "greeting.txt",
          ContentType: "text/plain",
        }),
      );
      expect(meta).toEqual({
        key: "greeting.txt",
        size: 11,
        contentType: "text/plain",
        lastModified: expect.any(Date),
        metadata: undefined,
      });
    });

    it("accepts Uint8Array content", async () => {
      const store = new S3ObjectStore(config);

      const content = new Uint8Array([10, 20, 30, 40]);
      const meta = await store.put("bytes.bin", content);

      expect(meta.size).toBe(4);
    });

    it("uses application/octet-stream as default content type", async () => {
      const store = new S3ObjectStore(config);

      await store.put("data.bin", Buffer.from("binary"));

      expect(m.mockPutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ ContentType: "application/octet-stream" }),
      );
    });

    it("passes cacheControl header", async () => {
      const store = new S3ObjectStore(config);

      await store.put("cached.txt", Buffer.from("data"), {
        cacheControl: "max-age=7200",
      });

      expect(m.mockPutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ CacheControl: "max-age=7200" }),
      );
    });

    it("passes contentDisposition header", async () => {
      const store = new S3ObjectStore(config);

      await store.put("report.pdf", Buffer.from("pdf-data"), {
        contentDisposition: 'attachment; filename="report.pdf"',
      });

      expect(m.mockPutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          ContentDisposition: 'attachment; filename="report.pdf"',
        }),
      );
    });

    it("passes custom metadata", async () => {
      const store = new S3ObjectStore(config);

      await store.put("meta.txt", Buffer.from("data"), {
        metadata: { author: "alice", env: "test" },
      });

      expect(m.mockPutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Metadata: { author: "alice", env: "test" },
        }),
      );
    });

    it("returns metadata with custom fields reflected", async () => {
      const store = new S3ObjectStore(config);

      const meta = await store.put("x.txt", Buffer.from("x"), {
        metadata: { k: "v" },
        contentType: "text/plain",
      });

      expect(meta.metadata).toEqual({ k: "v" });
      expect(meta.contentType).toBe("text/plain");
    });

    it("omits undefined optional fields from PutObjectCommand", async () => {
      const store = new S3ObjectStore(config);

      await store.put("clean.txt", Buffer.from("data"));

      const callArgs = m.mockPutObjectCommand.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(callArgs.CacheControl).toBeUndefined();
      expect(callArgs.ContentDisposition).toBeUndefined();
      expect(callArgs.Metadata).toBeUndefined();
    });

    it("applies prefix to key", async () => {
      const store = new S3ObjectStore(configWithPrefix);

      await store.put("file.txt", Buffer.from("data"));

      expect(m.mockPutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Key: "my-app/file.txt" }),
      );
    });
  });

  // ── get ──────────────────────────────────────────────────────────────────

  describe("get", () => {
    it("downloads object and returns content with full metadata", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockResolvedValueOnce({
        Body: mockAsyncIterable([Buffer.from("hello"), Buffer.from(" world")]),
        ContentLength: 11,
        ContentType: "text/plain",
        ETag: '"abc123"',
        LastModified: new Date("2026-01-15T00:00:00Z"),
        Metadata: { checksum: "sha256:abc" },
      });

      const result = await store.get("doc.txt");

      expect(result.content.toString()).toBe("hello world");
      expect(result.metadata).toEqual({
        key: "doc.txt",
        size: 11,
        etag: '"abc123"',
        contentType: "text/plain",
        lastModified: new Date("2026-01-15T00:00:00Z"),
        metadata: { checksum: "sha256:abc" },
      });
    });

    it("falls back to content.byteLength when ContentLength is absent", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockResolvedValueOnce({
        Body: mockAsyncIterable([Buffer.from("sixchr")]),
        ContentType: "text/plain",
      });

      const result = await store.get("small.txt");

      expect(result.metadata.size).toBe(6);
    });

    it("uses explicit ContentLength of 0 over collected byteLength", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockResolvedValueOnce({
        Body: mockAsyncIterable([]),
        ContentLength: 0,
      });

      const result = await store.get("empty.txt");

      expect(result.metadata.size).toBe(0);
    });

    it("handles single-chunk response", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockResolvedValueOnce({
        Body: mockAsyncIterable([Buffer.from("single")]),
        ContentLength: 6,
      });

      const result = await store.get("single.txt");

      expect(result.content.toString()).toBe("single");
    });

    it("throws ObjectNotFoundError on NoSuchKey error name", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockRejectedValueOnce(
        Object.assign(new Error("Not found"), { name: "NoSuchKey" }),
      );

      await expect(store.get("ghost.txt")).rejects.toThrow(
        ObjectNotFoundError,
      );
    });

    it("throws ObjectNotFoundError on NotFound error name", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockRejectedValueOnce(
        Object.assign(new Error("Not found"), { name: "NotFound" }),
      );

      await expect(store.get("ghost.txt")).rejects.toThrow(
        ObjectNotFoundError,
      );
    });

    it("re-throws plain error as-is when name is not NoSuchKey/NotFound (even with 404)", async () => {
      // isS3NotFound checks `name` first. If `name` is not "NoSuchKey" or
      // "NotFound", it short-circuits and never inspects `$metadata`.
      const store = new S3ObjectStore(config);
      const plainErr = {
        name: "SomeS3Error",
        $metadata: { httpStatusCode: 404 },
      };
      m.mockSend.mockRejectedValueOnce(plainErr);

      await expect(store.get("ghost.txt")).rejects.toEqual(plainErr);
    });

    it("throws ObjectNotFoundError when $metadata.httpStatusCode is 404 AND no name property", async () => {
      // Without a `name` property, isS3NotFound falls through to the
      // $metadata check and recognizes the 404.
      const store = new S3ObjectStore(config);
      m.mockSend.mockRejectedValueOnce({
        $metadata: { httpStatusCode: 404 },
      });

      await expect(store.get("ghost.txt")).rejects.toThrow(
        ObjectNotFoundError,
      );
    });

    it("re-throws non-404 errors unchanged", async () => {
      const store = new S3ObjectStore(config);
      const accessDenied = Object.assign(new Error("Access Denied"), {
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      });
      m.mockSend.mockRejectedValueOnce(accessDenied);

      await expect(store.get("secret.txt")).rejects.toThrow("Access Denied");
    });

    it("applies prefix to key in GetObjectCommand", async () => {
      const store = new S3ObjectStore(configWithPrefix);
      m.mockSend.mockResolvedValueOnce({
        Body: mockAsyncIterable([Buffer.from("data")]),
        ContentLength: 4,
      });

      await store.get("file.txt");

      expect(m.mockGetObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Key: "my-app/file.txt" }),
      );
    });
  });

  // ── delete ───────────────────────────────────────────────────────────────

  describe("delete", () => {
    it("sends DeleteObjectCommand with correct bucket and key", async () => {
      const store = new S3ObjectStore(config);

      await store.delete("trash.txt");

      expect(m.mockDeleteObjectCommand).toHaveBeenCalledWith({
        Bucket: "test-bucket",
        Key: "trash.txt",
      });
    });

    it("applies prefix to key", async () => {
      const store = new S3ObjectStore(configWithPrefix);

      await store.delete("trash.txt");

      expect(m.mockDeleteObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Key: "my-app/trash.txt" }),
      );
    });
  });

  // ── deleteMany ───────────────────────────────────────────────────────────

  describe("deleteMany", () => {
    it("deletes multiple objects with prefixed keys", async () => {
      const store = new S3ObjectStore(configWithPrefix);

      await store.deleteMany(["a.txt", "b.txt", "c.txt"]);

      expect(m.mockDeleteObjectsCommand).toHaveBeenCalledWith({
        Bucket: "test-bucket",
        Delete: {
          Objects: [
            { Key: "my-app/a.txt" },
            { Key: "my-app/b.txt" },
            { Key: "my-app/c.txt" },
          ],
        },
      });
    });

    it("is a no-op when keys array is empty", async () => {
      const store = new S3ObjectStore(config);

      await store.deleteMany([]);

      expect(m.mockSend).not.toHaveBeenCalled();
      expect(m.mockDeleteObjectsCommand).not.toHaveBeenCalled();
      expect(m.mockS3Client).not.toHaveBeenCalled();
    });

    it("uses unprefixed keys when no config prefix is set", async () => {
      const store = new S3ObjectStore(config);

      await store.deleteMany(["x.txt", "y.txt"]);

      expect(m.mockDeleteObjectsCommand).toHaveBeenCalledWith({
        Bucket: "test-bucket",
        Delete: {
          Objects: [{ Key: "x.txt" }, { Key: "y.txt" }],
        },
      });
    });
  });

  // ── list ─────────────────────────────────────────────────────────────────

  describe("list", () => {
    it("lists objects with full metadata", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockResolvedValueOnce({
        Contents: [
          {
            Key: "file1.txt",
            Size: 100,
            ETag: '"etag1"',
            LastModified: new Date("2026-01-01T00:00:00Z"),
          },
          {
            Key: "file2.txt",
            Size: 200,
            ETag: '"etag2"',
            LastModified: new Date("2026-02-01T00:00:00Z"),
          },
        ],
        IsTruncated: false,
      });

      const result = await store.list();

      expect(result.objects).toHaveLength(2);
      expect(result.objects[0]).toEqual({
        key: "file1.txt",
        size: 100,
        etag: '"etag1"',
        lastModified: new Date("2026-01-01T00:00:00Z"),
      });
      expect(result.objects[1]).toEqual({
        key: "file2.txt",
        size: 200,
        etag: '"etag2"',
        lastModified: new Date("2026-02-01T00:00:00Z"),
      });
    });

    it("returns empty arrays when response has no Contents", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockResolvedValueOnce({ IsTruncated: false });

      const result = await store.list();

      expect(result.objects).toEqual([]);
      expect(result.prefixes).toEqual([]);
    });

    it("returns CommonPrefixes", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockResolvedValueOnce({
        CommonPrefixes: [{ Prefix: "folder1/" }, { Prefix: "folder2/" }],
        IsTruncated: false,
      });

      const result = await store.list();

      expect(result.prefixes).toEqual(["folder1/", "folder2/"]);
    });

    it("handles truncated listing with continuation token", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockResolvedValueOnce({
        Contents: [
          {
            Key: "a.txt",
            Size: 1,
            ETag: '"e"',
            LastModified: new Date(),
          },
        ],
        IsTruncated: true,
        NextContinuationToken: "token-page2",
      });

      const result = await store.list();

      expect(result.isTruncated).toBe(true);
      expect(result.continuationToken).toBe("token-page2");
    });

    it("defaults isTruncated to false when absent from response", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockResolvedValueOnce({});

      const result = await store.list();

      expect(result.isTruncated).toBe(false);
    });

    it("passes options.prefix through fullKey (combined with config prefix)", async () => {
      const store = new S3ObjectStore(configWithPrefix);
      m.mockSend.mockResolvedValueOnce({ IsTruncated: false });

      await store.list({ prefix: "custom" });

      expect(m.mockListObjectsV2Command).toHaveBeenCalledWith(
        expect.objectContaining({ Prefix: "my-app/custom" }),
      );
    });

    it("uses config prefix with trailing slash when options.prefix is absent", async () => {
      const store = new S3ObjectStore(configWithPrefix);
      m.mockSend.mockResolvedValueOnce({ IsTruncated: false });

      await store.list();

      expect(m.mockListObjectsV2Command).toHaveBeenCalledWith(
        expect.objectContaining({ Prefix: "my-app/" }),
      );
    });

    it("uses empty prefix when neither config nor options provide one", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockResolvedValueOnce({ IsTruncated: false });

      await store.list();

      expect(m.mockListObjectsV2Command).toHaveBeenCalledWith(
        expect.objectContaining({ Prefix: "" }),
      );
    });

    it("passes delimiter option", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockResolvedValueOnce({ IsTruncated: false });

      await store.list({ delimiter: "/" });

      expect(m.mockListObjectsV2Command).toHaveBeenCalledWith(
        expect.objectContaining({ Delimiter: "/" }),
      );
    });

    it("passes maxKeys option", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockResolvedValueOnce({ IsTruncated: false });

      await store.list({ maxKeys: 50 });

      expect(m.mockListObjectsV2Command).toHaveBeenCalledWith(
        expect.objectContaining({ MaxKeys: 50 }),
      );
    });

    it("defaults MaxKeys to 1000", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockResolvedValueOnce({ IsTruncated: false });

      await store.list();

      expect(m.mockListObjectsV2Command).toHaveBeenCalledWith(
        expect.objectContaining({ MaxKeys: 1000 }),
      );
    });

    it("passes continuationToken option", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockResolvedValueOnce({ IsTruncated: false });

      await store.list({ continuationToken: "next-page" });

      expect(m.mockListObjectsV2Command).toHaveBeenCalledWith(
        expect.objectContaining({ ContinuationToken: "next-page" }),
      );
    });

    it("passes startAfter option", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockResolvedValueOnce({ IsTruncated: false });

      await store.list({ startAfter: "file99.txt" });

      expect(m.mockListObjectsV2Command).toHaveBeenCalledWith(
        expect.objectContaining({ StartAfter: "file99.txt" }),
      );
    });

    it("strips config prefix from returned object keys and prefix strings", async () => {
      const store = new S3ObjectStore(configWithPrefix);
      m.mockSend.mockResolvedValueOnce({
        Contents: [
          {
            Key: "my-app/photos/cat.jpg",
            Size: 500,
            ETag: '"e1"',
            LastModified: new Date(),
          },
        ],
        CommonPrefixes: [{ Prefix: "my-app/photos/" }],
        IsTruncated: false,
      });

      const result = await store.list();

      expect(result.objects[0]?.key).toBe("photos/cat.jpg");
      expect(result.prefixes[0]).toBe("photos/");
    });

    it("does not strip prefix from keys not starting with config prefix", async () => {
      const store = new S3ObjectStore(configWithPrefix);
      m.mockSend.mockResolvedValueOnce({
        Contents: [
          {
            Key: "other/thing.txt",
            Size: 10,
            ETag: '"e2"',
            LastModified: new Date(),
          },
        ],
        IsTruncated: false,
      });

      const result = await store.list();

      expect(result.objects[0]?.key).toBe("other/thing.txt");
    });
  });

  // ── exists ───────────────────────────────────────────────────────────────

  describe("exists", () => {
    it("returns true when head succeeds", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockResolvedValueOnce({
        ContentLength: 42,
        ContentType: "text/plain",
        ETag: '"xyz"',
        LastModified: new Date(),
      });

      const result = await store.exists("real.txt");

      expect(result).toBe(true);
    });

    it("returns false when head throws ObjectNotFoundError", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockRejectedValueOnce(
        Object.assign(new Error("Not found"), { name: "NoSuchKey" }),
      );

      const result = await store.exists("ghost.txt");

      expect(result).toBe(false);
    });

    it("re-throws errors other than ObjectNotFoundError", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockRejectedValueOnce(new Error("Internal Server Error"));

      await expect(store.exists("broken.txt")).rejects.toThrow(
        "Internal Server Error",
      );
    });
  });

  // ── head ─────────────────────────────────────────────────────────────────

  describe("head", () => {
    it("returns metadata without downloading content", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockResolvedValueOnce({
        ContentLength: 256,
        ContentType: "image/png",
        ETag: '"png123"',
        LastModified: new Date("2026-03-01T12:00:00Z"),
        Metadata: { uploadedBy: "user1" },
      });

      const meta = await store.head("photo.png");

      expect(meta).toEqual({
        key: "photo.png",
        size: 256,
        etag: '"png123"',
        contentType: "image/png",
        lastModified: new Date("2026-03-01T12:00:00Z"),
        metadata: { uploadedBy: "user1" },
      });
    });

    it("falls back to size 0 when ContentLength is absent", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockResolvedValueOnce({ ContentType: "application/json" });

      const meta = await store.head("config.json");

      expect(meta.size).toBe(0);
    });

    it("returns size 0 when ContentLength is explicitly 0", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockResolvedValueOnce({ ContentLength: 0 });

      const meta = await store.head("empty.txt");

      expect(meta.size).toBe(0);
    });

    it("returns minimal metadata when response is bare", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockResolvedValueOnce({});

      const meta = await store.head("bare.txt");

      expect(meta).toEqual({
        key: "bare.txt",
        size: 0,
        etag: undefined,
        contentType: undefined,
        lastModified: undefined,
        metadata: undefined,
      });
    });

    it("throws ObjectNotFoundError on NoSuchKey error name", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockRejectedValueOnce(
        Object.assign(new Error("Not found"), { name: "NoSuchKey" }),
      );

      await expect(store.head("nope.txt")).rejects.toThrow(
        ObjectNotFoundError,
      );
    });

    it("throws ObjectNotFoundError on NotFound error name", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockRejectedValueOnce(
        Object.assign(new Error("Not found"), { name: "NotFound" }),
      );

      await expect(store.head("nope.txt")).rejects.toThrow(
        ObjectNotFoundError,
      );
    });

    it("re-throws plain error as-is when name is not NoSuchKey/NotFound (even with 404)", async () => {
      const store = new S3ObjectStore(config);
      const plainErr = {
        name: "S3Error",
        $metadata: { httpStatusCode: 404 },
      };
      m.mockSend.mockRejectedValueOnce(plainErr);

      await expect(store.head("nope.txt")).rejects.toEqual(plainErr);
    });

    it("throws ObjectNotFoundError on $metadata.httpStatusCode 404 with no name", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockRejectedValueOnce({
        $metadata: { httpStatusCode: 404 },
      });

      await expect(store.head("nope.txt")).rejects.toThrow(
        ObjectNotFoundError,
      );
    });

    it("re-throws non-404 errors unchanged", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockRejectedValueOnce(
        Object.assign(new Error("Access Denied"), { name: "AccessDenied" }),
      );

      await expect(store.head("secret.txt")).rejects.toThrow("Access Denied");
    });

    it("applies prefix to key in HeadObjectCommand", async () => {
      const store = new S3ObjectStore(configWithPrefix);
      m.mockSend.mockResolvedValueOnce({ ContentLength: 10 });

      await store.head("file.txt");

      expect(m.mockHeadObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Key: "my-app/file.txt" }),
      );
    });
  });

  // ── presignUrl ───────────────────────────────────────────────────────────

  describe("presignUrl", () => {
    it("generates GET presigned URL by default", async () => {
      const store = new S3ObjectStore(config);
      m.mockGetSignedUrl.mockResolvedValueOnce(
        "https://signed.example.com/get-file",
      );

      const url = await store.presignUrl("file.txt");

      expect(url).toBe("https://signed.example.com/get-file");
      expect(m.mockGetObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Key: "file.txt" }),
      );
      expect(m.mockPutObjectCommand).not.toHaveBeenCalled();
      expect(m.mockGetSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { expiresIn: 3600 },
      );
    });

    it("generates PUT presigned URL with ContentType", async () => {
      const store = new S3ObjectStore(config);
      m.mockGetSignedUrl.mockResolvedValueOnce(
        "https://signed.example.com/put-file",
      );

      const url = await store.presignUrl("upload.txt", {
        method: "PUT",
        contentType: "text/plain",
      });

      expect(url).toBe("https://signed.example.com/put-file");
      expect(m.mockPutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: "upload.txt",
          ContentType: "text/plain",
        }),
      );
      expect(m.mockGetObjectCommand).not.toHaveBeenCalled();
    });

    it("passes custom expiresIn to getSignedUrl", async () => {
      const store = new S3ObjectStore(config);
      m.mockGetSignedUrl.mockResolvedValueOnce(
        "https://signed.example.com/file",
      );

      await store.presignUrl("file.txt", { expiresIn: 7200 });

      expect(m.mockGetSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { expiresIn: 7200 },
      );
    });

    it("defaults expiresIn to 3600", async () => {
      const store = new S3ObjectStore(config);
      m.mockGetSignedUrl.mockResolvedValueOnce(
        "https://signed.example.com/file",
      );

      await store.presignUrl("file.txt");

      expect(m.mockGetSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { expiresIn: 3600 },
      );
    });

    it("applies prefix to key", async () => {
      const store = new S3ObjectStore(configWithPrefix);
      m.mockGetSignedUrl.mockResolvedValueOnce(
        "https://signed.example.com/file",
      );

      await store.presignUrl("file.txt");

      expect(m.mockGetObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Key: "my-app/file.txt" }),
      );
    });
  });

  // ── close ────────────────────────────────────────────────────────────────

  describe("close", () => {
    it("calls destroy on client and nullifies the reference", async () => {
      const store = new S3ObjectStore(config);
      // Initialize client first.
      await store.put("init.txt", Buffer.from("init"));

      await store.close();

      expect(m.mockDestroy).toHaveBeenCalledTimes(1);
    });

    it("does not throw when client has no destroy method", async () => {
      // Reconfigure S3Client to return a client without destroy.
      const localSend = vi.fn().mockResolvedValue(undefined);
      m.mockS3Client.mockImplementation(function (
        this: Record<string, unknown>,
      ) {
        this["send"] = localSend;
        // no destroy
      });

      const store = new S3ObjectStore(config);
      await store.put("init.txt", Buffer.from("init"));

      await expect(store.close()).resolves.toBeUndefined();
      expect(m.mockDestroy).not.toHaveBeenCalled();
    });

    it("is a no-op when client was never initialised", async () => {
      const store = new S3ObjectStore(config);

      await expect(store.close()).resolves.toBeUndefined();
      expect(m.mockDestroy).not.toHaveBeenCalled();
    });
  });

  // ── isS3NotFound helper (behaviour coverage via get / head / exists) ─────

  describe("isS3NotFound error detection", () => {
    it("re-throws as-is when name is set (even with 404 in $metadata)", async () => {
      // isS3NotFound checks `name` first. Since `name` is neither
      // "NoSuchKey" nor "NotFound", the $metadata 404 is never inspected.
      const store = new S3ObjectStore(config);
      const plainErr = {
        name: "SomeOtherS3Error",
        $metadata: { httpStatusCode: 404 },
      };
      m.mockSend.mockRejectedValueOnce(plainErr);

      await expect(store.get("x.txt")).rejects.toEqual(plainErr);
    });

    it("re-throws as-is for 500 error with $metadata (non-404)", async () => {
      const store = new S3ObjectStore(config);
      const plainErr = {
        name: "ServerError",
        $metadata: { httpStatusCode: 500 },
      };
      m.mockSend.mockRejectedValueOnce(plainErr);

      await expect(store.get("x.txt")).rejects.toEqual(plainErr);
    });

    it("does not match plain object with neither name nor $metadata", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockRejectedValueOnce({ code: "UNKNOWN" });

      // {} has no `name` → isS3NotFound returns false → re-thrown as-is.
      await expect(store.get("x.txt")).rejects.toEqual({ code: "UNKNOWN" });
    });

    it("does not match null errors", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockRejectedValueOnce(null);

      await expect(store.get("x.txt")).rejects.toBeNull();
    });

    it("detects NoSuchKey without $metadata", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockRejectedValueOnce({ name: "NoSuchKey" });

      await expect(store.get("x.txt")).rejects.toThrow(ObjectNotFoundError);
    });

    it("detects NotFound name without $metadata", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockRejectedValueOnce({ name: "NotFound" });

      await expect(store.get("x.txt")).rejects.toThrow(ObjectNotFoundError);
    });

    it("handles empty object error gracefully (not matched as not-found)", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockRejectedValueOnce({});

      // {} has no `name` → isS3NotFound returns false → re-thrown.
      await expect(store.get("x.txt")).rejects.toEqual({});
    });

    it("handles undefined error gracefully (not matched)", async () => {
      const store = new S3ObjectStore(config);
      m.mockSend.mockRejectedValueOnce(undefined);

      await expect(store.get("x.txt")).rejects.toBeUndefined();
    });
  });

  // ── End-to-end integration-style tests ────────────────────────────────────

  describe("end-to-end flows", () => {
    it("put then get round-trips correctly", async () => {
      const store = new S3ObjectStore(config);

      // put
      m.mockSend.mockResolvedValueOnce(undefined);
      // get
      m.mockSend.mockResolvedValueOnce({
        Body: mockAsyncIterable([Buffer.from("round-trip data")]),
        ContentLength: 15,
        ContentType: "application/json",
        ETag: '"rt123"',
        LastModified: new Date("2026-06-01T00:00:00Z"),
      });

      const putMeta = await store.put(
        "rt.json",
        Buffer.from("round-trip data"),
        { contentType: "application/json" },
      );
      const getResult = await store.get("rt.json");

      expect(putMeta.key).toBe("rt.json");
      expect(putMeta.size).toBe(15);
      expect(getResult.content.toString()).toBe("round-trip data");
      expect(getResult.metadata.etag).toBe('"rt123"');
    });

    it("put then exists then head flows correctly", async () => {
      const store = new S3ObjectStore(config);

      // put
      m.mockSend.mockResolvedValueOnce(undefined);
      await store.put("flow.txt", Buffer.from("flow data"), {
        contentType: "text/plain",
        metadata: { step: "1" },
      });

      // exists (calls head internally)
      m.mockSend.mockResolvedValueOnce({
        ContentLength: 9,
        ContentType: "text/plain",
        ETag: '"flow"',
        LastModified: new Date(),
        Metadata: { step: "1" },
      });
      expect(await store.exists("flow.txt")).toBe(true);

      // head
      m.mockSend.mockResolvedValueOnce({
        ContentLength: 9,
        ContentType: "text/plain",
        ETag: '"flow"',
        LastModified: new Date(),
        Metadata: { step: "1" },
      });
      const headMeta = await store.head("flow.txt");
      expect(headMeta.contentType).toBe("text/plain");
      expect(headMeta.metadata).toEqual({ step: "1" });
    });

    it("put then deleteMany then list shows empty", async () => {
      const store = new S3ObjectStore(config);

      // put three files
      m.mockSend.mockResolvedValue(undefined);
      await store.put("a.txt", Buffer.from("a"));
      await store.put("b.txt", Buffer.from("b"));
      await store.put("c.txt", Buffer.from("c"));

      // deleteMany
      m.mockSend.mockResolvedValue(undefined);
      await store.deleteMany(["a.txt", "b.txt", "c.txt"]);

      // list — empty
      m.mockSend.mockResolvedValue({ IsTruncated: false });
      const listing = await store.list();
      expect(listing.objects).toEqual([]);
    });
  });
});

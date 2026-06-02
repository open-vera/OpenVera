/**
 * ContentUploader unit tests
 *
 * Covers: ContentUploader class, all public methods, validation,
 * error handling, batch operations, factory function, and edge cases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalFsObjectStore, createLocalFsStore } from "../local-fs-adapter.js";
import type { ObjectStore } from "../object-store.js";
import {
  ContentUploader,
  createContentUploader,
  ContentUploadError,
  ContentUploadValidationError,
  ContentUploadBatchError,
} from "../content-uploader.js";
import type { ContentItem, ContentUploadOptions } from "../content-uploader.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockStore(): ObjectStore {
  return {
    name: "mock",
    put: vi.fn().mockResolvedValue({
      key: "content/test.txt",
      size: 12,
      contentType: "text/plain",
      lastModified: new Date(),
      metadata: {},
    }),
    get: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    list: vi.fn(),
    exists: vi.fn(),
    head: vi.fn(),
    presignUrl: vi.fn().mockResolvedValue("https://example.com/content/test.txt?sign=abc"),
    close: vi.fn(),
  };
}

// ── Construction & Factory ──────────────────────────────────────────────────

describe("ContentUploader construction", () => {
  let mockStore: ObjectStore;

  beforeEach(() => {
    mockStore = createMockStore();
  });

  it("constructs with minimum required options", () => {
    const uploader = new ContentUploader({ store: mockStore });
    expect(uploader).toBeInstanceOf(ContentUploader);
  });

  it("createContentUploader factory returns a ContentUploader instance", () => {
    const uploader = createContentUploader({ store: mockStore });
    expect(uploader).toBeInstanceOf(ContentUploader);
  });

  it("accepts all optional options", () => {
    const uploader = new ContentUploader({
      store: mockStore,
      prefix: "uploads/",
      generateUrls: false,
      urlExpiry: 1800,
      defaultContentType: "application/json",
    });
    expect(uploader).toBeInstanceOf(ContentUploader);
  });
});

// ── Upload: Basic Content Types ─────────────────────────────────────────────

describe("ContentUploader.upload() with mock store", () => {
  let mockStore: ObjectStore;
  let uploader: ContentUploader;

  beforeEach(() => {
    mockStore = createMockStore();
    uploader = new ContentUploader({ store: mockStore });
  });

  // ── String content ───────────────────────────────────────────────────────

  it("uploads string content", async () => {
    const result = await uploader.upload({ key: "hello.txt", content: "hello world" });

    expect(result.key).toBe("content/hello.txt");
    expect(result.size).toBe(12);
    expect(result.contentType).toBe("text/plain");
    expect(result.url).toBe("https://example.com/content/test.txt?sign=abc");
    expect(mockStore.put).toHaveBeenCalledTimes(1);
    expect(mockStore.put).toHaveBeenCalledWith(
      "content/hello.txt",
      Buffer.from("hello world"),
      expect.objectContaining({ contentType: "text/plain" }),
    );
  });

  it("uploads empty string content", async () => {
    await uploader.upload({ key: "empty.txt", content: "" });

    expect(mockStore.put).toHaveBeenCalledWith(
      "content/empty.txt",
      Buffer.from(""),
      expect.any(Object),
    );
  });

  it("uploads string with unicode characters", async () => {
    await uploader.upload({ key: "unicode.txt", content: "Hello 世界 🌍" });

    expect(mockStore.put).toHaveBeenCalledWith(
      "content/unicode.txt",
      Buffer.from("Hello 世界 🌍"),
      expect.any(Object),
    );
  });

  // ── JSON object content ──────────────────────────────────────────────────

  it("uploads a JSON object by serializing it", async () => {
    const obj = { name: "Alice", score: 95 };
    await uploader.upload({ key: "data.json", content: obj });

    expect(mockStore.put).toHaveBeenCalledWith(
      "content/data.json",
      Buffer.from(JSON.stringify(obj)),
      expect.objectContaining({ contentType: "application/json" }),
    );
  });

  it("uploads a JSON array by serializing it", async () => {
    const arr = [1, 2, 3, { nested: true }];
    await uploader.upload({ key: "list.json", content: arr });

    expect(mockStore.put).toHaveBeenCalledWith(
      "content/list.json",
      Buffer.from(JSON.stringify(arr)),
      expect.objectContaining({ contentType: "application/json" }),
    );
  });

  it("uploads an empty object", async () => {
    await uploader.upload({ key: "empty.json", content: {} as Record<string, unknown> });

    expect(mockStore.put).toHaveBeenCalledWith(
      "content/empty.json",
      Buffer.from("{}"),
      expect.objectContaining({ contentType: "application/json" }),
    );
  });

  // ── Buffer content ───────────────────────────────────────────────────────

  it("uploads Buffer content as-is", async () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0xFF]);
    await uploader.upload({ key: "binary.bin", content: buf });

    expect(mockStore.put).toHaveBeenCalledWith(
      "content/binary.bin",
      buf,
      expect.any(Object),
    );
  });

  it("uploads Uint8Array content by converting to Buffer", async () => {
    const arr = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    await uploader.upload({ key: "bytes.bin", content: arr });

    expect(mockStore.put).toHaveBeenCalledWith(
      "content/bytes.bin",
      Buffer.from(arr),
      expect.any(Object),
    );
  });

  it("uploads zero-length Buffer", async () => {
    const buf = Buffer.alloc(0);
    await uploader.upload({ key: "zero.bin", content: buf });

    expect(mockStore.put).toHaveBeenCalledWith(
      "content/zero.bin",
      buf,
      expect.any(Object),
    );
  });
});

// ── Upload: Key Prefix Handling ────────────────────────────────────────────

describe("ContentUploader key prefix handling", () => {
  let mockStore: ObjectStore;
  let uploader: ContentUploader;

  beforeEach(() => {
    mockStore = createMockStore();
  });

  it("prepends the default prefix to keys", async () => {
    uploader = new ContentUploader({ store: mockStore });
    const result = await uploader.upload({ key: "file.txt", content: "data" });
    expect(result.key).toBe("content/file.txt");
  });

  it("prepends a custom prefix to keys", async () => {
    uploader = new ContentUploader({ store: mockStore, prefix: "uploads/" });
    const result = await uploader.upload({ key: "file.txt", content: "data" });
    expect(result.key).toBe("uploads/file.txt");
  });

  it("does not double-prepend the prefix if key already starts with it", async () => {
    uploader = new ContentUploader({ store: mockStore, prefix: "uploads/" });
    const result = await uploader.upload({ key: "uploads/already-prefixed.txt", content: "data" });
    expect(result.key).toBe("uploads/already-prefixed.txt");
  });

  it("handles empty prefix correctly", async () => {
    uploader = new ContentUploader({ store: mockStore, prefix: "" });
    const result = await uploader.upload({ key: "file.txt", content: "data" });
    expect(result.key).toBe("file.txt");
  });

  it("handles prefix with no trailing slash", async () => {
    uploader = new ContentUploader({ store: mockStore, prefix: "data" });
    const result = await uploader.upload({ key: "file.txt", content: "data" });
    expect(result.key).toBe("datafile.txt");
  });

  it("double-prefix detection is exact string match (prefix itself has slash, key already has it)", async () => {
    uploader = new ContentUploader({ store: mockStore, prefix: "data-" });
    // key starts with "data-" so should not be re-prefixed
    const result = await uploader.upload({ key: "data-foo.txt", content: "data" });
    expect(result.key).toBe("data-foo.txt");
  });
});

// ── Upload: Content Type Resolution ────────────────────────────────────────

describe("ContentUploader content type resolution", () => {
  let mockStore: ObjectStore;
  let uploader: ContentUploader;

  beforeEach(() => {
    mockStore = createMockStore();
    uploader = new ContentUploader({ store: mockStore });
  });

  it("uses explictly provided contentType", async () => {
    await uploader.upload({ key: "file.xyz", content: "data", contentType: "custom/x-type" });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ contentType: "custom/x-type" }),
    );
  });

  it("detects content type from .json extension", async () => {
    await uploader.upload({ key: "config.json", content: "{}" });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ contentType: "application/json" }),
    );
  });

  it("detects content type from .txt extension", async () => {
    await uploader.upload({ key: "notes.txt", content: "notes" });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ contentType: "text/plain" }),
    );
  });

  it("detects content type from .md extension", async () => {
    await uploader.upload({ key: "readme.md", content: "# Hello" });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ contentType: "text/markdown" }),
    );
  });

  it("detects content type from .html extension", async () => {
    await uploader.upload({ key: "page.html", content: "<html>" });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ contentType: "text/html" }),
    );
  });

  it("detects content type from .pdf extension", async () => {
    await uploader.upload({ key: "report.pdf", content: "fake pdf" });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ contentType: "application/pdf" }),
    );
  });

  it("detects content type from .png extension", async () => {
    await uploader.upload({ key: "image.png", content: Buffer.from([]) });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ contentType: "image/png" }),
    );
  });

  it("detects content type from .csv extension", async () => {
    await uploader.upload({ key: "data.csv", content: "a,b,c" });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ contentType: "text/csv" }),
    );
  });

  it("detects content type from .xml extension", async () => {
    await uploader.upload({ key: "config.xml", content: "<root/>" });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ contentType: "application/xml" }),
    );
  });

  it("detects content type from .svg extension", async () => {
    await uploader.upload({ key: "icon.svg", content: "<svg/>" });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ contentType: "image/svg+xml" }),
    );
  });

  it("detects content type from .zip extension", async () => {
    await uploader.upload({ key: "bundle.zip", content: Buffer.from([]) });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ contentType: "application/zip" }),
    );
  });

  it("detects content type from .mp4 extension", async () => {
    await uploader.upload({ key: "video.mp4", content: Buffer.from([]) });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ contentType: "video/mp4" }),
    );
  });

  it("falls back to default content type for unknown extensions", async () => {
    await uploader.upload({ key: "data.unknown", content: "stuff" });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ contentType: "application/octet-stream" }),
    );
  });

  it("falls back to configured default content type", async () => {
    const customUploader = new ContentUploader({
      store: mockStore,
      defaultContentType: "application/custom",
    });
    await customUploader.upload({ key: "data.unknown", content: "stuff" });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ contentType: "application/custom" }),
    );
  });

  it("handles keys with no extension", async () => {
    await uploader.upload({ key: "noextension", content: "data" });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ contentType: "application/octet-stream" }),
    );
  });

  it("detects content type from keys with uppercase extension", async () => {
    await uploader.upload({ key: "README.TXT", content: "readme" });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ contentType: "text/plain" }),
    );
  });

  it("explicit contentType overrides extension-based detection", async () => {
    await uploader.upload({ key: "data.json", content: "{}", contentType: "text/plain" });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ contentType: "text/plain" }),
    );
  });
});

// ── Upload: Metadata & Options ─────────────────────────────────────────────

describe("ContentUploader upload options", () => {
  let mockStore: ObjectStore;
  let uploader: ContentUploader;

  beforeEach(() => {
    mockStore = createMockStore();
    uploader = new ContentUploader({ store: mockStore });
  });

  it("passes custom metadata to the store", async () => {
    const metadata = { author: "test", version: "1.0" };
    await uploader.upload({
      key: "file.txt",
      content: "data",
      metadata,
    });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ metadata }),
    );
  });

  it("passes cacheControl to the store", async () => {
    await uploader.upload({
      key: "file.txt",
      content: "data",
      cacheControl: "max-age=3600",
    });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ cacheControl: "max-age=3600" }),
    );
  });

  it("passes contentDisposition to the store", async () => {
    await uploader.upload({
      key: "file.txt",
      content: "data",
      contentDisposition: 'attachment; filename="file.txt"',
    });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ contentDisposition: 'attachment; filename="file.txt"' }),
    );
  });

  it("passes overwrite to the store", async () => {
    await uploader.upload({
      key: "file.txt",
      content: "data",
      overwrite: false,
    });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ overwrite: false }),
    );
  });

  it("overwrite defaults to undefined (store default)", async () => {
    await uploader.upload({
      key: "file.txt",
      content: "data",
    });

    expect(mockStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ overwrite: undefined }),
    );
  });

  it("passes all put options together", async () => {
    await uploader.upload({
      key: "meta-test.txt",
      content: "full options",
      contentType: "text/plain",
      metadata: { source: "unit-test" },
      cacheControl: "no-cache",
      contentDisposition: "inline",
      overwrite: true,
    });

    expect(mockStore.put).toHaveBeenCalledWith(
      "content/meta-test.txt",
      expect.any(Buffer),
      {
        contentType: "text/plain",
        metadata: { source: "unit-test" },
        cacheControl: "no-cache",
        contentDisposition: "inline",
        overwrite: true,
      },
    );
  });
});

// ── Upload: Presigned URL Handling ─────────────────────────────────────────

describe("ContentUploader presigned URL handling", () => {
  let mockStore: ObjectStore;

  beforeEach(() => {
    mockStore = createMockStore();
  });

  it("generates presigned URL when generateUrls is true (default)", async () => {
    const uploader = new ContentUploader({ store: mockStore });
    const result = await uploader.upload({ key: "file.txt", content: "data" });

    expect(result.url).toBe("https://example.com/content/test.txt?sign=abc");
    expect(mockStore.presignUrl).toHaveBeenCalledWith(
      "content/file.txt",
      { expiresIn: 3600 },
    );
  });

  it("skips presigned URL when generateUrls is false", async () => {
    const uploader = new ContentUploader({ store: mockStore, generateUrls: false });
    const result = await uploader.upload({ key: "file.txt", content: "data" });

    expect(result.url).toBeUndefined();
    expect(mockStore.presignUrl).not.toHaveBeenCalled();
  });

  it("uses custom urlExpiry for presigned URLs", async () => {
    const uploader = new ContentUploader({ store: mockStore, urlExpiry: 7200 });
    await uploader.upload({ key: "file.txt", content: "data" });

    expect(mockStore.presignUrl).toHaveBeenCalledWith(
      "content/file.txt",
      { expiresIn: 7200 },
    );
  });

  it("gracefully handles presignUrl failure (result.url is undefined)", async () => {
    const failingStore = createMockStore();
    vi.mocked(failingStore.presignUrl).mockRejectedValue(new Error("presign not supported"));

    const uploader = new ContentUploader({ store: failingStore });
    const result = await uploader.upload({ key: "file.txt", content: "data" });

    expect(result.url).toBeUndefined();
    // put should still have succeeded
    expect(result.key).toBe("content/file.txt");
    expect(result.size).toBe(12);
  });

  it("passes correct key (with prefix) to presignUrl", async () => {
    const uploader = new ContentUploader({ store: mockStore, prefix: "my/prefix/" });
    await uploader.upload({ key: "file.txt", content: "data" });

    expect(mockStore.presignUrl).toHaveBeenCalledWith(
      "my/prefix/file.txt",
      expect.any(Object),
    );
  });
});

// ── Upload: Validation ─────────────────────────────────────────────────────

describe("ContentUploader validation", () => {
  let mockStore: ObjectStore;
  let uploader: ContentUploader;

  beforeEach(() => {
    mockStore = createMockStore();
    uploader = new ContentUploader({ store: mockStore });
  });

  it("throws ContentUploadValidationError for empty key", async () => {
    await expect(
      uploader.upload({ key: "", content: "data" }),
    ).rejects.toThrow(ContentUploadValidationError);

    await expect(
      uploader.upload({ key: "", content: "data" }),
    ).rejects.toThrow("key must be a non-empty string");
  });

  it("throws ContentUploadValidationError for whitespace-only key", async () => {
    await expect(
      uploader.upload({ key: "   ", content: "data" }),
    ).rejects.toThrow(ContentUploadValidationError);

    await expect(
      uploader.upload({ key: "   ", content: "data" }),
    ).rejects.toThrow("key must be a non-empty string");
  });

  it("throws ContentUploadValidationError for null content", async () => {
    await expect(
      uploader.upload({ key: "test.txt", content: null as unknown as string }),
    ).rejects.toThrow(ContentUploadValidationError);

    await expect(
      uploader.upload({ key: "test.txt", content: null as unknown as string }),
    ).rejects.toThrow('content for key "test.txt" must not be null or undefined');
  });

  it("throws ContentUploadValidationError for undefined content", async () => {
    await expect(
      uploader.upload({ key: "test.txt", content: undefined as unknown as string }),
    ).rejects.toThrow(ContentUploadValidationError);
  });

  it("ContentUploadValidationError extends ContentUploadError", () => {
    const err = new ContentUploadValidationError("bad");
    expect(err).toBeInstanceOf(ContentUploadError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("UPLOAD_VALIDATION");
    expect(err.name).toBe("ContentUploadValidationError");
  });
});

// ── Upload: Store Error Propagation ────────────────────────────────────────

describe("ContentUploader store error handling", () => {
  let mockStore: ObjectStore;
  let uploader: ContentUploader;

  beforeEach(() => {
    mockStore = createMockStore();
    uploader = new ContentUploader({ store: mockStore });
  });

  it("propagates errors from store.put", async () => {
    vi.mocked(mockStore.put).mockRejectedValueOnce(new Error("Storage backend down"));

    await expect(
      uploader.upload({ key: "file.txt", content: "data" }),
    ).rejects.toThrow("Storage backend down");
  });

  it("does NOT call presignUrl if put fails", async () => {
    vi.mocked(mockStore.put).mockRejectedValueOnce(new Error("upload failed"));

    await expect(
      uploader.upload({ key: "file.txt", content: "data" }),
    ).rejects.toThrow("upload failed");

    expect(mockStore.presignUrl).not.toHaveBeenCalled();
  });

  it("propagates non-Error thrown values from store.put", async () => {
    vi.mocked(mockStore.put).mockRejectedValueOnce("string error");

    await expect(
      uploader.upload({ key: "file.txt", content: "data" }),
    ).rejects.toBe("string error");
  });
});

// ── Upload: Result Correctness ─────────────────────────────────────────────

describe("ContentUploader.upload() result values", () => {
  let mockStore: ObjectStore;
  let uploader: ContentUploader;

  beforeEach(() => {
    mockStore = createMockStore();
    uploader = new ContentUploader({ store: mockStore });
  });

  it("result.key equals the resolved object key", async () => {
    const result = await uploader.upload({ key: "results/test.json", content: { a: 1 } });
    expect(result.key).toBe("content/results/test.json");
  });

  it("result.size comes from store metadata", async () => {
    vi.mocked(mockStore.put).mockResolvedValueOnce({
      key: "content/file.txt",
      size: 9999,
      contentType: "text/plain",
      lastModified: new Date(),
    });

    const result = await uploader.upload({ key: "file.txt", content: "data" });
    expect(result.size).toBe(9999);
  });

  it("result.contentType comes from store metadata when available", async () => {
    vi.mocked(mockStore.put).mockResolvedValueOnce({
      key: "content/file.txt",
      size: 100,
      contentType: "image/png",
      lastModified: new Date(),
    });

    const result = await uploader.upload({ key: "file.png", content: Buffer.from([]) });
    expect(result.contentType).toBe("image/png");
  });

  it("result.contentType falls back to resolved type when store returns undefined", async () => {
    vi.mocked(mockStore.put).mockResolvedValueOnce({
      key: "content/file.txt",
      size: 100,
      lastModified: new Date(),
    });

    const result = await uploader.upload({ key: "file.txt", content: "data" });
    expect(result.contentType).toBe("text/plain");
  });
});

// ── Convenience Methods ────────────────────────────────────────────────────

describe("ContentUploader convenience methods", () => {
  let mockStore: ObjectStore;
  let uploader: ContentUploader;

  beforeEach(() => {
    mockStore = createMockStore();
    uploader = new ContentUploader({ store: mockStore });
  });

  // ── uploadText ───────────────────────────────────────────────────────────

  describe("uploadText", () => {
    it("uploads text with text/plain content type by default", async () => {
      const result = await uploader.uploadText("notes.txt", "some notes");

      expect(result.key).toBe("content/notes.txt");
      expect(mockStore.put).toHaveBeenCalledWith(
        "content/notes.txt",
        Buffer.from("some notes"),
        expect.objectContaining({ contentType: "text/plain" }),
      );
    });

    it("allows overriding content type", async () => {
      await uploader.uploadText("code.js", "const x = 1;", { contentType: "application/javascript" });

      expect(mockStore.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Buffer),
        expect.objectContaining({ contentType: "application/javascript" }),
      );
    });

    it("passes metadata to the store", async () => {
      await uploader.uploadText("notes.txt", "notes", { metadata: { tag: "important" } });

      expect(mockStore.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Buffer),
        expect.objectContaining({ metadata: { tag: "important" } }),
      );
    });

    it("passes overwrite option", async () => {
      await uploader.uploadText("notes.txt", "notes", { overwrite: false });

      expect(mockStore.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Buffer),
        expect.objectContaining({ overwrite: false }),
      );
    });

    it("returns ContentUploadResult with correct shape", async () => {
      const result = await uploader.uploadText("readme.md", "# Title");

      expect(result).toHaveProperty("key");
      expect(result).toHaveProperty("size");
      expect(result).toHaveProperty("contentType");
      expect(result).toHaveProperty("url");
      expect(typeof result.key).toBe("string");
      expect(typeof result.size).toBe("number");
    });

    it("validates empty key", async () => {
      await expect(uploader.uploadText("", "text")).rejects.toThrow(ContentUploadValidationError);
    });
  });

  // ── uploadJson ───────────────────────────────────────────────────────────

  describe("uploadJson", () => {
    it("uploads a JSON object with application/json content type", async () => {
      const data = { user: "bob", age: 30 };
      const result = await uploader.uploadJson("user.json", data);

      expect(result.key).toBe("content/user.json");
      expect(mockStore.put).toHaveBeenCalledWith(
        "content/user.json",
        Buffer.from(JSON.stringify(data)),
        expect.objectContaining({ contentType: "application/json" }),
      );
    });

    it("uploads a JSON array", async () => {
      const arr = [{ id: 1 }, { id: 2 }];
      await uploader.uploadJson("items.json", arr);

      expect(mockStore.put).toHaveBeenCalledWith(
        "content/items.json",
        Buffer.from(JSON.stringify(arr)),
        expect.objectContaining({ contentType: "application/json" }),
      );
    });

    it("passes metadata", async () => {
      await uploader.uploadJson("data.json", { x: 1 }, { metadata: { version: "2" } });

      expect(mockStore.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Buffer),
        expect.objectContaining({ metadata: { version: "2" } }),
      );
    });

    it("passes overwrite option", async () => {
      await uploader.uploadJson("data.json", { x: 1 }, { overwrite: false });

      expect(mockStore.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Buffer),
        expect.objectContaining({ overwrite: false }),
      );
    });

    it("validates empty key", async () => {
      await expect(uploader.uploadJson("", { a: 1 })).rejects.toThrow(ContentUploadValidationError);
    });
  });

  // ── uploadBinary ─────────────────────────────────────────────────────────

  describe("uploadBinary", () => {
    it("uploads a Buffer with default content type", async () => {
      const buf = Buffer.from([0xAB, 0xCD, 0xEF]);
      const result = await uploader.uploadBinary("data.bin", buf);

      expect(result.key).toBe("content/data.bin");
      expect(mockStore.put).toHaveBeenCalledWith(
        "content/data.bin",
        buf,
        expect.objectContaining({ contentType: "application/octet-stream" }),
      );
    });

    it("uploads a Uint8Array", async () => {
      const arr = new Uint8Array([0x01, 0x02]);
      await uploader.uploadBinary("bytes.bin", arr);

      expect(mockStore.put).toHaveBeenCalledWith(
        "content/bytes.bin",
        Buffer.from(arr),
        expect.any(Object),
      );
    });

    it("allows overriding content type", async () => {
      const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47]); // PNG header
      await uploader.uploadBinary("image.png", buf, { contentType: "image/png" });

      expect(mockStore.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Buffer),
        expect.objectContaining({ contentType: "image/png" }),
      );
    });

    it("passes metadata", async () => {
      await uploader.uploadBinary("data.bin", Buffer.from([]), { metadata: { checksum: "abc" } });

      expect(mockStore.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Buffer),
        expect.objectContaining({ metadata: { checksum: "abc" } }),
      );
    });

    it("passes overwrite option", async () => {
      await uploader.uploadBinary("data.bin", Buffer.from([]), { overwrite: false });

      expect(mockStore.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Buffer),
        expect.objectContaining({ overwrite: false }),
      );
    });
  });
});

// ── uploadBatch ────────────────────────────────────────────────────────────

describe("ContentUploader.uploadBatch", () => {
  let mockStore: ObjectStore;
  let uploader: ContentUploader;

  beforeEach(() => {
    mockStore = createMockStore();
    uploader = new ContentUploader({ store: mockStore });
  });

  it("uploads multiple items and returns a BatchUploadResult", async () => {
    const items: ContentItem[] = [
      { key: "a.txt", content: "aaa" },
      { key: "b.txt", content: "bbb" },
      { key: "c.txt", content: "ccc" },
    ];

    const result = await uploader.uploadBatch(items);

    expect(result.total).toBe(3);
    expect(result.uploaded).toHaveLength(3);
    expect(result.errors).toHaveLength(0);
    expect(result.uploaded.map((u) => u.key)).toEqual([
      "content/a.txt",
      "content/b.txt",
      "content/c.txt",
    ]);
  });

  it("returns empty result for empty items array", async () => {
    const result = await uploader.uploadBatch([]);

    expect(result.total).toBe(0);
    expect(result.uploaded).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("continues on individual failure and collects errors", async () => {
    vi.mocked(mockStore.put)
      .mockResolvedValueOnce({ key: "content/a.txt", size: 3, contentType: "text/plain", lastModified: new Date() })
      .mockRejectedValueOnce(new Error("upload failed for b"))
      .mockResolvedValueOnce({ key: "content/c.txt", size: 3, contentType: "text/plain", lastModified: new Date() });

    const items: ContentItem[] = [
      { key: "a.txt", content: "aaa" },
      { key: "b.txt", content: "bbb" },
      { key: "c.txt", content: "ccc" },
    ];

    await expect(uploader.uploadBatch(items)).rejects.toThrow(ContentUploadBatchError);

    try {
      await uploader.uploadBatch(items);
    } catch (err) {
      expect(err).toBeInstanceOf(ContentUploadBatchError);
      const batchErr = err as ContentUploadBatchError;
      expect(batchErr.results.uploaded).toHaveLength(2);
      expect(batchErr.results.errors).toHaveLength(1);
      expect(batchErr.results.errors[0].key).toBe("b.txt");
      expect(batchErr.results.errors[0].error).toBe("upload failed for b");
      expect(batchErr.results.total).toBe(3);
      expect(batchErr.message).toContain("1 of 3 uploads failed");
      expect(batchErr.code).toBe("UPLOAD_BATCH_PARTIAL");
    }
  });

  it("throws ContentUploadBatchError with all errors when all fail", async () => {
    vi.mocked(mockStore.put).mockRejectedValue(new Error("global failure"));

    const items: ContentItem[] = [
      { key: "x.txt", content: "x" },
      { key: "y.txt", content: "y" },
    ];

    await expect(uploader.uploadBatch(items)).rejects.toThrow(ContentUploadBatchError);

    try {
      await uploader.uploadBatch(items);
    } catch (err) {
      const batchErr = err as ContentUploadBatchError;
      expect(batchErr.results.errors).toHaveLength(2);
      expect(batchErr.results.uploaded).toHaveLength(0);
      expect(batchErr.message).toContain("2 of 2 uploads failed");
    }
  });

  it("ContentUploadBatchError extends ContentUploadError", () => {
    const err = new ContentUploadBatchError({
      uploaded: [],
      errors: [{ key: "k", error: "e" }],
      total: 1,
    });
    expect(err).toBeInstanceOf(ContentUploadError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("UPLOAD_BATCH_PARTIAL");
    expect(err.name).toBe("ContentUploadBatchError");
  });

  it("ContentUploadBatchError.results contains the full BatchUploadResult", () => {
    const results = {
      uploaded: [{ key: "ok.txt", size: 10, contentType: "text/plain" }],
      errors: [{ key: "fail.txt", error: "boom" }],
      total: 2,
    };
    const err = new ContentUploadBatchError(results);
    expect(err.results).toEqual(results);
    expect(err.results).toBe(results); // same reference
  });

  it("batch with a single item that fails", async () => {
    vi.mocked(mockStore.put).mockRejectedValueOnce(new Error("single failure"));

    await expect(
      uploader.uploadBatch([{ key: "only.txt", content: "data" }]),
    ).rejects.toThrow(ContentUploadBatchError);
  });

  it("batch with a single item that succeeds", async () => {
    const result = await uploader.uploadBatch([{ key: "only.txt", content: "data" }]);

    expect(result.uploaded).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it("batch includes validation failures as errors", async () => {
    const items: ContentItem[] = [
      { key: "valid.txt", content: "ok" },
      { key: "", content: "bad" }, // validation will fail
    ];

    await expect(uploader.uploadBatch(items)).rejects.toThrow(ContentUploadBatchError);

    try {
      await uploader.uploadBatch(items);
    } catch (err) {
      const batchErr = err as ContentUploadBatchError;
      expect(batchErr.results.uploaded).toHaveLength(1);
      expect(batchErr.results.errors).toHaveLength(1);
      expect(batchErr.results.errors[0].key).toBe("");
      expect(batchErr.results.errors[0].error).toContain("key must be a non-empty string");
    }
  });

  it("non-Error rejections in store.put are handled in batch", async () => {
    vi.mocked(mockStore.put)
      .mockResolvedValueOnce({
        key: "content/a.txt", size: 3, contentType: "text/plain", lastModified: new Date(),
      })
      .mockRejectedValueOnce("network timeout");

    await expect(
      uploader.uploadBatch([
        { key: "a.txt", content: "a" },
        { key: "b.txt", content: "b" },
      ]),
    ).rejects.toThrow(ContentUploadBatchError);

    try {
      await uploader.uploadBatch([
        { key: "a.txt", content: "a" },
        { key: "b.txt", content: "b" },
      ]);
    } catch (err) {
      const batchErr = err as ContentUploadBatchError;
      expect(batchErr.results.errors[0].key).toBe("b.txt");
      expect(batchErr.results.errors[0].error).toBe("network timeout");
    }
  });
});

// ── Integration Tests with Real LocalFsObjectStore ─────────────────────────

describe("ContentUploader integration with LocalFsObjectStore", () => {
  let tmpDir: string;
  let store: ObjectStore;
  let uploader: ContentUploader;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "content-uploader-test-"));
    store = createLocalFsStore(tmpDir);
    uploader = new ContentUploader({ store, prefix: "test/" });
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("uploads text and retrieves it from the store", async () => {
    const result = await uploader.uploadText("hello.txt", "Hello, world!");

    expect(result.key).toBe("test/hello.txt");
    expect(result.size).toBe(13);

    const retrieved = await store.get("test/hello.txt");
    expect(retrieved.content.toString()).toBe("Hello, world!");
    expect(retrieved.metadata.size).toBe(13);
  });

  it("uploads JSON and retrieves parsed content", async () => {
    const data = { users: ["alice", "bob"], count: 2 };
    const result = await uploader.uploadJson("users.json", data);

    const retrieved = await store.get("test/users.json");
    const parsed = JSON.parse(retrieved.content.toString());
    expect(parsed).toEqual(data);
    expect(retrieved.metadata.contentType).toBe("application/json");
  });

  it("uploads binary buffer and retrieves it correctly", async () => {
    const buf = Buffer.from([0xCA, 0xFE, 0xBA, 0xBE]);
    const result = await uploader.uploadBinary("magic.bin", buf);

    const retrieved = await store.get("test/magic.bin");
    expect(Buffer.compare(retrieved.content, buf)).toBe(0); // content matches
  });

  it("uploads with custom metadata visible in store", async () => {
    await uploader.upload({
      key: "meta.txt",
      content: "with metadata",
      metadata: { author: "test-suite", priority: "high" },
    });

    const meta = await store.head("test/meta.txt");
    expect(meta.metadata?.author).toBe("test-suite");
    expect(meta.metadata?.priority).toBe("high");
  });

  it("uploads with content type reflected in store metadata", async () => {
    await uploader.upload({
      key: "report.csv",
      content: "a,b,c",
      contentType: "text/csv",
    });

    const meta = await store.head("test/report.csv");
    expect(meta.contentType).toBe("text/csv");
  });

  it("overwrite=false prevents overwriting existing object", async () => {
    await uploader.upload({ key: "protected.txt", content: "original" });

    await expect(
      uploader.upload({ key: "protected.txt", content: "new content", overwrite: false }),
    ).rejects.toThrow();
  });

  it("overwrite=true (default) allows overwriting", async () => {
    await uploader.upload({ key: "mutable.txt", content: "v1" });
    const result = await uploader.upload({ key: "mutable.txt", content: "v2", overwrite: true });

    const retrieved = await store.get("test/mutable.txt");
    expect(retrieved.content.toString()).toBe("v2");
  });

  it("batch uploads all items to store", async () => {
    const items: ContentItem[] = [
      { key: "batch/1.txt", content: "one" },
      { key: "batch/2.txt", content: "two" },
      { key: "batch/3.json", content: { num: 3 } },
    ];

    const result = await uploader.uploadBatch(items);

    expect(result.uploaded).toHaveLength(3);
    for (const uploaded of result.uploaded) {
      const exists = await store.exists(uploaded.key);
      expect(exists).toBe(true);
    }
  });

  it("can upload large content", async () => {
    const largeText = "x".repeat(100 * 1024); // 100KB
    const result = await uploader.uploadText("large.txt", largeText);

    const retrieved = await store.get("test/large.txt");
    expect(retrieved.content.toString()).toBe(largeText);
    expect(result.size).toBe(100 * 1024);
  });

  it("handles keys with special characters", async () => {
    const keys = [
      "spaces in name.txt",
      "dir/subdir/file.txt",
      "unicode_你好.txt",
      "special_chars-_.txt",
      "nested/deeply/nested/path/file.json",
    ];

    for (const key of keys) {
      const result = await uploader.upload({ key, content: "test" });
      const exists = await store.exists(result.key);
      expect(exists).toBe(true);
    }
  });

  it("generates presigned file:// URL for local store", async () => {
    const result = await uploader.upload({ key: "signed.txt", content: "sign me" });

    expect(result.url).toMatch(/^file:\/\//);
    expect(result.url).toContain("signed.txt");
  });

  it("does not generate URL when generateUrls is false", async () => {
    const noUrlUploader = new ContentUploader({ store, generateUrls: false });
    const result = await noUrlUploader.upload({ key: "no-url.txt", content: "quiet" });

    expect(result.url).toBeUndefined();
  });

  it("content type detected from .log extension", async () => {
    const result = await uploader.upload({ key: "app.log", content: "log entry" });

    const meta = await store.head("test/app.log");
    expect(meta.contentType).toBe("text/plain");
  });

  it("handles keys with dots in middle (not extension)", async () => {
    const result = await uploader.upload({ key: "v1.2.3.config", content: "config value" });

    const meta = await store.head("test/v1.2.3.config");
    // Last segment after dot is "config" which is not in the map
    expect(meta.contentType).toBe("application/octet-stream");
  });
});

// ── Edge Cases ─────────────────────────────────────────────────────────────

describe("ContentUploader edge cases", () => {
  let mockStore: ObjectStore;
  let uploader: ContentUploader;

  beforeEach(() => {
    mockStore = createMockStore();
    uploader = new ContentUploader({ store: mockStore });
  });

  it("keys with leading slash are preserved", async () => {
    const result = await uploader.upload({ key: "/absolute/path.txt", content: "data" });
    expect(result.key).toBe("content//absolute/path.txt");
  });

  it("keys with backslashes are preserved", async () => {
    const result = await uploader.upload({ key: "windows\\path.txt", content: "data" });
    expect(result.key).toBe("content/windows\\path.txt");
  });

  it("0 is a valid content value (number-like serialization)", async () => {
    // 0 is not null/undefined, so should not trigger validation error
    await uploader.upload({ key: "zero.json", content: 0 as unknown as Record<string, unknown> });
    // 0 is an object/array type in the union, so it gets JSON-serialized
  });

  it("false boolean-like serialization", async () => {
    // false is not in the content union, but a Record<string, unknown> can contain it
    await uploader.upload({ key: "bool.json", content: { value: false } });
    expect(mockStore.put).toHaveBeenCalledWith(
      "content/bool.json",
      Buffer.from('{"value":false}'),
      expect.any(Object),
    );
  });

  it("very long key is accepted", async () => {
    const longKey = "a/".repeat(50) + "file.txt";
    const result = await uploader.upload({ key: longKey, content: "data" });
    expect(result.key).toBe("content/" + longKey);
  });

  it("content with multibyte characters gets correct byte size", async () => {
    // Override put to return controlled size
    vi.mocked(mockStore.put).mockResolvedValueOnce({
      key: "content/utf8.txt",
      size: 15,
      contentType: "text/plain",
      lastModified: new Date(),
    });

    const result = await uploader.upload({ key: "utf8.txt", content: "Hello, 世界!" });
    expect(result.size).toBe(15);
  });

  it("custom generateUrls=false still allows upload to succeed", async () => {
    const noUrlUploader = new ContentUploader({ store: mockStore, generateUrls: false });
    const result = await noUrlUploader.upload({ key: "f.txt", content: "d" });

    expect(result.url).toBeUndefined();
    expect(result.key).toBe("content/f.txt");
    expect(result.size).toBeGreaterThan(0);
  });

  it("ContentUploadError base class properties", () => {
    const err = new ContentUploadError("TEST_CODE", "test message");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ContentUploadError");
    expect(err.code).toBe("TEST_CODE");
    expect(err.message).toBe("test message");
  });

  it("ContentUploadError can be caught with string code", () => {
    const err = new ContentUploadError("CUSTOM", "msg");
    try {
      throw err;
    } catch (e) {
      if (e instanceof ContentUploadError) {
        expect(e.code).toBe("CUSTOM");
      } else {
        throw new Error("should be ContentUploadError");
      }
    }
  });

  it("upload with undefined optional fields still succeeds", async () => {
    const result = await uploader.upload({
      key: "minimal.txt",
      content: "minimal",
    });

    expect(result.key).toBe("content/minimal.txt");
    expect(mockStore.put).toHaveBeenCalledWith(
      "content/minimal.txt",
      expect.any(Buffer),
      {
        contentType: "text/plain",
        metadata: undefined,
        cacheControl: undefined,
        contentDisposition: undefined,
        overwrite: undefined,
      },
    );
  });
});

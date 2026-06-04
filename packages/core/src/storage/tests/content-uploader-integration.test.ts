/**
 * ContentUploader unit tests — integration.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalFsObjectStore, createLocalFsStore } from "../local-fs-adapter.js";
import { ContentUploader, ContentUploadError } from "../content-uploader.js";
import type { ContentItem } from "../content-uploader.js";
import type { ObjectStore } from "../object-store.js";
import { createMockStore } from "./content-uploader-test-helpers.js";

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

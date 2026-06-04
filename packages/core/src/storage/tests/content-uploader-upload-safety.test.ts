/**
 * ContentUploader unit tests — upload safety.test
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ContentUploader, ContentUploadError, ContentUploadValidationError } from "../content-uploader.js";
import type { ObjectStore } from "../object-store.js";
import { createMockStore } from "./content-uploader-test-helpers.js";

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

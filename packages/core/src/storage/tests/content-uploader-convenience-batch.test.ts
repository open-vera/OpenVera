/**
 * ContentUploader unit tests — convenience batch.test
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { LocalFsObjectStore } from "../local-fs-adapter.js";
import { ContentUploader, ContentUploadError, ContentUploadValidationError, ContentUploadBatchError } from "../content-uploader.js";
import type { ContentItem } from "../content-uploader.js";
import type { ObjectStore } from "../object-store.js";
import { createMockStore } from "./content-uploader-test-helpers.js";

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

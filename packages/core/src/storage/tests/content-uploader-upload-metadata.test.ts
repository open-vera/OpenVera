/**
 * ContentUploader unit tests — upload metadata.test
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ContentUploader } from "../content-uploader.js";
import type { ObjectStore } from "../object-store.js";
import { createMockStore } from "./content-uploader-test-helpers.js";

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

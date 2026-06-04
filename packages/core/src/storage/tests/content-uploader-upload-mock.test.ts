/**
 * ContentUploader unit tests — upload mock.test
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ContentUploader } from "../content-uploader.js";
import type { ObjectStore } from "../object-store.js";
import { createMockStore } from "./content-uploader-test-helpers.js";

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

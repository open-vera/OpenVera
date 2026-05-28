import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFileUploadTool,
  createFileDownloadTool,
  createFileListTool,
  createStorageTools,
} from "../storage.js";
import type { ToolContext } from "../types.js";

// Mock fs/promises
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

import { readFile, stat, writeFile, mkdir } from "node:fs/promises";

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    cwd: "/tmp/test",
    sessionId: "session-1",
    objectStore: {
      put: vi.fn().mockResolvedValue({ size: 1024 }),
      get: vi.fn().mockResolvedValue({ content: Buffer.from("hello"), metadata: { size: 5 } }),
      list: vi.fn().mockResolvedValue({ objects: [], prefixes: [], isTruncated: false }),
      presignUrl: vi.fn().mockResolvedValue("https://example.com/file"),
    },
    ...overrides,
  } as ToolContext;
}

describe("file_upload tool", () => {
  const tool = createFileUploadTool();

  it("returns tool def with correct name", () => {
    expect(tool.name).toBe("file_upload");
  });

  it("returns error when objectStore is not available", async () => {
    const ctx = makeCtx({ objectStore: undefined });
    const result = await tool.execute({ key: "test.txt", content: "hello" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
  });

  it("returns error when neither localPath nor content provided", async () => {
    const ctx = makeCtx();
    const result = await tool.execute({ key: "test.txt" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Provide either localPath or content");
  });

  it("uploads inline content successfully", async () => {
    const ctx = makeCtx();
    const result = await tool.execute({ key: "reports/test.txt", content: "hello world" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Uploaded: reports/test.txt");
    expect(result.content).toContain("Size:");
    expect(result.content).toContain("URL:");
    expect(ctx.objectStore!.put).toHaveBeenCalledWith(
      "reports/test.txt",
      Buffer.from("hello world", "utf-8"),
      expect.objectContaining({ contentType: "text/plain" })
    );
  });

  it("uploads from localPath successfully", async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as any);
    vi.mocked(readFile).mockResolvedValue(Buffer.from("file content"));
    const ctx = makeCtx();
    const result = await tool.execute({ key: "data.bin", localPath: "/tmp/data.bin" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Uploaded: data.bin");
  });

  it("returns error when localPath is not a file", async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => false } as any);
    const ctx = makeCtx();
    const result = await tool.execute({ key: "dir", localPath: "/tmp/dir" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
  });

  it("uses custom contentType", async () => {
    const ctx = makeCtx();
    await tool.execute({ key: "f.dat", content: "x", contentType: "application/octet-stream" }, ctx);
    expect(ctx.objectStore!.put).toHaveBeenCalledWith(
      "f.dat",
      expect.any(Buffer),
      expect.objectContaining({ contentType: "application/octet-stream" })
    );
  });

  it("handles presignUrl failure gracefully", async () => {
    const ctx = makeCtx();
    vi.mocked(ctx.objectStore!.presignUrl).mockRejectedValue(new Error("not supported"));
    const result = await tool.execute({ key: "f.txt", content: "x" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).not.toContain("URL:");
  });

  it("handles store.put failure", async () => {
    const ctx = makeCtx();
    vi.mocked(ctx.objectStore!.put).mockRejectedValue(new Error("disk full"));
    const result = await tool.execute({ key: "f.txt", content: "x" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("disk full");
  });

  it("guesses content types from extension", async () => {
    const ctx = makeCtx();
    await tool.execute({ key: "img.png", content: "png" }, ctx);
    expect(ctx.objectStore!.put).toHaveBeenCalledWith(
      "img.png",
      expect.any(Buffer),
      expect.objectContaining({ contentType: "image/png" })
    );
  });
});

describe("file_download tool", () => {
  const tool = createFileDownloadTool();

  it("returns tool def with correct name", () => {
    expect(tool.name).toBe("file_download");
  });

  it("returns error when objectStore is not available", async () => {
    const ctx = makeCtx({ objectStore: undefined });
    const result = await tool.execute({ key: "test.txt" }, ctx);
    expect(result.ok).toBe(false);
  });

  it("returns content as text when no localPath", async () => {
    const ctx = makeCtx();
    vi.mocked(ctx.objectStore!.get).mockResolvedValue({
      content: Buffer.from("file data"),
      metadata: { size: 9 },
    });
    const result = await tool.execute({ key: "test.txt" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("file data");
  });

  it("truncates large content", async () => {
    const ctx = makeCtx();
    const bigContent = "x".repeat(200 * 1024);
    vi.mocked(ctx.objectStore!.get).mockResolvedValue({
      content: Buffer.from(bigContent),
      metadata: { size: bigContent.length },
    });
    const result = await tool.execute({ key: "big.txt" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("truncated");
  });

  it("saves to localPath when provided", async () => {
    const ctx = makeCtx();
    vi.mocked(ctx.objectStore!.get).mockResolvedValue({
      content: Buffer.from("saved"),
      metadata: { size: 5 },
    });
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    const result = await tool.execute({ key: "f.txt", localPath: "/tmp/out/f.txt" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Downloaded f.txt to /tmp/out/f.txt");
    expect(mkdir).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalled();
  });

  it("handles store.get failure", async () => {
    const ctx = makeCtx();
    vi.mocked(ctx.objectStore!.get).mockRejectedValue(new Error("not found"));
    const result = await tool.execute({ key: "missing.txt" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("not found");
  });
});

describe("file_list tool", () => {
  const tool = createFileListTool();

  it("returns tool def with correct name", () => {
    expect(tool.name).toBe("file_list");
  });

  it("returns error when objectStore is not available", async () => {
    const ctx = makeCtx({ objectStore: undefined });
    const result = await tool.execute({}, ctx);
    expect(result.ok).toBe(false);
  });

  it("lists files successfully", async () => {
    const ctx = makeCtx();
    vi.mocked(ctx.objectStore!.list).mockResolvedValue({
      objects: [
        { key: "a.txt", size: 100, lastModified: new Date("2026-01-01T12:00:00Z") },
        { key: "b.pdf", size: 2048, lastModified: null },
      ],
      prefixes: ["reports/"],
      isTruncated: false,
    });
    const result = await tool.execute({ prefix: "" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Directories:");
    expect(result.content).toContain("reports/");
    expect(result.content).toContain("a.txt");
    expect(result.content).toContain("b.pdf");
  });

  it("shows empty message when no results", async () => {
    const ctx = makeCtx();
    vi.mocked(ctx.objectStore!.list).mockResolvedValue({
      objects: [],
      prefixes: [],
      isTruncated: false,
    });
    const result = await tool.execute({}, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("No files found.");
  });

  it("shows continuation token when truncated", async () => {
    const ctx = makeCtx();
    vi.mocked(ctx.objectStore!.list).mockResolvedValue({
      objects: [{ key: "f.txt", size: 10, lastModified: null }],
      prefixes: [],
      isTruncated: true,
      continuationToken: "abc123",
    });
    const result = await tool.execute({}, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("continuationToken: abc123");
  });

  it("passes options to store.list", async () => {
    const ctx = makeCtx();
    await tool.execute({ prefix: "docs/", delimiter: "/", maxKeys: 50, continuationToken: "tok" }, ctx);
    expect(ctx.objectStore!.list).toHaveBeenCalledWith({
      prefix: "docs/",
      delimiter: "/",
      maxKeys: 50,
      continuationToken: "tok",
    });
  });

  it("uses default maxKeys of 100", async () => {
    const ctx = makeCtx();
    await tool.execute({}, ctx);
    expect(ctx.objectStore!.list).toHaveBeenCalledWith(
      expect.objectContaining({ maxKeys: 100 })
    );
  });
});

describe("createStorageTools", () => {
  it("returns all three tools", () => {
    const tools = createStorageTools();
    expect(tools.fileUpload.name).toBe("file_upload");
    expect(tools.fileDownload.name).toBe("file_download");
    expect(tools.fileList.name).toBe("file_list");
  });
});

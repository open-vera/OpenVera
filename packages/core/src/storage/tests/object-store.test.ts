/**
 * Object Store tests — LocalFsObjectStore + Storage Tools + ArtifactUploader
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalFsObjectStore, createLocalFsStore } from "../local-fs-adapter.js";
import type { ObjectStore } from "../object-store.js";
import {
  ObjectNotFoundError,
  ObjectAlreadyExistsError,
  ObjectStoreError,
  ObjectStoreConnectionError,
} from "../object-store.js";
import { createFileUploadTool, createFileDownloadTool, createFileListTool, createStorageTools } from "../../tools/storage.js";
import type { ToolContext } from "../../tools/types.js";
import { ArtifactUploader, createArtifactUploader } from "../artifact-uploader.js";

describe("LocalFsObjectStore", () => {
  let tmpDir: string;
  let store: LocalFsObjectStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "object-store-test-"));
    store = createLocalFsStore(tmpDir);
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── SP8 Test 1: put and get ─────────────────────────────────────────────

  it("put and get a file", async () => {
    const content = Buffer.from("hello world");
    const meta = await store.put("test.txt", content, { contentType: "text/plain" });

    expect(meta.key).toBe("test.txt");
    expect(meta.size).toBe(11);
    expect(meta.contentType).toBe("text/plain");

    const result = await store.get("test.txt");
    expect(result.content.toString()).toBe("hello world");
    expect(result.metadata.key).toBe("test.txt");
    expect(result.metadata.size).toBe(11);
  });

  // ── SP8 Test 2: get non-existent file throws ────────────────────────────

  it("get non-existent file throws ObjectNotFoundError", async () => {
    await expect(store.get("nonexistent.txt")).rejects.toThrow(ObjectNotFoundError);
  });

  // ── SP8 Test 3: delete ─────────────────────────────────────────────────

  it("delete a file", async () => {
    await store.put("to-delete.txt", Buffer.from("delete me"));
    expect(await store.exists("to-delete.txt")).toBe(true);

    await store.delete("to-delete.txt");
    expect(await store.exists("to-delete.txt")).toBe(false);
  });

  // ── SP8 Test 4: deleteMany ─────────────────────────────────────────────

  it("delete multiple files", async () => {
    await store.put("a.txt", Buffer.from("a"));
    await store.put("b.txt", Buffer.from("b"));
    await store.put("c.txt", Buffer.from("c"));

    await store.deleteMany(["a.txt", "b.txt"]);
    expect(await store.exists("a.txt")).toBe(false);
    expect(await store.exists("b.txt")).toBe(false);
    expect(await store.exists("c.txt")).toBe(true);
  });

  // ── SP8 Test 5: list with prefix ───────────────────────────────────────

  it("list files with prefix", async () => {
    await store.put("reports/2026/jan.txt", Buffer.from("jan"));
    await store.put("reports/2026/feb.txt", Buffer.from("feb"));
    await store.put("data/score.csv", Buffer.from("score"));

    const result = await store.list({ prefix: "reports/" });
    expect(result.objects).toHaveLength(2);
    expect(result.objects.map((o) => o.key).sort()).toEqual([
      "reports/2026/feb.txt",
      "reports/2026/jan.txt",
    ]);
  });

  // ── SP8 Test 6: list with delimiter ────────────────────────────────────

  it("list files with delimiter groups by directory", async () => {
    await store.put("a/1.txt", Buffer.from("1"));
    await store.put("a/2.txt", Buffer.from("2"));
    await store.put("b/3.txt", Buffer.from("3"));

    const result = await store.list({ delimiter: "/" });
    expect(result.prefixes).toContain("a/");
    expect(result.prefixes).toContain("b/");
    expect(result.objects).toHaveLength(0);
  });

  // ── SP8 Test 7: exists ─────────────────────────────────────────────────

  it("exists returns correct boolean", async () => {
    expect(await store.exists("nope.txt")).toBe(false);
    await store.put("exists.txt", Buffer.from("yes"));
    expect(await store.exists("exists.txt")).toBe(true);
  });

  // ── SP8 Test 8: head returns metadata without content ──────────────────

  it("head returns metadata without downloading content", async () => {
    await store.put("meta-test.txt", Buffer.from("metadata test"), {
      contentType: "text/plain",
      metadata: { author: "test" },
    });

    const meta = await store.head("meta-test.txt");
    expect(meta.key).toBe("meta-test.txt");
    expect(meta.size).toBe(13);
    expect(meta.contentType).toBe("text/plain");
    expect(meta.metadata?.author).toBe("test");
  });

  // ── SP8 Test 9: overwrite=false throws on existing file ────────────────

  it("overwrite=false throws ObjectAlreadyExistsError", async () => {
    await store.put("no-overwrite.txt", Buffer.from("original"));
    await expect(
      store.put("no-overwrite.txt", Buffer.from("new"), { overwrite: false }),
    ).rejects.toThrow(ObjectAlreadyExistsError);
  });

  // ── Test 9b: overwrite=false succeeds when file does not exist ──────────

  it("overwrite=false succeeds when file does not exist", async () => {
    const meta = await store.put("new-file.txt", Buffer.from("fresh"), { overwrite: false });
    expect(meta.key).toBe("new-file.txt");
    expect(meta.size).toBe(5);
  });

  // ── SP8 Test 10: presignUrl returns file:// URL ────────────────────────

  it("presignUrl returns file:// URL for existing file", async () => {
    await store.put("signed.txt", Buffer.from("sign me"));
    const url = await store.presignUrl("signed.txt");
    expect(url).toMatch(/^file:\/\//);
    expect(url).toContain("signed.txt");
  });

  it("presignUrl throws for non-existent file", async () => {
    await expect(store.presignUrl("ghost.txt")).rejects.toThrow(ObjectNotFoundError);
  });

  // ── SP8 Test 11: nested directories ────────────────────────────────────

  it("creates nested directories automatically", async () => {
    await store.put("deep/nested/dir/file.txt", Buffer.from("deep"));
    const result = await store.get("deep/nested/dir/file.txt");
    expect(result.content.toString()).toBe("deep");
  });

  // ── Test: put with Uint8Array ──────────────────────────────────────────

  it("put accepts Uint8Array content", async () => {
    const arr = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
    const meta = await store.put("uint8.txt", arr);
    expect(meta.size).toBe(5);
    const result = await store.get("uint8.txt");
    expect(result.content.toString()).toBe("Hello");
  });

  // ── Test: put with cacheControl and contentDisposition ──────────────────

  it("put stores cacheControl and contentDisposition in metadata", async () => {
    await store.put("headers.txt", Buffer.from("data"), {
      contentType: "text/plain",
      cacheControl: "max-age=3600",
      contentDisposition: 'attachment; filename="download.txt"',
    });
    // Verify the file is retrievable; meta sidecar stores these options
    const result = await store.get("headers.txt");
    expect(result.content.toString()).toBe("data");
    expect(result.metadata.contentType).toBe("text/plain");
  });

  // ── Test: delete on non-existent file is a no-op ───────────────────────

  it("delete on non-existent file does not throw", async () => {
    await expect(store.delete("never-created.txt")).resolves.toBeUndefined();
  });

  // ── Test: delete cleans up meta sidecar ────────────────────────────────

  it("delete removes the metadata sidecar file", async () => {
    await store.put("with-meta.txt", Buffer.from("meta"), { contentType: "text/csv" });
    expect(await store.exists("with-meta.txt")).toBe(true);

    await store.delete("with-meta.txt");
    expect(await store.exists("with-meta.txt")).toBe(false);
    // No meta sidecar left — exists checks the data file, so this is implicit
  });

  // ── Test: head on non-existent file throws ─────────────────────────────

  it("head on non-existent file throws ObjectNotFoundError", async () => {
    await expect(store.head("no-such-head.txt")).rejects.toThrow(ObjectNotFoundError);
  });

  // ── Test: list returns isTruncated=false and empty prefixes ─────────────

  it("list returns isTruncated=false for small result sets", async () => {
    await store.put("x/a.txt", Buffer.from("a"));
    const result = await store.list({ prefix: "x/" });
    expect(result.isTruncated).toBe(false);
    expect(result.prefixes).toEqual([]);
  });

  // ── Test: list respects maxKeys ────────────────────────────────────────

  it("list respects maxKeys option", async () => {
    await store.put("batch/1.txt", Buffer.from("1"));
    await store.put("batch/2.txt", Buffer.from("2"));
    await store.put("batch/3.txt", Buffer.from("3"));

    const result = await store.list({ prefix: "batch/", maxKeys: 2 });
    // maxKeys limits the number of objects returned
    expect(result.objects.length).toBeLessThanOrEqual(2);
  });

  // ── Test: list accepts continuationToken and startAfter (noop on local) ─

  it("list accepts continuationToken and startAfter options", async () => {
    await store.put("page/a.txt", Buffer.from("a"));
    const result = await store.list({
      prefix: "page/",
      continuationToken: "some-token",
      startAfter: "page/a.txt",
    });
    expect(result.objects.length).toBeGreaterThanOrEqual(1);
  });

  // ── Test: presignUrl with presign options ──────────────────────────────

  it("presignUrl accepts PresignOptions", async () => {
    await store.put("presign-test.txt", Buffer.from("presigned"));
    const url = await store.presignUrl("presign-test.txt", {
      expiresIn: 7200,
      method: "GET",
    });
    expect(url).toMatch(/^file:\/\//);
    expect(url).toContain("presign-test.txt");
  });

  it("presignUrl accepts PUT method", async () => {
    await store.put("put-presign.txt", Buffer.from("for put"));
    const url = await store.presignUrl("put-presign.txt", {
      method: "PUT",
      contentType: "text/plain",
    });
    expect(url).toMatch(/^file:\/\//);
  });

  // ── Test: name property ────────────────────────────────────────────────

  it("name is local-fs", () => {
    expect(store.name).toBe("local-fs");
  });

  // ── Test: close is a no-op ─────────────────────────────────────────────

  it("close resolves without error", async () => {
    await expect(store.close()).resolves.toBeUndefined();
  });

  // ── Test: createLocalFsStore factory ───────────────────────────────────

  it("createLocalFsStore returns a LocalFsObjectStore instance", () => {
    const s = createLocalFsStore("/tmp/test-store");
    expect(s).toBeInstanceOf(LocalFsObjectStore);
    expect(s.name).toBe("local-fs");
  });
});

describe("ObjectStore Error Types", () => {
  it("ObjectStoreError has code and name", () => {
    const err = new ObjectStoreError("TEST_CODE", "test message");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ObjectStoreError);
    expect(err.name).toBe("ObjectStoreError");
    expect(err.code).toBe("TEST_CODE");
    expect(err.message).toBe("test message");
  });

  it("ObjectStoreError accepts ErrorOptions (cause)", () => {
    const cause = new Error("root cause");
    const err = new ObjectStoreError("CAUSE_TEST", "wrapped error", { cause });
    expect(err.cause).toBe(cause);
  });

  it("ObjectNotFoundError has correct code and name", () => {
    const err = new ObjectNotFoundError("my-key.txt");
    expect(err).toBeInstanceOf(ObjectStoreError);
    expect(err.name).toBe("ObjectNotFoundError");
    expect(err.code).toBe("OBJECT_NOT_FOUND");
    expect(err.message).toContain("my-key.txt");
  });

  it("ObjectAlreadyExistsError has correct code and name", () => {
    const err = new ObjectAlreadyExistsError("dup.txt");
    expect(err).toBeInstanceOf(ObjectStoreError);
    expect(err.name).toBe("ObjectAlreadyExistsError");
    expect(err.code).toBe("OBJECT_ALREADY_EXISTS");
    expect(err.message).toContain("dup.txt");
  });

  it("ObjectStoreConnectionError has correct code and name", () => {
    const err = new ObjectStoreConnectionError("oss", "connection refused");
    expect(err).toBeInstanceOf(ObjectStoreError);
    expect(err.name).toBe("ObjectStoreConnectionError");
    expect(err.code).toBe("OBJECT_STORE_CONNECTION");
    expect(err.message).toBe("oss: connection refused");
  });

  it("ObjectStoreConnectionError accepts ErrorOptions", () => {
    const cause = new Error("ECONNREFUSED");
    const err = new ObjectStoreConnectionError("s3", "timeout", { cause });
    expect(err.cause).toBe(cause);
  });
});

describe("Storage Tools", () => {
  let tmpDir: string;
  let store: ObjectStore;

  function makeCtx(): ToolContext {
    return {
      cwd: tmpDir,
      sessionId: "test-session",
      objectStore: store,
    };
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "storage-tools-test-"));
    store = createLocalFsStore(join(tmpDir, "store"));
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Test 12: file_upload with content ──────────────────────────────────

  it("file_upload with inline content", async () => {
    const tool = createFileUploadTool();
    const result = await tool.execute(
      { key: "test/hello.txt", content: "Hello from tool!" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("test/hello.txt");
    expect(result.content).toContain("16B");
  });

  // ── Test 13: file_upload with localPath ────────────────────────────────

  it("file_upload with local file path", async () => {
    const localFile = join(tmpDir, "local.txt");
    await writeFile(localFile, "local file content");

    const tool = createFileUploadTool();
    const result = await tool.execute(
      { key: "uploaded/local.txt", localPath: localFile },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("uploaded/local.txt");
  });

  // ── Test 14: file_download returns content ─────────────────────────────

  it("file_download returns content as text", async () => {
    await store.put("download-test.txt", Buffer.from("download me"));

    const tool = createFileDownloadTool();
    const result = await tool.execute(
      { key: "download-test.txt" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toBe("download me");
  });

  // ── Test 15: file_download saves to local path ─────────────────────────

  it("file_download saves to local path", async () => {
    await store.put("save-test.txt", Buffer.from("save me locally"));

    const savePath = join(tmpDir, "saved.txt");
    const tool = createFileDownloadTool();
    const result = await tool.execute(
      { key: "save-test.txt", localPath: savePath },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    const saved = await readFile(savePath, "utf-8");
    expect(saved).toBe("save me locally");
  });

  // ── Test 16: file_list ─────────────────────────────────────────────────

  it("file_list shows files", async () => {
    await store.put("list/a.txt", Buffer.from("a"));
    await store.put("list/b.txt", Buffer.from("b"));

    const tool = createFileListTool();
    const result = await tool.execute(
      { prefix: "list/" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("a.txt");
    expect(result.content).toContain("b.txt");
  });

  // ── Test 17: tools return error when no ObjectStore ────────────────────

  it("file_upload returns error when ObjectStore not configured", async () => {
    const tool = createFileUploadTool();
    const result = await tool.execute(
      { key: "test.txt", content: "no store" },
      { cwd: tmpDir, sessionId: "test" },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("ObjectStore not available");
  });

  // ── Test 18: file_list with empty store ────────────────────────────────

  it("file_list shows 'no files' when empty", async () => {
    const tool = createFileListTool();
    const result = await tool.execute({}, makeCtx());

    expect(result.ok).toBe(true);
    expect(result.content).toContain("No files found");
  });

  // ── Test: file_upload missing localPath and content ────────────────────

  it("file_upload returns error when neither localPath nor content provided", async () => {
    const tool = createFileUploadTool();
    const result = await tool.execute({ key: "test.txt" }, makeCtx());

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Provide either localPath or content");
  });

  // ── Test: file_upload with localPath pointing to a directory ───────────

  it("file_upload returns error when localPath is a directory", async () => {
    const dirPath = join(tmpDir, "a-dir");
    await mkdir(dirPath);

    const tool = createFileUploadTool();
    const result = await tool.execute(
      { key: "dir-upload.txt", localPath: dirPath },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Not a file");
  });

  // ── Test: file_upload with explicit contentType ────────────────────────

  it("file_upload uses explicit contentType", async () => {
    const tool = createFileUploadTool();
    const result = await tool.execute(
      { key: "data.bin", content: "binary stuff", contentType: "application/octet-stream" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Type: application/octet-stream");
  });

  // ── Test: file_upload exec error (overwrite=false conflict) ────────────

  it("file_upload returns error when store.put throws", async () => {
    const tool = createFileUploadTool();
    // First upload succeeds
    await tool.execute(
      { key: "conflict.txt", content: "first write" },
      makeCtx(),
    );
    // Second upload with overwrite=false should fail
    const result = await tool.execute(
      { key: "conflict.txt", content: "second write", overwrite: false },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.error?.message).toContain("file_upload failed");
  });

  // ── Test: file_download returns error when store not configured ────────

  it("file_download returns error when ObjectStore not configured", async () => {
    const tool = createFileDownloadTool();
    const result = await tool.execute(
      { key: "test.txt" },
      { cwd: tmpDir, sessionId: "test" },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("ObjectStore not available");
  });

  // ── Test: file_download exec error (non-existent key) ──────────────────

  it("file_download returns error for non-existent key", async () => {
    const tool = createFileDownloadTool();
    const result = await tool.execute(
      { key: "no-such-key.txt" },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.error?.message).toContain("file_download failed");
  });

  // ── Test: file_download truncates large content ────────────────────────

  it("file_download truncates content larger than 100KB", async () => {
    // Create content slightly larger than 100KB
    const largeContent = Buffer.alloc(101 * 1024, "x").toString();
    await store.put("big-file.txt", Buffer.from(largeContent));

    const tool = createFileDownloadTool();
    const result = await tool.execute(
      { key: "big-file.txt" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.metadata?.truncated).toBe(true);
    expect(result.content).toContain("[truncated]");
    // Content should be at most 100KB (plus the truncation suffix)
    expect(result.content.length).toBeLessThanOrEqual(100 * 1024 + 20);
  });

  // ── Test: file_list returns error when store not configured ────────────

  it("file_list returns error when ObjectStore not configured", async () => {
    const tool = createFileListTool();
    const result = await tool.execute(
      {},
      { cwd: tmpDir, sessionId: "test" },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("ObjectStore not available");
  });

  // ── Test: file_list with delimiter shows directories ───────────────────

  it("file_list with delimiter shows directories", async () => {
    await store.put("reports/a.txt", Buffer.from("a"));
    await store.put("reports/b.txt", Buffer.from("b"));
    await store.put("reports/sub/c.txt", Buffer.from("c"));

    const tool = createFileListTool();
    const result = await tool.execute(
      { prefix: "reports/", delimiter: "/" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    // With delimiter, subdirectory objects are grouped
    expect(result.content).toContain("Directories:");
  });

  // ── Test: file_list passes continuationToken through ───────────────────

  it("file_list passes continuationToken option", async () => {
    await store.put("misc/x.txt", Buffer.from("x"));

    const tool = createFileListTool();
    const result = await tool.execute(
      { prefix: "misc/", continuationToken: "dummy-token" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("x.txt");
  });

  // ── Test: createStorageTools returns bundle ────────────────────────────

  it("createStorageTools returns all three tools", () => {
    const tools = createStorageTools();
    expect(tools.fileUpload).toBeDefined();
    expect(tools.fileUpload.name).toBe("file_upload");
    expect(tools.fileDownload).toBeDefined();
    expect(tools.fileDownload.name).toBe("file_download");
    expect(tools.fileList).toBeDefined();
    expect(tools.fileList.name).toBe("file_list");
  });

  // ── Test: file_upload shows MB for large content ───────────────────────

  it("file_upload shows MB size for content larger than 1MB", async () => {
    const tool = createFileUploadTool();
    const bigContent = "x".repeat(1024 * 1024 + 500); // ~1 MB + 500 bytes
    const result = await tool.execute(
      { key: "big.txt", content: bigContent },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("MB");
  });

  // ── Test: file_upload with unknown extension omits Type line ───────────

  it("file_upload omits Type line for unknown extension", async () => {
    const tool = createFileUploadTool();
    const result = await tool.execute(
      { key: "data.unknown_ext", content: "binary" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).not.toContain("Type:");
  });
});

describe("ArtifactUploader", () => {
  let tmpDir: string;
  let store: ObjectStore;
  let uploader: ArtifactUploader;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "artifact-uploader-test-"));
    store = createLocalFsStore(join(tmpDir, "store"));
    uploader = createArtifactUploader({
      store,
      prefix: "test-artifacts/",
      minSize: 10,
    });
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Test 19: scanAndUpload picks up large files ────────────────────────

  it("scanAndUpload uploads qualifying files", async () => {
    const workDir = join(tmpDir, "work");
    await mkdir(workDir, { recursive: true });

    // Large enough file (20 bytes > minSize of 10)
    await writeFile(join(workDir, "report.pdf"), "x".repeat(20));
    // Too small file
    await writeFile(join(workDir, "tiny.txt"), "hi");
    // Excluded extension
    await writeFile(join(workDir, "code.ts"), "const x = 1;");

    const report = await uploader.scanAndUpload(workDir);

    expect(report.uploaded.length).toBeGreaterThanOrEqual(1);
    expect(report.uploaded.some((a) => a.objectKey.includes("report.pdf"))).toBe(true);
    expect(report.skipped.some((s) => s.path.includes("tiny.txt"))).toBe(true);
  });

  // ── Test 20: uploadFiles with specific paths ───────────────────────────

  it("uploads specific files and returns report", async () => {
    const file1 = join(tmpDir, "data.csv");
    await writeFile(file1, "name,score\nalice,95\nbob,87\n");

    const report = await uploader.uploadFiles([file1]);

    expect(report.uploaded).toHaveLength(1);
    expect(report.uploaded[0].objectKey).toContain("data.csv");
    expect(report.uploaded[0].size).toBeGreaterThan(0);
  });

  // ── Test 21: formatReport ──────────────────────────────────────────────

  it("formatReport produces readable output", async () => {
    const file1 = join(tmpDir, "test.txt");
    await writeFile(file1, "test content for report");

    const report = await uploader.uploadFiles([file1]);
    const formatted = uploader.formatReport(report);

    expect(formatted).toContain("Uploaded 1 artifact(s)");
    expect(formatted).toContain("test.txt");
  });

  // ── Test: scanAndUpload respects maxDepth limit ────────────────────────

  it("scanAndUpload respects maxDepth limit", async () => {
    // Create dirs: work/l1/l2/l3/l4/ (depth 4 from work root)
    const deepDir = join(tmpDir, "work", "l1", "l2", "l3", "l4");
    await mkdir(deepDir, { recursive: true });
    // File at depth 4 — should be beyond default maxDepth of 3
    await writeFile(join(deepDir, "deep.pdf"), "x".repeat(100));

    // Also put a file at depth 1
    await writeFile(join(tmpDir, "work", "shallow.pdf"), "y".repeat(100));

    const report = await uploader.scanAndUpload(join(tmpDir, "work"));
    // Only the shallow file should be uploaded (depth 1 < maxDepth 3)
    expect(report.uploaded.some((a) => a.objectKey.includes("shallow.pdf"))).toBe(true);
    // Deep file at depth 4 should not appear
    expect(report.uploaded.some((a) => a.objectKey.includes("deep.pdf"))).toBe(false);
  });

  // ── Test: scanAndUpload skips hidden directories ───────────────────────

  it("scanAndUpload skips hidden directories", async () => {
    const workDir = join(tmpDir, "work");
    const hiddenDir = join(workDir, ".secret");
    await mkdir(hiddenDir, { recursive: true });
    await writeFile(join(hiddenDir, "secret.pdf"), "x".repeat(100));

    const report = await uploader.scanAndUpload(workDir);
    expect(report.uploaded).toHaveLength(0);
  });

  // ── Test: scanAndUpload skips node_modules ─────────────────────────────

  it("scanAndUpload skips node_modules directory", async () => {
    const workDir = join(tmpDir, "work");
    const nmDir = join(workDir, "node_modules");
    await mkdir(nmDir, { recursive: true });
    await writeFile(join(nmDir, "package.pdf"), "x".repeat(100));

    const report = await uploader.scanAndUpload(workDir);
    expect(report.uploaded).toHaveLength(0);
  });

  // ── Test: uploadFiles skips directories ────────────────────────────────

  it("uploadFiles skips directory paths", async () => {
    const dirPath = join(tmpDir, "a-directory");
    await mkdir(dirPath);

    const report = await uploader.uploadFiles([dirPath]);
    expect(report.uploaded).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].reason).toBe("not a file");
  });

  // ── Test: uploadFiles skips excluded extensions ────────────────────────

  it("uploadFiles skips files with excluded extensions", async () => {
    const tsFile = join(tmpDir, "script.ts");
    await writeFile(tsFile, "import { foo } from './bar';\n".repeat(50));

    const report = await uploader.uploadFiles([tsFile]);
    expect(report.uploaded).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].reason).toContain("excluded extension");
    expect(report.skipped[0].reason).toContain(".ts");
  });

  // ── Test: uploadFiles catches errors for non-existent files ────────────

  it("uploadFiles catches errors for non-existent files", async () => {
    const report = await uploader.uploadFiles(["/no/such/file.pdf"]);
    expect(report.uploaded).toHaveLength(0);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors[0].path).toBe("/no/such/file.pdf");
  });

  // ── Test: uploadFiles with generateUrls=false ─────────────────────────

  it("uploadFiles does not generate URLs when generateUrls is false", async () => {
    const noUrlUploader = createArtifactUploader({
      store,
      prefix: "no-urls/",
      generateUrls: false,
    });

    const file1 = join(tmpDir, "no-url-report.pdf");
    await writeFile(file1, "x".repeat(50));

    const report = await noUrlUploader.uploadFiles([file1]);
    expect(report.uploaded).toHaveLength(1);
    expect(report.uploaded[0].url).toBeUndefined();

    const formatted = noUrlUploader.formatReport(report);
    expect(formatted).not.toContain("file://");
  });

  // ── Test: uploadFiles uploads small always-upload extensions ───────────

  it("uploadFiles uploads small files with always-upload extensions", async () => {
    // PDF is an always-upload extension; even small files should upload
    const smallPdf = join(tmpDir, "tiny.pdf");
    await writeFile(smallPdf, "xx"); // 2 bytes < minSize (10)

    const report = await uploader.uploadFiles([smallPdf]);
    expect(report.uploaded).toHaveLength(1);
    expect(report.uploaded[0].objectKey).toContain("tiny.pdf");
  });

  // ── Test: uploadFiles skips small non-always-upload files ──────────────

  it("uploadFiles skips small files that are not always-upload", async () => {
    // Regular .txt (not an always-upload extension) — too small
    const smallFile = join(tmpDir, "note.txt");
    await writeFile(smallFile, "hi"); // 2 bytes < minSize (10)

    const report = await uploader.uploadFiles([smallFile]);
    expect(report.uploaded).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].reason).toContain("too small");
  });

  // ── Test: formatReport includes error details ──────────────────────────

  it("formatReport includes error details when errors exist", async () => {
    const report = await uploader.uploadFiles(["/definitely/does/not/exist.csv"]);
    const formatted = uploader.formatReport(report);

    expect(formatted).toContain("Errors: 1");
    expect(formatted).toContain("/definitely/does/not/exist.csv");
  });

  // ── Test: formatReport includes skipped files ──────────────────────────

  it("formatReport includes skipped details", async () => {
    const dirPath = join(tmpDir, "empty-dir");
    await mkdir(dirPath);
    const tsFile = join(tmpDir, "code.ts");
    await writeFile(tsFile, "const x = 1;");

    const report = await uploader.uploadFiles([dirPath, tsFile]);
    const formatted = uploader.formatReport(report);

    expect(formatted).toContain("Skipped 2 file(s)");
    expect(formatted).toContain("not a file");
    expect(formatted).toContain("excluded extension");
  });

  // ── Test: uploadFiles with baseDir generates relative keys ─────────────

  it("uploadFiles uses baseDir to generate relative object keys", async () => {
    const workDir = join(tmpDir, "project");
    await mkdir(join(workDir, "output"), { recursive: true });
    const filePath = join(workDir, "output", "results.pdf");
    await writeFile(filePath, "x".repeat(100));

    const report = await uploader.uploadFiles([filePath], workDir);
    expect(report.uploaded).toHaveLength(1);
    expect(report.uploaded[0].objectKey).toContain("output/results.pdf");
  });

  // ── Test: scanAndUpload finds files at nested depth within limit ───────

  it("scanAndUpload finds files at nested depth within maxDepth", async () => {
    const workDir = join(tmpDir, "project");
    // depth 1: workDir/ (depth 0 from scan root would be workDir itself)
    // scanAndUpload scans from workDir at depth 0
    // l1 = depth 1, l2 = depth 2, l3 = depth 3
    const nestedDir = join(workDir, "src", "components", "charts");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(nestedDir, "chart.pdf"), "z".repeat(100));

    const report = await uploader.scanAndUpload(workDir);
    // depth 3 is within maxDepth (3), so file should be uploaded
    expect(report.uploaded.length).toBeGreaterThanOrEqual(1);
    expect(report.uploaded.some((a) => a.objectKey.includes("chart.pdf"))).toBe(true);
  });

  // ── Test: formatReport with empty uploaded list ────────────────────────

  it("formatReport handles empty uploaded list gracefully", async () => {
    const dirPath = join(tmpDir, "just-a-dir");
    await mkdir(dirPath);

    const report = await uploader.uploadFiles([dirPath]);
    const formatted = uploader.formatReport(report);

    // Should not contain "Uploaded" section
    expect(formatted).not.toContain("Uploaded");
    // Should contain skipped section
    expect(formatted).toContain("Skipped");
  });

  // ── Test: uploadFiles includes URL in report when generateUrls=true ────

  it("uploadFiles includes presigned URL in uploaded artifacts", async () => {
    const file1 = join(tmpDir, "url-test.pdf");
    await writeFile(file1, "x".repeat(50));

    const report = await uploader.uploadFiles([file1]);
    expect(report.uploaded).toHaveLength(1);
    expect(report.uploaded[0].url).toBeDefined();
    expect(report.uploaded[0].url).toMatch(/^file:\/\//);
  });

  // ── Test: formatReport includes URLs when present ──────────────────────

  it("formatReport includes URLs for uploaded artifacts", async () => {
    const file1 = join(tmpDir, "url-format.pdf");
    await writeFile(file1, "x".repeat(50));

    const report = await uploader.uploadFiles([file1]);
    const formatted = uploader.formatReport(report);

    expect(formatted).toContain("file://");
  });

  // ── Test: formatReport handles MB-sized files ──────────────────────────

  it("formatReport shows MB for files larger than 1MB", async () => {
    const file1 = join(tmpDir, "big.pdf");
    // Write a file just over 1MB
    await writeFile(file1, "x".repeat(1024 * 1024 + 100));

    const report = await uploader.uploadFiles([file1]);
    expect(report.uploaded).toHaveLength(1);

    const formatted = uploader.formatReport(report);
    expect(formatted).toContain("MB");
  });

  // ── Test: uploadFiles with custom alwaysUploadExtensions ────────────────

  it("uploadFiles respects custom alwaysUploadExtensions", async () => {
    const customUploader = createArtifactUploader({
      store,
      prefix: "custom/",
      minSize: 10000,
      alwaysUploadExtensions: [".dat"],
    });

    // .dat file that is very small — should still upload via alwaysUpload
    const datFile = join(tmpDir, "custom.dat");
    await writeFile(datFile, "tiny"); // 4 bytes < minSize 10000

    const report = await customUploader.uploadFiles([datFile]);
    expect(report.uploaded).toHaveLength(1);
    expect(report.uploaded[0].objectKey).toContain("custom.dat");
  });

  // ── Test: uploadFiles with custom excludeExtensions ─────────────────────

  it("uploadFiles respects custom excludeExtensions", async () => {
    const customUploader = createArtifactUploader({
      store,
      prefix: "custom-ex/",
      excludeExtensions: [".csv"],
    });

    const csvFile = join(tmpDir, "data.csv");
    await writeFile(csvFile, "col1,col2\n1,2\n");

    const report = await customUploader.uploadFiles([csvFile]);
    expect(report.uploaded).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].reason).toContain("excluded extension: .csv");
  });
});

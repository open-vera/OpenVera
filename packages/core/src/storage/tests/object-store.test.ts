/**
 * Object Store tests — LocalFsObjectStore + Storage Tools + ArtifactUploader
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalFsObjectStore, createLocalFsStore } from "../local-fs-adapter.js";
import type { ObjectStore } from "../object-store.js";
import { ObjectNotFoundError, ObjectAlreadyExistsError } from "../object-store.js";
import { createFileUploadTool, createFileDownloadTool, createFileListTool } from "../../tools/storage.js";
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
});

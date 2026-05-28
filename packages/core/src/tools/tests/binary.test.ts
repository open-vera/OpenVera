/**
 * Tests for binary detection utility (binary.ts)
 *
 * Verifies: extension-based detection, content-based detection,
 * boundary cases, and mixed scenarios.
 */
import { describe, it, expect } from "vitest";
import { isBinaryPath, hasBinaryContent } from "../utils/binary.js";

// ── isBinaryPath ─────────────────────────────────────────────────────────────

describe("isBinaryPath", () => {
  it("detects image extensions as binary", () => {
    expect(isBinaryPath("photo.png")).toBe(true);
    expect(isBinaryPath("image.jpg")).toBe(true);
    expect(isBinaryPath("image.jpeg")).toBe(true);
    expect(isBinaryPath("anim.gif")).toBe(true);
    expect(isBinaryPath("pic.webp")).toBe(true);
    expect(isBinaryPath("icon.bmp")).toBe(true);
    expect(isBinaryPath("thumb.ico")).toBe(true);
    expect(isBinaryPath("scan.tiff")).toBe(true);
  });

  it("detects archive extensions as binary", () => {
    expect(isBinaryPath("archive.zip")).toBe(true);
    expect(isBinaryPath("backup.tar")).toBe(true);
    expect(isBinaryPath("compressed.gz")).toBe(true);
    expect(isBinaryPath("compressed.bz2")).toBe(true);
    expect(isBinaryPath("compressed.xz")).toBe(true);
    expect(isBinaryPath("archive.7z")).toBe(true);
    expect(isBinaryPath("archive.rar")).toBe(true);
  });

  it("detects executable and shared library extensions as binary", () => {
    expect(isBinaryPath("app.exe")).toBe(true);
    expect(isBinaryPath("lib.dll")).toBe(true);
    expect(isBinaryPath("lib.so")).toBe(true);
    expect(isBinaryPath("lib.dylib")).toBe(true);
    expect(isBinaryPath("data.bin")).toBe(true);
  });

  it("detects media extensions as binary", () => {
    expect(isBinaryPath("song.mp3")).toBe(true);
    expect(isBinaryPath("video.mp4")).toBe(true);
    expect(isBinaryPath("clip.mov")).toBe(true);
    expect(isBinaryPath("movie.avi")).toBe(true);
    expect(isBinaryPath("audio.wav")).toBe(true);
    expect(isBinaryPath("lossless.flac")).toBe(true);
  });

  it("detects font extensions as binary", () => {
    expect(isBinaryPath("font.ttf")).toBe(true);
    expect(isBinaryPath("font.otf")).toBe(true);
    expect(isBinaryPath("font.woff")).toBe(true);
    expect(isBinaryPath("font.woff2")).toBe(true);
  });

  it("detects database and compiled extensions as binary", () => {
    expect(isBinaryPath("data.db")).toBe(true);
    expect(isBinaryPath("data.sqlite")).toBe(true);
    expect(isBinaryPath("data.sqlite3")).toBe(true);
    expect(isBinaryPath("module.class")).toBe(true);
    expect(isBinaryPath("module.pyc")).toBe(true);
    expect(isBinaryPath("module.pyo")).toBe(true);
  });

  it("does not flag text file extensions", () => {
    expect(isBinaryPath("readme.txt")).toBe(false);
    expect(isBinaryPath("app.ts")).toBe(false);
    expect(isBinaryPath("app.js")).toBe(false);
    expect(isBinaryPath("style.css")).toBe(false);
    expect(isBinaryPath("index.html")).toBe(false);
    expect(isBinaryPath("data.json")).toBe(false);
    expect(isBinaryPath("config.yaml")).toBe(false);
    expect(isBinaryPath("script.py")).toBe(false);
    expect(isBinaryPath("main.go")).toBe(false);
    expect(isBinaryPath("lib.rs")).toBe(false);
    expect(isBinaryPath("readme.md")).toBe(false);
    expect(isBinaryPath("query.sql")).toBe(false);
  });

  it("handles case insensitivity for extensions", () => {
    expect(isBinaryPath("PHOTO.PNG")).toBe(true);
    expect(isBinaryPath("Image.JPG")).toBe(true);
    expect(isBinaryPath("Archive.ZIP")).toBe(true);
    expect(isBinaryPath("App.EXE")).toBe(true);
  });

  it("handles files with no extension", () => {
    expect(isBinaryPath("Makefile")).toBe(false);
    expect(isBinaryPath("LICENSE")).toBe(false);
    expect(isBinaryPath("Dockerfile")).toBe(false);
  });

  it("handles paths with multiple dots", () => {
    expect(isBinaryPath("archive.tar.gz")).toBe(true);
    expect(isBinaryPath("my.config.json")).toBe(false);
    expect(isBinaryPath("file.backup.png")).toBe(true);
    expect(isBinaryPath("v1.2.3.ts")).toBe(false);
  });
});

// ── hasBinaryContent ─────────────────────────────────────────────────────────

describe("hasBinaryContent", () => {
  it("detects null byte in first 512 bytes as binary", () => {
    const buf = Buffer.alloc(100);
    buf[50] = 0; // null byte at position 50
    expect(hasBinaryContent(buf)).toBe(true);
  });

  it("detects null byte at position 0 as binary", () => {
    const buf = Buffer.alloc(10);
    buf[0] = 0;
    expect(hasBinaryContent(buf)).toBe(true);
  });

  it("detects null byte at position 511 as binary", () => {
    const buf = Buffer.alloc(600);
    buf[511] = 0; // last position within the 512-byte check window
    expect(hasBinaryContent(buf)).toBe(true);
  });

  it("does not flag null byte beyond 512-byte window", () => {
    const buf = Buffer.alloc(600, 1); // fill with non-zero bytes
    buf[513] = 0; // outside the 512-byte check window
    expect(hasBinaryContent(buf)).toBe(false);
  });

  it("returns false for buffer with no null bytes", () => {
    const buf = Buffer.from("Hello, World! This is plain text content.");
    expect(hasBinaryContent(buf)).toBe(false);
  });

  it("returns false for empty buffer", () => {
    const buf = Buffer.alloc(0);
    expect(hasBinaryContent(buf)).toBe(false);
  });

  it("returns false for single-byte non-null buffer", () => {
    const buf = Buffer.from([65]); // 'A'
    expect(hasBinaryContent(buf)).toBe(false);
  });

  it("detects binary in typical PNG header", () => {
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    // The 0x00 bytes often appear later in the IHDR chunk
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    expect(hasBinaryContent(buf)).toBe(true);
  });

  it("returns true for buffer full of null bytes", () => {
    const buf = Buffer.alloc(1000); // all zeros
    expect(hasBinaryContent(buf)).toBe(true);
  });

  it("handles buffer smaller than 512 bytes correctly", () => {
    const buf = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
    expect(hasBinaryContent(buf)).toBe(false);

    const bufWithNull = Buffer.from([0x48, 0x00, 0x6c]); // "H\0l"
    expect(hasBinaryContent(bufWithNull)).toBe(true);
  });
});

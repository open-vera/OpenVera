// 二进制文件检测

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff",
  "pdf", "zip", "tar", "gz", "bz2", "xz", "7z", "rar",
  "exe", "dll", "so", "dylib", "bin",
  "mp3", "mp4", "mov", "avi", "wav", "flac",
  "ttf", "otf", "woff", "woff2",
  "db", "sqlite", "sqlite3",
  "class", "pyc", "pyo",
]);

export function isBinaryPath(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Quick check on the first 512 bytes for null bytes (strong binary signal).
 */
export function hasBinaryContent(buf: Buffer): boolean {
  const checkLen = Math.min(buf.length, 512);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

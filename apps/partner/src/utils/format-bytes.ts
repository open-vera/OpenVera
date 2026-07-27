const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Human-readable size, base-1024, at most one decimal place. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  // Bytes are always whole; larger units keep one decimal unless it is .0.
  const rounded = unitIndex === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${UNITS[unitIndex]}`;
}

export function formatFileCount(files: number, locale: "zh" | "en"): string {
  if (files <= 0) return locale === "en" ? "empty" : "空";
  if (locale === "en") return files === 1 ? "1 file" : `${files} files`;
  return `${files} 个文件`;
}

/** Share of the total, for the usage bar. Returns 0 when the total is unknown. */
export function usageRatio(bytes: number, totalBytes: number): number {
  if (!Number.isFinite(bytes) || !Number.isFinite(totalBytes)) return 0;
  if (totalBytes <= 0 || bytes <= 0) return 0;
  return Math.min(1, bytes / totalBytes);
}

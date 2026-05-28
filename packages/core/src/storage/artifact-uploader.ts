/**
 * Artifact Auto-Uploader — Automatically uploads agent-produced files to object storage.
 *
 * Scans for files that match certain patterns (reports, datasets, screenshots, large files)
 * and uploads them to the configured ObjectStore. Returns presigned URLs for easy sharing.
 */

import { stat, readdir } from "node:fs/promises";
import { join, extname, relative } from "node:path";
import type { ObjectStore, PutOptions } from "./object-store.js";

export interface ArtifactUploaderOptions {
  /** Object store to upload to */
  store: ObjectStore;
  /** Prefix for uploaded objects (default: "artifacts/") */
  prefix?: string;
  /** Minimum file size in bytes to auto-upload (default: 10KB) */
  minSize?: number;
  /** File extensions to always upload (regardless of size) */
  alwaysUploadExtensions?: string[];
  /** File extensions to exclude from upload */
  excludeExtensions?: string[];
  /** Maximum depth to scan (default: 3) */
  maxDepth?: number;
  /** Generate presigned URLs for uploaded files (default: true) */
  generateUrls?: boolean;
  /** Presigned URL expiry in seconds (default: 3600) */
  urlExpiry?: number;
}

export interface UploadedArtifact {
  /** Original local path */
  localPath: string;
  /** Object key in the store */
  objectKey: string;
  /** File size in bytes */
  size: number;
  /** Presigned URL (if generateUrls is true) */
  url?: string;
}

export interface UploadReport {
  /** Files that were uploaded */
  uploaded: UploadedArtifact[];
  /** Files that were skipped (and why) */
  skipped: Array<{ path: string; reason: string }>;
  /** Errors encountered during upload */
  errors: Array<{ path: string; error: string }>;
}

const DEFAULT_ALWAYS_UPLOAD_EXTENSIONS = [
  ".pdf", ".xlsx", ".xls", ".csv", ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".svg", ".mp4", ".mp3", ".zip", ".tar", ".gz", ".doc", ".docx", ".ppt", ".pptx",
];

const DEFAULT_EXCLUDE_EXTENSIONS = [
  ".js", ".ts", ".py", ".java", ".go", ".rs", ".c", ".cpp", ".h",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".env",
  ".lock", ".log", ".tmp", ".temp",
];

export class ArtifactUploader {
  private readonly store: ObjectStore;
  private readonly prefix: string;
  private readonly minSize: number;
  private readonly alwaysUploadExts: Set<string>;
  private readonly excludeExts: Set<string>;
  private readonly maxDepth: number;
  private readonly generateUrls: boolean;
  private readonly urlExpiry: number;

  constructor(options: ArtifactUploaderOptions) {
    this.store = options.store;
    this.prefix = options.prefix ?? "artifacts/";
    this.minSize = options.minSize ?? 10 * 1024; // 10KB
    this.alwaysUploadExts = new Set(
      (options.alwaysUploadExtensions ?? DEFAULT_ALWAYS_UPLOAD_EXTENSIONS).map((e) => e.toLowerCase()),
    );
    this.excludeExts = new Set(
      (options.excludeExtensions ?? DEFAULT_EXCLUDE_EXTENSIONS).map((e) => e.toLowerCase()),
    );
    this.maxDepth = options.maxDepth ?? 3;
    this.generateUrls = options.generateUrls ?? true;
    this.urlExpiry = options.urlExpiry ?? 3600;
  }

  /**
   * Scan a directory for artifacts and upload them.
   */
  async scanAndUpload(dir: string): Promise<UploadReport> {
    const files = await this.scanDirectory(dir, 0);
    return this.uploadFiles(files, dir);
  }

  /**
   * Upload specific files.
   */
  async uploadFiles(filePaths: string[], baseDir?: string): Promise<UploadReport> {
    const report: UploadReport = {
      uploaded: [],
      skipped: [],
      errors: [],
    };

    for (const filePath of filePaths) {
      try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) {
          report.skipped.push({ path: filePath, reason: "not a file" });
          continue;
        }

        const ext = extname(filePath).toLowerCase();

        if (this.excludeExts.has(ext)) {
          report.skipped.push({ path: filePath, reason: `excluded extension: ${ext}` });
          continue;
        }

        const isAlwaysUpload = this.alwaysUploadExts.has(ext);
        if (!isAlwaysUpload && fileStat.size < this.minSize) {
          report.skipped.push({
            path: filePath,
            reason: `too small (${fileStat.size} < ${this.minSize})`,
          });
          continue;
        }

        // Generate object key from file path
        const objectKey = this.generateObjectKey(filePath, baseDir);

        // Upload
        const { readFile } = await import("node:fs/promises");
        const content = await readFile(filePath);

        const putOptions: PutOptions = {
          contentType: guessContentType(ext),
          metadata: {
            originalPath: filePath,
            uploadedAt: new Date().toISOString(),
            size: String(fileStat.size),
          },
        };

        await this.store.put(objectKey, content, putOptions);

        // Generate presigned URL
        let url: string | undefined;
        if (this.generateUrls) {
          try {
            url = await this.store.presignUrl(objectKey, { expiresIn: this.urlExpiry });
          } catch {
            // Not all stores support presigned URLs
          }
        }

        report.uploaded.push({
          localPath: filePath,
          objectKey,
          size: fileStat.size,
          url,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        report.errors.push({ path: filePath, error: msg });
      }
    }

    return report;
  }

  /**
   * Format a upload report as a human-readable string.
   */
  formatReport(report: UploadReport): string {
    const lines: string[] = [];

    if (report.uploaded.length > 0) {
      lines.push(`Uploaded ${report.uploaded.length} artifact(s):`);
      for (const art of report.uploaded) {
        const size = formatSize(art.size);
        lines.push(`  ${art.objectKey} (${size})`);
        if (art.url) lines.push(`    ${art.url}`);
      }
    }

    if (report.skipped.length > 0) {
      lines.push(`\nSkipped ${report.skipped.length} file(s):`);
      for (const skip of report.skipped) {
        lines.push(`  ${skip.path}: ${skip.reason}`);
      }
    }

    if (report.errors.length > 0) {
      lines.push(`\nErrors: ${report.errors.length}`);
      for (const err of report.errors) {
        lines.push(`  ${err.path}: ${err.error}`);
      }
    }

    return lines.join("\n");
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async scanDirectory(dir: string, depth: number): Promise<string[]> {
    if (depth > this.maxDepth) return [];

    const files: string[] = [];

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          // Skip hidden dirs and node_modules
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const subFiles = await this.scanDirectory(fullPath, depth + 1);
          files.push(...subFiles);
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (!this.excludeExts.has(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch {
      // Ignore permission errors
    }

    return files;
  }

  private generateObjectKey(filePath: string, baseDir?: string): string {
    const now = new Date();
    const datePart = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}`;
    const timePart = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;

    let fileName: string;
    if (baseDir) {
      fileName = relative(baseDir, filePath).split(/[/\\]/).join("/");
    } else {
      fileName = filePath.split(/[/\\]/).pop() ?? filePath;
    }

    return `${this.prefix}${datePart}/${timePart}_${fileName}`;
  }
}

export function createArtifactUploader(options: ArtifactUploaderOptions): ArtifactUploader {
  return new ArtifactUploader(options);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function guessContentType(ext: string): string | undefined {
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".html": "text/html",
    ".htm": "text/html",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return map[ext.toLowerCase()];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

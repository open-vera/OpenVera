/**
 * Object storage tools — Upload, download, and list files in an object store.
 *
 * Three tools: file_upload, file_download, file_list.
 * Requires an ObjectStore in the tool context.
 */

import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

// ── file_upload ─────────────────────────────────────────────────────────────

export interface FileUploadArgs {
  /** Object key (path) in the store (e.g., "reports/2026/summary.pdf") */
  key: string;
  /** Local file path to upload from */
  localPath?: string;
  /** Inline content to upload (mutually exclusive with localPath) */
  content?: string;
  /** MIME content type (auto-detected from extension if omitted) */
  contentType?: string;
  /** Overwrite existing file (default: true) */
  overwrite?: boolean;
  /** Custom metadata key-value pairs */
  metadata?: Record<string, string>;
}

export function createFileUploadTool(): ToolDef<FileUploadArgs> {
  return {
    name: "file_upload",
    description:
      "Upload a file to the object store. " +
      "Use either a local file path or inline content. " +
      "Returns a presigned URL for the uploaded file.",
    parameters: {
      type: "object" as const,
      required: ["key"],
      properties: {
        key: {
          type: "string" as const,
          description: "Object key (path) in the store (e.g., 'reports/2026/summary.pdf')",
        },
        localPath: {
          type: "string" as const,
          description: "Local file path to upload from",
        },
        content: {
          type: "string" as const,
          description: "Inline content to upload (mutually exclusive with localPath)",
        },
        contentType: {
          type: "string" as const,
          description: "MIME content type (auto-detected from extension if omitted)",
        },
        overwrite: {
          type: "boolean" as const,
          description: "Overwrite existing file (default: true)",
        },
        metadata: {
          type: "object" as const,
          description: "Custom metadata key-value pairs",
        },
      },
    },
    execute: async (args: FileUploadArgs, ctx: ToolContext): Promise<ToolResult> => {
      const store = ctx.objectStore;
      if (!store) {
        return errorResult("UNKNOWN", "ObjectStore not available in context", false);
      }

      if (!args.localPath && args.content === undefined) {
        return errorResult("UNKNOWN", "Provide either localPath or content", false);
      }

      try {
        let contentBuffer: Buffer;

        if (args.localPath) {
          const fileStat = await stat(args.localPath);
          if (!fileStat.isFile()) {
            return errorResult("NOT_FOUND", `Not a file: ${args.localPath}`, false);
          }
          contentBuffer = await readFile(args.localPath);
        } else {
          contentBuffer = Buffer.from(args.content!, "utf-8");
        }

        const contentType = args.contentType ?? guessContentType(args.key);

        const metadata = await store.put(args.key, contentBuffer, {
          contentType,
          overwrite: args.overwrite,
          metadata: args.metadata,
        });

        // Try to generate a presigned URL
        let url: string | undefined;
        try {
          url = await store.presignUrl(args.key, { expiresIn: 3600 });
        } catch {
          // Not all stores support presigned URLs
        }

        const parts = [
          `Uploaded: ${args.key}`,
          `Size: ${formatSize(metadata.size)}`,
        ];
        if (contentType) parts.push(`Type: ${contentType}`);
        if (url) parts.push(`URL: ${url}`);

        return {
          ok: true,
          content: parts.join("\n"),
          metadata: {
            bytesRead: metadata.size,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult("EXEC_ERROR", `file_upload failed: ${msg}`, false);
      }
    },
  };
}

// ── file_download ───────────────────────────────────────────────────────────

export interface FileDownloadArgs {
  /** Object key (path) in the store */
  key: string;
  /** Local path to save the file to (optional, returns content if omitted) */
  localPath?: string;
}

export function createFileDownloadTool(): ToolDef<FileDownloadArgs> {
  return {
    name: "file_download",
    description:
      "Download a file from the object store. " +
      "If localPath is provided, saves to disk; otherwise returns the content directly.",
    parameters: {
      type: "object" as const,
      required: ["key"],
      properties: {
        key: {
          type: "string" as const,
          description: "Object key (path) in the store",
        },
        localPath: {
          type: "string" as const,
          description: "Local path to save the file to (optional, returns content if omitted)",
        },
      },
    },
    execute: async (args: FileDownloadArgs, ctx: ToolContext): Promise<ToolResult> => {
      const store = ctx.objectStore;
      if (!store) {
        return errorResult("UNKNOWN", "ObjectStore not available in context", false);
      }

      try {
        const result = await store.get(args.key);

        if (args.localPath) {
          const { writeFile, mkdir } = await import("node:fs/promises");
          const { dirname } = await import("node:path");
          await mkdir(dirname(args.localPath), { recursive: true });
          await writeFile(args.localPath, result.content);

          return {
            ok: true,
            content: `Downloaded ${args.key} to ${args.localPath} (${formatSize(result.metadata.size)})`,
            metadata: {
              bytesRead: result.metadata.size,
            },
          };
        }

        // Return content as text (with size limit for display)
        const maxSize = 100 * 1024; // 100KB
        const text = result.content.toString("utf-8");
        const truncated = text.length > maxSize;

        return {
          ok: true,
          content: truncated ? text.slice(0, maxSize) + "\n... [truncated]" : text,
          metadata: {
            bytesRead: result.metadata.size,
            truncated,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult("EXEC_ERROR", `file_download failed: ${msg}`, false);
      }
    },
  };
}

// ── file_list ───────────────────────────────────────────────────────────────

export interface FileListArgs {
  /** Filter by key prefix */
  prefix?: string;
  /** Delimiter for directory-style listing (e.g., '/') */
  delimiter?: string;
  /** Maximum number of results (default: 100) */
  maxKeys?: number;
  /** Continuation token for pagination */
  continuationToken?: string;
}

export function createFileListTool(): ToolDef<FileListArgs> {
  return {
    name: "file_list",
    description:
      "List files in the object store. " +
      "Supports prefix filtering and directory-style listing with delimiter.",
    parameters: {
      type: "object" as const,
      properties: {
        prefix: {
          type: "string" as const,
          description: "Filter by key prefix (e.g., 'reports/')",
        },
        delimiter: {
          type: "string" as const,
          description: "Delimiter for directory-style listing (e.g., '/')",
        },
        maxKeys: {
          type: "number" as const,
          description: "Maximum number of results (default: 100)",
        },
        continuationToken: {
          type: "string" as const,
          description: "Continuation token for pagination",
        },
      },
    },
    execute: async (args: FileListArgs, ctx: ToolContext): Promise<ToolResult> => {
      const store = ctx.objectStore;
      if (!store) {
        return errorResult("UNKNOWN", "ObjectStore not available in context", false);
      }

      try {
        const result = await store.list({
          prefix: args.prefix,
          delimiter: args.delimiter,
          maxKeys: args.maxKeys ?? 100,
          continuationToken: args.continuationToken,
        });

        const lines: string[] = [];

        if (result.prefixes.length > 0) {
          lines.push("Directories:");
          for (const prefix of result.prefixes) {
            lines.push(`  📁 ${prefix}`);
          }
          lines.push("");
        }

        if (result.objects.length > 0) {
          lines.push(`Files (${result.objects.length}):`);
          for (const obj of result.objects) {
            const size = formatSize(obj.size);
            const date = obj.lastModified?.toISOString().slice(0, 16).replace("T", " ") ?? "";
            lines.push(`  📄 ${obj.key}  ${size}  ${date}`);
          }
        }

        if (result.objects.length === 0 && result.prefixes.length === 0) {
          lines.push("No files found.");
        }

        if (result.isTruncated) {
          lines.push(`\n(continuationToken: ${result.continuationToken})`);
        }

        return {
          ok: true,
          content: lines.join("\n"),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult("EXEC_ERROR", `file_list failed: ${msg}`, false);
      }
    },
  };
}

// ── Bundle ──────────────────────────────────────────────────────────────────

export interface StorageToolSet {
  fileUpload: ToolDef<FileUploadArgs>;
  fileDownload: ToolDef<FileDownloadArgs>;
  fileList: ToolDef<FileListArgs>;
}

export function createStorageTools(): StorageToolSet {
  return {
    fileUpload: createFileUploadTool(),
    fileDownload: createFileDownloadTool(),
    fileList: createFileListTool(),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function guessContentType(key: string): string | undefined {
  const ext = key.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    pdf: "application/pdf",
    json: "application/json",
    csv: "text/csv",
    txt: "text/plain",
    md: "text/markdown",
    html: "text/html",
    htm: "text/html",
    xml: "application/xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    mp3: "audio/mpeg",
    zip: "application/zip",
    tar: "application/x-tar",
    gz: "application/gzip",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return ext ? map[ext] : undefined;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

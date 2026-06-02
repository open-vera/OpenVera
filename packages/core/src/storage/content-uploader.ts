/**
 * Content Uploader — Upload raw content to storage backends.
 *
 * Provides a simplified API for uploading text, JSON, or binary content
 * to an ObjectStore without requiring local files. Supports batch uploads,
 * presigned URL generation, and content type detection.
 */

import type { ObjectStore, PutOptions } from "./object-store.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** A single piece of content to upload */
export interface ContentItem {
  /** Object key in the store */
  key: string;
  /** The content to upload (string, JSON-serializable object, or binary) */
  content: string | Buffer | Uint8Array | Record<string, unknown> | unknown[];
  /** Optional MIME content type */
  contentType?: string;
  /** Optional custom metadata */
  metadata?: Record<string, string>;
  /** Cache-Control header */
  cacheControl?: string;
  /** Content-Disposition header */
  contentDisposition?: string;
  /** Overwrite existing object (default: true) */
  overwrite?: boolean;
}

/** Options for creating a ContentUploader */
export interface ContentUploadOptions {
  /** Object store to upload to */
  store: ObjectStore;
  /** Prefix for all uploaded object keys (default: "content/") */
  prefix?: string;
  /** Generate presigned URLs for uploaded content (default: true) */
  generateUrls?: boolean;
  /** Presigned URL expiry in seconds (default: 3600) */
  urlExpiry?: number;
  /** Default content type when none is provided (default: "application/octet-stream") */
  defaultContentType?: string;
}

/** Result for a single content upload */
export interface ContentUploadResult {
  /** The object key in the store */
  key: string;
  /** Size of the uploaded content in bytes */
  size: number;
  /** The content type that was used */
  contentType: string;
  /** Presigned URL (if generateUrls is enabled) */
  url?: string;
}

/** Result for a batch upload operation */
export interface BatchUploadResult {
  /** Successfully uploaded items */
  uploaded: ContentUploadResult[];
  /** Failed items with error messages */
  errors: Array<{ key: string; error: string }>;
  /** Total number of items attempted */
  total: number;
}

// ── Error Types ──────────────────────────────────────────────────────────────

export class ContentUploadError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ContentUploadError";
    this.code = code;
  }
}

export class ContentUploadValidationError extends ContentUploadError {
  constructor(message: string) {
    super("UPLOAD_VALIDATION", message);
    this.name = "ContentUploadValidationError";
  }
}

export class ContentUploadBatchError extends ContentUploadError {
  readonly results: BatchUploadResult;

  constructor(results: BatchUploadResult) {
    super(
      "UPLOAD_BATCH_PARTIAL",
      `${results.errors.length} of ${results.total} uploads failed`,
    );
    this.name = "ContentUploadBatchError";
    this.results = results;
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PREFIX = "content/";
const DEFAULT_URL_EXPIRY = 3600;
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

const EXTENSION_CONTENT_TYPE_MAP: Record<string, string> = {
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".yaml": "application/x-yaml",
  ".yml": "application/x-yaml",
  ".pdf": "application/pdf",
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
  ".log": "text/plain",
};

// ── ContentUploader ──────────────────────────────────────────────────────────

export class ContentUploader {
  private readonly store: ObjectStore;
  private readonly prefix: string;
  private readonly generateUrls: boolean;
  private readonly urlExpiry: number;
  private readonly defaultContentType: string;

  constructor(options: ContentUploadOptions) {
    this.store = options.store;
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    this.generateUrls = options.generateUrls ?? true;
    this.urlExpiry = options.urlExpiry ?? DEFAULT_URL_EXPIRY;
    this.defaultContentType = options.defaultContentType ?? DEFAULT_CONTENT_TYPE;
  }

  /**
   * Upload a single content item.
   */
  async upload(item: ContentItem): Promise<ContentUploadResult> {
    this.validateContentItem(item);

    const buffer = this.serializeContent(item.content);
    const objectKey = this.resolveKey(item.key);
    const contentType = this.resolveContentType(item.key, item.contentType);

    const putOptions: PutOptions = {
      contentType,
      metadata: item.metadata,
      cacheControl: item.cacheControl,
      contentDisposition: item.contentDisposition,
      overwrite: item.overwrite,
    };

    const meta = await this.store.put(objectKey, buffer, putOptions);

    let url: string | undefined;
    if (this.generateUrls) {
      try {
        url = await this.store.presignUrl(objectKey, { expiresIn: this.urlExpiry });
      } catch {
        // Presign may not be supported by all backends
      }
    }

    return {
      key: objectKey,
      size: meta.size,
      contentType: meta.contentType ?? contentType,
      url,
    };
  }

  /**
   * Upload multiple content items.
   * Individual failures do not fail the entire batch.
   *
   * Throws ContentUploadBatchError if at least one upload fails.
   * Even when thrown, the error includes the partial results.
   */
  async uploadBatch(items: ContentItem[]): Promise<BatchUploadResult> {
    if (items.length === 0) {
      return { uploaded: [], errors: [], total: 0 };
    }

    const result: BatchUploadResult = {
      uploaded: [],
      errors: [],
      total: items.length,
    };

    for (const item of items) {
      try {
        const uploadResult = await this.upload(item);
        result.uploaded.push(uploadResult);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push({ key: item.key, error: msg });
      }
    }

    if (result.errors.length > 0) {
      throw new ContentUploadBatchError(result);
    }

    return result;
  }

  /**
   * Upload text content with a given key.
   * Convenience wrapper around upload().
   */
  async uploadText(
    key: string,
    text: string,
    options?: {
      contentType?: string;
      metadata?: Record<string, string>;
      overwrite?: boolean;
    },
  ): Promise<ContentUploadResult> {
    return this.upload({
      key,
      content: text,
      contentType: options?.contentType ?? "text/plain",
      metadata: options?.metadata,
      overwrite: options?.overwrite,
    });
  }

  /**
   * Upload a JSON-serializable object.
   * Convenience wrapper around upload() that stringifies the value.
   */
  async uploadJson(
    key: string,
    value: Record<string, unknown> | unknown[],
    options?: {
      metadata?: Record<string, string>;
      overwrite?: boolean;
    },
  ): Promise<ContentUploadResult> {
    return this.upload({
      key,
      content: value,
      contentType: "application/json",
      metadata: options?.metadata,
      overwrite: options?.overwrite,
    });
  }

  /**
   * Upload binary content (Buffer or Uint8Array).
   * Convenience wrapper around upload().
   */
  async uploadBinary(
    key: string,
    buffer: Buffer | Uint8Array,
    options?: {
      contentType?: string;
      metadata?: Record<string, string>;
      overwrite?: boolean;
    },
  ): Promise<ContentUploadResult> {
    return this.upload({
      key,
      content: buffer,
      contentType: options?.contentType,
      metadata: options?.metadata,
      overwrite: options?.overwrite,
    });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private validateContentItem(item: ContentItem): void {
    if (!item.key || item.key.trim().length === 0) {
      throw new ContentUploadValidationError("key must be a non-empty string");
    }
    if (item.content === undefined || item.content === null) {
      throw new ContentUploadValidationError(`content for key "${item.key}" must not be null or undefined`);
    }
  }

  private serializeContent(
    content: string | Buffer | Uint8Array | Record<string, unknown> | unknown[],
  ): Buffer {
    if (Buffer.isBuffer(content)) {
      return content;
    }
    if (content instanceof Uint8Array) {
      return Buffer.from(content);
    }
    if (typeof content === "string") {
      return Buffer.from(content, "utf-8");
    }
    // Object or array — JSON serialize
    return Buffer.from(JSON.stringify(content), "utf-8");
  }

  private resolveKey(key: string): string {
    if (key.startsWith(this.prefix)) {
      return key;
    }
    return `${this.prefix}${key}`;
  }

  private resolveContentType(key: string, contentType?: string): string {
    if (contentType) {
      return contentType;
    }
    // Guess from file extension in the key
    const ext = key.toLowerCase().split(".").pop();
    if (ext && EXTENSION_CONTENT_TYPE_MAP[`.${ext}`]) {
      return EXTENSION_CONTENT_TYPE_MAP[`.${ext}`];
    }
    return this.defaultContentType;
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createContentUploader(options: ContentUploadOptions): ContentUploader {
  return new ContentUploader(options);
}

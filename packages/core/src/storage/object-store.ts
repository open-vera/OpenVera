/**
 * Object Store Abstraction Layer — Unified object storage interface for OpenVera.
 *
 * Provides an ObjectStore interface that abstracts over different cloud storage
 * backends (Alibaba OSS, AWS S3, Tencent TOS, local filesystem) so that file
 * upload, download, listing, and presigned URL generation can be performed uniformly.
 */

// ── Object Store Interface ──────────────────────────────────────────────────

export interface ObjectStore {
  readonly name: string;

  /** Upload a file. content can be a Buffer or a readable stream path. */
  put(key: string, content: Buffer | Uint8Array, options?: PutOptions): Promise<ObjectMetadata>;

  /** Download a file. Returns the file content as a Buffer. */
  get(key: string): Promise<GetResult>;

  /** Delete a file. No-op if file doesn't exist. */
  delete(key: string): Promise<void>;

  /** Delete multiple files. */
  deleteMany(keys: string[]): Promise<void>;

  /** List objects with optional prefix. */
  list(options?: ListOptions): Promise<ObjectListing>;

  /** Check if an object exists. */
  exists(key: string): Promise<boolean>;

  /** Get object metadata without downloading. */
  head(key: string): Promise<ObjectMetadata>;

  /** Generate a presigned URL for temporary access. */
  presignUrl(key: string, options?: PresignOptions): Promise<string>;

  /** Close the store and release resources. */
  close(): Promise<void>;
}

// ── Options & Results ───────────────────────────────────────────────────────

export interface PutOptions {
  /** MIME content type */
  contentType?: string;
  /** Custom metadata key-value pairs */
  metadata?: Record<string, string>;
  /** Cache-Control header */
  cacheControl?: string;
  /** Content-Disposition header (e.g., 'attachment; filename="report.pdf"') */
  contentDisposition?: string;
  /** Overwrite existing file (default: true) */
  overwrite?: boolean;
}

export interface GetResult {
  content: Buffer;
  metadata: ObjectMetadata;
}

export interface ObjectMetadata {
  key: string;
  size: number;
  etag?: string;
  contentType?: string;
  lastModified?: Date;
  metadata?: Record<string, string>;
}

export interface ListOptions {
  /** Filter by key prefix */
  prefix?: string;
  /** Delimiter for grouping (e.g., '/' for directory-style listing) */
  delimiter?: string;
  /** Maximum number of keys to return */
  maxKeys?: number;
  /** Continuation token for pagination */
  continuationToken?: string;
  /** Start after this key (exclusive) */
  startAfter?: string;
}

export interface ObjectListing {
  objects: ObjectMetadata[];
  /** Common prefixes (directories) when delimiter is used */
  prefixes: string[];
  /** Continuation token for next page (undefined if no more pages) */
  continuationToken?: string;
  /** Whether there are more results */
  isTruncated: boolean;
}

export interface PresignOptions {
  /** URL expiry in seconds (default: 3600) */
  expiresIn?: number;
  /** HTTP method (default: GET) */
  method?: "GET" | "PUT";
  /** Content-Type for PUT presigned URLs */
  contentType?: string;
}

// ── Configuration ───────────────────────────────────────────────────────────

export type ObjectStoreConfig =
  | LocalFsConfig
  | OssConfig
  | S3Config
  | TosConfig;

export interface LocalFsConfig {
  type: "local";
  /** Root directory for storing files */
  rootDir: string;
}

export interface OssConfig {
  type: "oss";
  /** Alibaba Cloud access key ID */
  accessKeyId: string;
  /** Alibaba Cloud access key secret */
  accessKeySecret: string;
  /** OSS bucket name */
  bucket: string;
  /** OSS region endpoint (e.g., oss-cn-hangzhou.aliyuncs.com) */
  endpoint: string;
  /** Optional prefix for all keys */
  prefix?: string;
  /** Use HTTPS (default: true) */
  secure?: boolean;
}

export interface S3Config {
  type: "s3";
  /** AWS access key ID */
  accessKeyId: string;
  /** AWS secret access key */
  secretAccessKey: string;
  /** S3 bucket name */
  bucket: string;
  /** AWS region (e.g., us-east-1) */
  region: string;
  /** Custom endpoint for S3-compatible services (e.g., MinIO) */
  endpoint?: string;
  /** Optional prefix for all keys */
  prefix?: string;
  /** Force path-style URLs (needed for MinIO) */
  forcePathStyle?: boolean;
}

export interface TosConfig {
  type: "tos";
  /** Tencent Cloud secret ID */
  secretId: string;
  /** Tencent Cloud secret key */
  secretKey: string;
  /** TOS bucket name */
  bucket: string;
  /** TOS region (e.g., ap-guangzhou) */
  region: string;
  /** Optional custom endpoint */
  endpoint?: string;
  /** Optional prefix for all keys */
  prefix?: string;
}

// ── Error Types ─────────────────────────────────────────────────────────────

export class ObjectStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ObjectStoreError";
    this.code = code;
  }
}

export class ObjectNotFoundError extends ObjectStoreError {
  constructor(key: string) {
    super("OBJECT_NOT_FOUND", `Object not found: ${key}`);
    this.name = "ObjectNotFoundError";
  }
}

export class ObjectAlreadyExistsError extends ObjectStoreError {
  constructor(key: string) {
    super("OBJECT_ALREADY_EXISTS", `Object already exists: ${key}`);
    this.name = "ObjectAlreadyExistsError";
  }
}

export class ObjectStoreConnectionError extends ObjectStoreError {
  constructor(store: string, detail: string, options?: ErrorOptions) {
    super("OBJECT_STORE_CONNECTION", `${store}: ${detail}`, options);
    this.name = "ObjectStoreConnectionError";
  }
}

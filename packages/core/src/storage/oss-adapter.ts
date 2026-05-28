/**
 * Alibaba Cloud OSS ObjectStore adapter.
 *
 * Requires the `ali-oss` package. Install with: pnpm add ali-oss
 * Type definitions: pnpm add -D @types/ali-oss
 */

import type {
  ObjectStore,
  PutOptions,
  GetResult,
  ObjectMetadata,
  ListOptions,
  ObjectListing,
  PresignOptions,
  OssConfig,
} from "./object-store.js";
import { ObjectStoreConnectionError, ObjectNotFoundError, ObjectStoreError } from "./object-store.js";

export class OssObjectStore implements ObjectStore {
  readonly name = "oss";
  private readonly config: OssConfig;
  private client: unknown = null;
  private prefix: string;

  constructor(config: OssConfig) {
    this.config = config;
    this.prefix = config.prefix ?? "";
  }

  private async getClient(): Promise<Record<string, (...args: unknown[]) => unknown>> {
    if (this.client) return this.client as Record<string, (...args: unknown[]) => unknown>;

    try {
      // Dynamic import to avoid hard dependency
      const OSS = (await import("ali-oss")).default;
      this.client = new OSS({
        accessKeyId: this.config.accessKeyId,
        accessKeySecret: this.config.accessKeySecret,
        bucket: this.config.bucket,
        endpoint: this.config.endpoint,
        secure: this.config.secure ?? true,
      });
      return this.client as Record<string, (...args: unknown[]) => unknown>;
    } catch {
      throw new ObjectStoreConnectionError(
        "oss",
        "ali-oss package not installed. Run: pnpm add ali-oss",
      );
    }
  }

  private fullKey(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  private stripPrefix(key: string): string {
    if (this.prefix && key.startsWith(this.prefix + "/")) {
      return key.slice(this.prefix.length + 1);
    }
    return key;
  }

  async put(key: string, content: Buffer | Uint8Array, options?: PutOptions): Promise<ObjectMetadata> {
    const client = await this.getClient();
    const fullKey = this.fullKey(key);

    const result = await client.put(fullKey, Buffer.from(content), {
      headers: {
        "Content-Type": options?.contentType ?? "application/octet-stream",
        ...(options?.cacheControl ? { "Cache-Control": options.cacheControl } : {}),
        ...(options?.contentDisposition ? { "Content-Disposition": options.contentDisposition } : {}),
        ...this.encodeMetadata(options?.metadata),
      },
    }) as { name: string; url: string; res: { status: number; headers: Record<string, string> } };

    return {
      key,
      size: content.byteLength,
      etag: result.res.headers?.etag,
      contentType: options?.contentType,
      lastModified: new Date(),
      metadata: options?.metadata,
    };
  }

  async get(key: string): Promise<GetResult> {
    const client = await this.getClient();
    const fullKey = this.fullKey(key);

    try {
      const result = await client.get(fullKey) as { content: Buffer; res: { headers: Record<string, string> } };
      const headResult = await this.head(key);

      return {
        content: result.content,
        metadata: headResult,
      };
    } catch (err: unknown) {
      if (isOssNotFound(err)) throw new ObjectNotFoundError(key);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const client = await this.getClient();
    const fullKey = this.fullKey(key);

    try {
      await client.delete(fullKey);
    } catch (err: unknown) {
      if (isOssNotFound(err)) return;
      throw err;
    }
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const client = await this.getClient();
    const fullKeys = keys.map((k) => this.fullKey(k));

    await client.deleteMulti(fullKeys, { quiet: true });
  }

  async list(options?: ListOptions): Promise<ObjectListing> {
    const client = await this.getClient();
    const prefix = options?.prefix ? this.fullKey(options.prefix) : this.prefix ? `${this.prefix}/` : "";

    const result = await client.list({
      prefix,
      delimiter: options?.delimiter,
      "max-keys": options?.maxKeys ?? 1000,
      "marker": options?.continuationToken ?? options?.startAfter ?? "",
    }) as {
      objects?: Array<{ name: string; size: number; etag: string; lastModified: string }>;
      prefixes?: string[];
      isTruncated: boolean;
      nextMarker?: string;
    };

    const objects: ObjectMetadata[] = (result.objects ?? []).map((obj) => ({
      key: this.stripPrefix(obj.name),
      size: obj.size,
      etag: obj.etag,
      lastModified: new Date(obj.lastModified),
    }));

    return {
      objects,
      prefixes: (result.prefixes ?? []).map((p) => this.stripPrefix(p)),
      continuationToken: result.nextMarker,
      isTruncated: result.isTruncated,
    };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.head(key);
      return true;
    } catch (err) {
      if (err instanceof ObjectNotFoundError) return false;
      throw err;
    }
  }

  async head(key: string): Promise<ObjectMetadata> {
    const client = await this.getClient();
    const fullKey = this.fullKey(key);

    try {
      const result = await client.head(fullKey) as {
        res: { status: number; headers: Record<string, string>; meta: Record<string, string> };
      };

      return {
        key,
        size: parseInt(result.res.headers["content-length"] ?? "0", 10),
        etag: result.res.headers.etag,
        contentType: result.res.headers["content-type"],
        lastModified: result.res.headers["last-modified"]
          ? new Date(result.res.headers["last-modified"])
          : undefined,
        metadata: this.decodeMetadata(result.res.meta),
      };
    } catch (err: unknown) {
      if (isOssNotFound(err)) throw new ObjectNotFoundError(key);
      throw err;
    }
  }

  async presignUrl(key: string, options?: PresignOptions): Promise<string> {
    const client = await this.getClient();
    const fullKey = this.fullKey(key);

    const method = options?.method === "PUT" ? "put" : "get";
    const expires = options?.expiresIn ?? 3600;

    return client.signatureUrl(fullKey, {
      expires,
      method,
    }) as string;
  }

  async close(): Promise<void> {
    this.client = null;
  }

  private encodeMetadata(metadata?: Record<string, string>): Record<string, string> {
    if (!metadata) return {};
    const encoded: Record<string, string> = {};
    for (const [k, v] of Object.entries(metadata)) {
      encoded[`x-oss-meta-${k}`] = v;
    }
    return encoded;
  }

  private decodeMetadata(headers: Record<string, string>): Record<string, string> {
    const decoded: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (k.startsWith("x-oss-meta-")) {
        decoded[k.slice("x-oss-meta-".length)] = v;
      }
    }
    return decoded;
  }
}

function isOssNotFound(err: unknown): boolean {
  if (err && typeof err === "object" && "status" in err) {
    return (err as { status: number }).status === 404;
  }
  if (err && typeof err === "object" && "code" in err) {
    return (err as { code: string }).code === "NoSuchKey";
  }
  return false;
}

/**
 * Tencent Cloud TOS (Tencent Object Storage) adapter.
 *
 * Requires the @volcengine/tesla-sdk or tos-sdk package. Install with:
 *   pnpm add tos-sdk
 */

import type {
  ObjectStore,
  PutOptions,
  GetResult,
  ObjectMetadata,
  ListOptions,
  ObjectListing,
  PresignOptions,
  TosConfig,
} from "./object-store.js";
import { ObjectStoreConnectionError, ObjectNotFoundError } from "./object-store.js";

export class TosObjectStore implements ObjectStore {
  readonly name = "tos";
  private readonly config: TosConfig;
  private client: unknown = null;
  private prefix: string;

  constructor(config: TosConfig) {
    this.config = config;
    this.prefix = config.prefix ?? "";
  }

  private async getClient(): Promise<Record<string, (...args: unknown[]) => unknown>> {
    if (this.client) return this.client as Record<string, (...args: unknown[]) => unknown>;

    try {
      const TOS = (await import("tos-sdk")).default;
      this.client = new TOS({
        accessKeyId: this.config.secretId,
        accessKeySecret: this.config.secretKey,
        bucket: this.config.bucket,
        region: this.config.region,
        endpoint: this.config.endpoint,
      });
      return this.client as Record<string, (...args: unknown[]) => unknown>;
    } catch {
      throw new ObjectStoreConnectionError(
        "tos",
        "tos-sdk package not installed. Run: pnpm add tos-sdk",
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

    await client.putObject({
      bucket: this.config.bucket,
      key: fullKey,
      body: Buffer.from(content),
      contentType: options?.contentType ?? "application/octet-stream",
      cacheControl: options?.cacheControl,
      contentDisposition: options?.contentDisposition,
      meta: options?.metadata,
    });

    return {
      key,
      size: content.byteLength,
      contentType: options?.contentType,
      lastModified: new Date(),
      metadata: options?.metadata,
    };
  }

  async get(key: string): Promise<GetResult> {
    const client = await this.getClient();
    const fullKey = this.fullKey(key);

    try {
      const result = (await client.getObject({
        bucket: this.config.bucket,
        key: fullKey,
      })) as { data: Buffer | Uint8Array };

      const content = Buffer.from(result.data);
      const headResult = await this.head(key);

      return {
        content,
        metadata: headResult,
      };
    } catch (err: unknown) {
      if (isTosNotFound(err)) throw new ObjectNotFoundError(key);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const client = await this.getClient();
    const fullKey = this.fullKey(key);

    try {
      await client.deleteObject({
        bucket: this.config.bucket,
        key: fullKey,
      });
    } catch (err: unknown) {
      if (isTosNotFound(err)) return;
      throw err;
    }
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await Promise.all(keys.map((k) => this.delete(k)));
  }

  async list(options?: ListOptions): Promise<ObjectListing> {
    const client = await this.getClient();
    const prefix = options?.prefix ? this.fullKey(options.prefix) : this.prefix ? `${this.prefix}/` : "";

    const result = (await client.listObjects({
      bucket: this.config.bucket,
      prefix,
      delimiter: options?.delimiter,
      maxKeys: options?.maxKeys ?? 1000,
      marker: options?.continuationToken ?? options?.startAfter ?? "",
    })) as {
      contents?: Array<{ key: string; size: number; etag: string; lastModified: string }>;
      commonPrefixes?: Array<{ prefix: string }>;
      nextMarker?: string;
      isTruncated?: boolean;
    };

    const objects: ObjectMetadata[] = (result.contents ?? []).map((obj) => ({
      key: this.stripPrefix(obj.key),
      size: obj.size,
      etag: obj.etag,
      lastModified: new Date(obj.lastModified),
    }));

    return {
      objects,
      prefixes: (result.commonPrefixes ?? []).map((p) => this.stripPrefix(p.prefix)),
      continuationToken: result.nextMarker,
      isTruncated: result.isTruncated ?? false,
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
      const result = (await client.headObject({
        bucket: this.config.bucket,
        key: fullKey,
      })) as { headers?: Record<string, string>; meta?: Record<string, string> };

      return {
        key,
        size: parseInt(result.headers?.["content-length"] ?? "0", 10),
        etag: result.headers?.etag,
        contentType: result.headers?.["content-type"],
        lastModified: result.headers?.["last-modified"]
          ? new Date(result.headers["last-modified"])
          : undefined,
        metadata: result.meta,
      };
    } catch (err: unknown) {
      if (isTosNotFound(err)) throw new ObjectNotFoundError(key);
      throw err;
    }
  }

  async presignUrl(key: string, options?: PresignOptions): Promise<string> {
    const client = await this.getClient();
    const fullKey = this.fullKey(key);

    return client.getPreSignedUrl({
      bucket: this.config.bucket,
      key: fullKey,
      method: options?.method === "PUT" ? "PUT" : "GET",
      expires: options?.expiresIn ?? 3600,
    }) as string;
  }

  async close(): Promise<void> {
    this.client = null;
  }
}

function isTosNotFound(err: unknown): boolean {
  if (err && typeof err === "object" && "statusCode" in err) {
    return (err as { statusCode: number }).statusCode === 404;
  }
  if (err && typeof err === "object" && "code" in err) {
    return (err as { code: string }).code === "NoSuchKey";
  }
  return false;
}

/**
 * AWS S3 ObjectStore adapter (compatible with MinIO and other S3-compatible services).
 *
 * Requires the @aws-sdk/client-s3 package. Install with:
 *   pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
 */

import type {
  ObjectStore,
  PutOptions,
  GetResult,
  ObjectMetadata,
  ListOptions,
  ObjectListing,
  PresignOptions,
  S3Config,
} from "./object-store.js";
import { ObjectStoreConnectionError, ObjectNotFoundError } from "./object-store.js";

export class S3ObjectStore implements ObjectStore {
  readonly name = "s3";
  private readonly config: S3Config;
  private client: unknown = null;
  private prefix: string;

  constructor(config: S3Config) {
    this.config = config;
    this.prefix = config.prefix ?? "";
  }

  private async getClient(): Promise<Record<string, (...args: unknown[]) => unknown>> {
    if (this.client) return this.client as Record<string, (...args: unknown[]) => unknown>;

    try {
      const { S3Client } = await import("@aws-sdk/client-s3");
      this.client = new S3Client({
        region: this.config.region,
        endpoint: this.config.endpoint,
        forcePathStyle: this.config.forcePathStyle ?? !!this.config.endpoint,
        credentials: {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
        },
      });
      return this.client as Record<string, (...args: unknown[]) => unknown>;
    } catch {
      throw new ObjectStoreConnectionError(
        "s3",
        "@aws-sdk/client-s3 package not installed. Run: pnpm add @aws-sdk/client-s3",
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
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");

    const fullKey = this.fullKey(key);
    await client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: fullKey,
        Body: Buffer.from(content),
        ContentType: options?.contentType ?? "application/octet-stream",
        CacheControl: options?.cacheControl,
        ContentDisposition: options?.contentDisposition,
        Metadata: options?.metadata,
      }),
    );

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
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");

    const fullKey = this.fullKey(key);

    try {
      const result = await client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: fullKey,
        }),
      ) as {
        Body: AsyncIterable<Uint8Array>;
        ContentLength?: number;
        ContentType?: string;
        ETag?: string;
        LastModified?: Date;
        Metadata?: Record<string, string>;
      };

      const chunks: Uint8Array[] = [];
      for await (const chunk of result.Body) {
        chunks.push(chunk);
      }
      const content = Buffer.concat(chunks);

      return {
        content,
        metadata: {
          key,
          size: result.ContentLength ?? content.byteLength,
          etag: result.ETag,
          contentType: result.ContentType,
          lastModified: result.LastModified,
          metadata: result.Metadata,
        },
      };
    } catch (err: unknown) {
      if (isS3NotFound(err)) throw new ObjectNotFoundError(key);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const client = await this.getClient();
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");

    await client.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: this.fullKey(key),
      }),
    );
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const client = await this.getClient();
    const { DeleteObjectsCommand } = await import("@aws-sdk/client-s3");

    await client.send(
      new DeleteObjectsCommand({
        Bucket: this.config.bucket,
        Delete: {
          Objects: keys.map((k) => ({ Key: this.fullKey(k) })),
        },
      }),
    );
  }

  async list(options?: ListOptions): Promise<ObjectListing> {
    const client = await this.getClient();
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");

    const prefix = options?.prefix ? this.fullKey(options.prefix) : this.prefix ? `${this.prefix}/` : "";

    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: prefix,
        Delimiter: options?.delimiter,
        MaxKeys: options?.maxKeys ?? 1000,
        ContinuationToken: options?.continuationToken,
        StartAfter: options?.startAfter,
      }),
    ) as {
      Contents?: Array<{ Key: string; Size: number; ETag: string; LastModified: Date }>;
      CommonPrefixes?: Array<{ Prefix: string }>;
      IsTruncated?: boolean;
      NextContinuationToken?: string;
    };

    const objects: ObjectMetadata[] = (result.Contents ?? []).map((obj) => ({
      key: this.stripPrefix(obj.Key),
      size: obj.Size,
      etag: obj.ETag,
      lastModified: obj.LastModified,
    }));

    return {
      objects,
      prefixes: (result.CommonPrefixes ?? []).map((p) => this.stripPrefix(p.Prefix)),
      continuationToken: result.NextContinuationToken,
      isTruncated: result.IsTruncated ?? false,
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
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");

    const fullKey = this.fullKey(key);

    try {
      const result = await client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: fullKey,
        }),
      ) as {
        ContentLength?: number;
        ContentType?: string;
        ETag?: string;
        LastModified?: Date;
        Metadata?: Record<string, string>;
      };

      return {
        key,
        size: result.ContentLength ?? 0,
        etag: result.ETag,
        contentType: result.ContentType,
        lastModified: result.LastModified,
        metadata: result.Metadata,
      };
    } catch (err: unknown) {
      if (isS3NotFound(err)) throw new ObjectNotFoundError(key);
      throw err;
    }
  }

  async presignUrl(key: string, options?: PresignOptions): Promise<string> {
    const client = await this.getClient();
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const { GetObjectCommand, PutObjectCommand } = await import("@aws-sdk/client-s3");

    const fullKey = this.fullKey(key);
    const command =
      options?.method === "PUT"
        ? new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: fullKey,
            ContentType: options?.contentType,
          })
        : new GetObjectCommand({
            Bucket: this.config.bucket,
            Key: fullKey,
          });

    return getSignedUrl(client as Parameters<typeof getSignedUrl>[0], command, {
      expiresIn: options?.expiresIn ?? 3600,
    }) as Promise<string>;
  }

  async close(): Promise<void> {
    if (this.client && typeof (this.client as { destroy?: () => void }).destroy === "function") {
      (this.client as { destroy: () => void }).destroy();
    }
    this.client = null;
  }
}

function isS3NotFound(err: unknown): boolean {
  if (err && typeof err === "object" && "name" in err) {
    return (err as { name: string }).name === "NoSuchKey" || (err as { name: string }).name === "NotFound";
  }
  if (err && typeof err === "object" && "$metadata" in err) {
    const meta = (err as { $metadata: { httpStatusCode?: number } }).$metadata;
    return meta.httpStatusCode === 404;
  }
  return false;
}

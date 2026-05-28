/**
 * Local filesystem ObjectStore adapter.
 *
 * Stores objects as files on the local filesystem. Useful for development,
 * testing, and single-machine deployments.
 */

import { mkdir, readFile, writeFile, unlink, stat, readdir, rm, rename } from "node:fs/promises";
import { join, dirname, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ObjectStore,
  PutOptions,
  GetResult,
  ObjectMetadata,
  ListOptions,
  ObjectListing,
  PresignOptions,
  LocalFsConfig,
} from "./object-store.js";
import {
  ObjectNotFoundError,
  ObjectAlreadyExistsError,
  ObjectStoreError,
} from "./object-store.js";

export class LocalFsObjectStore implements ObjectStore {
  readonly name = "local-fs";
  private readonly rootDir: string;

  constructor(config: LocalFsConfig) {
    this.rootDir = config.rootDir;
  }

  async put(key: string, content: Buffer | Uint8Array, options?: PutOptions): Promise<ObjectMetadata> {
    const filePath = this.resolvePath(key);

    if (options?.overwrite === false) {
      try {
        await stat(filePath);
        throw new ObjectAlreadyExistsError(key);
      } catch (err) {
        if (err instanceof ObjectAlreadyExistsError) throw err;
        // File doesn't exist, proceed
      }
    }

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);

    const meta: ObjectMetadata = {
      key,
      size: content.byteLength,
      contentType: options?.contentType,
      lastModified: new Date(),
      metadata: options?.metadata,
    };

    // Store metadata as a sidecar JSON file
    await this.writeMeta(key, {
      contentType: options?.contentType,
      metadata: options?.metadata,
      cacheControl: options?.cacheControl,
      contentDisposition: options?.contentDisposition,
    });

    return meta;
  }

  async get(key: string): Promise<GetResult> {
    const filePath = this.resolvePath(key);

    try {
      const content = await readFile(filePath);
      const fileStat = await stat(filePath);
      const meta = await this.readMeta(key);

      return {
        content,
        metadata: {
          key,
          size: fileStat.size,
          contentType: meta?.contentType,
          lastModified: fileStat.mtime,
          metadata: meta?.metadata,
        },
      };
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") {
        throw new ObjectNotFoundError(key);
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolvePath(key);
    const metaPath = this.metaPath(key);

    try {
      await unlink(filePath);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") return;
      throw err;
    }

    // Clean up metadata sidecar
    try {
      await unlink(metaPath);
    } catch {
      // Ignore if meta doesn't exist
    }
  }

  async deleteMany(keys: string[]): Promise<void> {
    await Promise.all(keys.map((k) => this.delete(k)));
  }

  async list(options?: ListOptions): Promise<ObjectListing> {
    const prefix = options?.prefix ?? "";
    const maxKeys = options?.maxKeys ?? 1000;
    const rootLen = this.rootDir.length + 1;

    const objects: ObjectMetadata[] = [];
    const prefixes: Set<string> = new Set();

    await this.walkDir(join(this.rootDir, prefix), (filePath, fileStat) => {
      if (objects.length >= maxKeys) return;

      const rel = relative(this.rootDir, filePath).split(sep).join("/");
      if (!rel.endsWith(".meta.json")) {
        objects.push({
          key: rel,
          size: Number(fileStat.size),
          lastModified: fileStat.mtime,
        });
      }
    });

    // Sort by key
    objects.sort((a, b) => a.key.localeCompare(b.key));

    // Handle delimiter-based grouping
    if (options?.delimiter) {
      const grouped: ObjectMetadata[] = [];
      const prefixLen = prefix.length;

      for (const obj of objects) {
        const rest = obj.key.slice(prefixLen);
        const idx = rest.indexOf(options.delimiter);

        if (idx >= 0) {
          // This object is under a "subdirectory"
          const dir = prefix + rest.slice(0, idx + options.delimiter.length);
          prefixes.add(dir);
        } else {
          grouped.push(obj);
        }
      }

      return {
        objects: grouped,
        prefixes: [...prefixes].sort(),
        isTruncated: false,
      };
    }

    return {
      objects,
      prefixes: [],
      isTruncated: false,
    };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolvePath(key));
      return true;
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") return false;
      throw err;
    }
  }

  async head(key: string): Promise<ObjectMetadata> {
    const filePath = this.resolvePath(key);

    try {
      const fileStat = await stat(filePath);
      const meta = await this.readMeta(key);

      return {
        key,
        size: fileStat.size,
        contentType: meta?.contentType,
        lastModified: fileStat.mtime,
        metadata: meta?.metadata,
      };
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") {
        throw new ObjectNotFoundError(key);
      }
      throw err;
    }
  }

  async presignUrl(key: string, _options?: PresignOptions): Promise<string> {
    // Local filesystem doesn't support presigned URLs natively.
    // Return a file:// URL for local access.
    const filePath = this.resolvePath(key);
    if (!(await this.exists(key))) {
      throw new ObjectNotFoundError(key);
    }
    return `file://${filePath}`;
  }

  async close(): Promise<void> {
    // No resources to release for local filesystem
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private resolvePath(key: string): string {
    // Normalize and prevent path traversal
    const normalized = key.replace(/\\/g, "/").replace(/\.\./g, "");
    return join(this.rootDir, normalized);
  }

  private metaPath(key: string): string {
    return this.resolvePath(key) + ".meta.json";
  }

  private async writeMeta(key: string, meta: Record<string, unknown>): Promise<void> {
    const metaPath = this.metaPath(key);
    await mkdir(dirname(metaPath), { recursive: true });
    await writeFile(metaPath, JSON.stringify(meta, null, 2));
  }

  private async readMeta(key: string): Promise<{ contentType?: string; metadata?: Record<string, string> } | null> {
    try {
      const data = await readFile(this.metaPath(key), "utf-8");
      const parsed = JSON.parse(data) as Record<string, unknown>;
      return {
        contentType: typeof parsed.contentType === "string" ? parsed.contentType : undefined,
        metadata: isStringRecord(parsed.metadata) ? parsed.metadata : undefined,
      };
    } catch {
      return null;
    }
  }

  private async walkDir(
    dir: string,
    callback: (filePath: string, fileStat: Awaited<ReturnType<typeof stat>>) => void | Promise<void>,
  ): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          await this.walkDir(fullPath, callback);
        } else if (entry.isFile() && !entry.name.endsWith(".meta.json")) {
          const fileStat = await stat(fullPath);
          await callback(fullPath, fileStat);
        }
      }
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") return;
      throw err;
    }
  }
}

export function createLocalFsStore(rootDir: string): LocalFsObjectStore {
  return new LocalFsObjectStore({ type: "local", rootDir });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function isStringRecord(val: unknown): val is Record<string, string> {
  if (!val || typeof val !== "object") return false;
  return Object.values(val).every((v) => typeof v === "string");
}

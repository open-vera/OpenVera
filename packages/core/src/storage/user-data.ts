/**
 * UserDataStore — User-facing data storage with data_save/data_load tools.
 *
 * Wraps a StorageProvider to provide structured user data management
 * with namespaces, metadata, TTL, and validation.
 */

import type { StorageProvider, StorageValue, UserDataEntry } from "./types.js";
import { StorageNotFoundError } from "./types.js";
import type { ToolDef, ToolResult, ToolContext } from "../tools/types.js";
import { errorResult } from "../tools/types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const STORAGE_NAMESPACE = "user-data";

/** Maximum key length in characters */
const MAX_KEY_LENGTH = 256;
/** Maximum serialized value size in bytes (1 MB) */
const MAX_VALUE_SIZE_BYTES = 1_048_576;
/** Maximum namespaces per user */
const MAX_NAMESPACES = 50;

// ── Internal Types ────────────────────────────────────────────────────────────

/** Stored envelope for user data entries */
interface StoredUserEntry {
  key: string;
  value: StorageValue;
  namespace: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  ttl?: number;
  expiresAt?: string;
}

// ── UserDataStore ─────────────────────────────────────────────────────────────

export class UserDataStore {
  private readonly provider: StorageProvider;
  private initialized = false;

  constructor(provider: StorageProvider) {
    this.provider = provider;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.provider.initialize();
      this.initialized = true;
    }
  }

  // ── Validation ──────────────────────────────────────────────────────────────

  private validateKey(key: string): void {
    if (key.length === 0) {
      throw new ValidationError("KEY_EMPTY", "Key must not be empty");
    }
    if (key.length > MAX_KEY_LENGTH) {
      throw new ValidationError(
        "KEY_TOO_LONG",
        `Key length (${key.length}) exceeds maximum (${MAX_KEY_LENGTH})`
      );
    }
  }

  private validateValue(value: StorageValue): void {
    const serialized = JSON.stringify(value);
    const sizeBytes = new TextEncoder().encode(serialized).byteLength;
    if (sizeBytes > MAX_VALUE_SIZE_BYTES) {
      throw new ValidationError(
        "VALUE_TOO_LARGE",
        `Value size (${sizeBytes} bytes) exceeds maximum (${MAX_VALUE_SIZE_BYTES} bytes / 1 MB)`
      );
    }
  }

  private validateNamespace(namespace: string): void {
    if (namespace.length === 0) {
      throw new ValidationError("NAMESPACE_EMPTY", "Namespace must not be empty");
    }
  }

  private storageKey(namespace: string, key: string): string {
    return `${namespace}::${key}`;
  }

  // ── CRUD Operations ─────────────────────────────────────────────────────────

  async save(params: {
    key: string;
    value: StorageValue;
    namespace?: string;
    description?: string;
    ttl?: number;
  }): Promise<UserDataEntry> {
    await this.ensureInitialized();

    const ns = params.namespace ?? "default";
    this.validateKey(params.key);
    this.validateValue(params.value);
    this.validateNamespace(ns);

    const now = new Date().toISOString();
    const storeKey = this.storageKey(ns, params.key);

    // Check namespace limit (only when creating a new entry)
    const existing = await this.provider.get(STORAGE_NAMESPACE, storeKey);
    if (!existing) {
      await this.enforceNamespaceLimit(ns);
    }

    const entry: StoredUserEntry = {
      key: params.key,
      value: params.value,
      namespace: ns,
      description: params.description,
      createdAt: existing
        ? (existing as unknown as StoredUserEntry).createdAt
        : now,
      updatedAt: now,
      ttl: params.ttl,
      expiresAt: params.ttl
        ? new Date(Date.now() + params.ttl * 1000).toISOString()
        : undefined,
    };

    await this.provider.set(STORAGE_NAMESPACE, storeKey, entry as unknown as StorageValue);

    return toUserDataEntry(entry);
  }

  async load(params: {
    key: string;
    namespace?: string;
  }): Promise<UserDataEntry> {
    await this.ensureInitialized();

    const ns = params.namespace ?? "default";
    this.validateKey(params.key);

    const storeKey = this.storageKey(ns, params.key);
    const raw = await this.provider.get(STORAGE_NAMESPACE, storeKey);

    if (raw === undefined) {
      throw new StorageNotFoundError(ns, params.key);
    }

    const entry = raw as unknown as StoredUserEntry;

    // Check TTL expiry
    if (entry.expiresAt && new Date(entry.expiresAt).getTime() < Date.now()) {
      // Expired — delete and report not found
      await this.provider.delete(STORAGE_NAMESPACE, storeKey);
      throw new StorageNotFoundError(ns, params.key);
    }

    return toUserDataEntry(entry);
  }

  async list(params: {
    namespace?: string;
  }): Promise<UserDataEntry[]> {
    await this.ensureInitialized();

    const ns = params.namespace ?? "default";
    const keys = await this.provider.listKeys(STORAGE_NAMESPACE);

    const entries: UserDataEntry[] = [];
    const now = Date.now();

    for (const storeKey of keys) {
      const parsed = parseStorageKey(storeKey);
      if (!parsed || parsed.namespace !== ns) continue;

      const raw = await this.provider.get(STORAGE_NAMESPACE, storeKey);
      if (raw === undefined) continue;

      const entry = raw as unknown as StoredUserEntry;

      // Skip expired entries
      if (entry.expiresAt && new Date(entry.expiresAt).getTime() < now) {
        // Best-effort cleanup
        void this.provider.delete(STORAGE_NAMESPACE, storeKey).catch(() => {});
        continue;
      }

      entries.push(toUserDataEntry(entry));
    }

    // Sort by updatedAt descending
    entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return entries;
  }

  async delete(params: {
    key: string;
    namespace?: string;
  }): Promise<boolean> {
    await this.ensureInitialized();

    const ns = params.namespace ?? "default";
    this.validateKey(params.key);

    const storeKey = this.storageKey(ns, params.key);
    return this.provider.delete(STORAGE_NAMESPACE, storeKey);
  }

  // ── Namespace Management ────────────────────────────────────────────────────

  async listNamespaces(): Promise<string[]> {
    await this.ensureInitialized();

    const keys = await this.provider.listKeys(STORAGE_NAMESPACE);
    const namespaces = new Set<string>();
    const now = Date.now();

    for (const storeKey of keys) {
      const parsed = parseStorageKey(storeKey);
      if (!parsed) continue;

      // Check expiry
      const raw = await this.provider.get(STORAGE_NAMESPACE, storeKey);
      if (raw === undefined) continue;
      const entry = raw as unknown as StoredUserEntry;
      if (entry.expiresAt && new Date(entry.expiresAt).getTime() < now) {
        continue;
      }

      namespaces.add(parsed.namespace);
    }

    return [...namespaces].sort();
  }

  private async enforceNamespaceLimit(excludeNamespace: string): Promise<void> {
    const namespaces = await this.listNamespaces();
    if (!namespaces.includes(excludeNamespace) && namespaces.length >= MAX_NAMESPACES) {
      throw new ValidationError(
        "NAMESPACE_LIMIT",
        `Maximum number of namespaces (${MAX_NAMESPACES}) reached. ` +
        `Delete entries from unused namespaces before creating new ones.`
      );
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toUserDataEntry(entry: StoredUserEntry): UserDataEntry {
  return {
    key: entry.key,
    value: entry.value,
    namespace: entry.namespace,
    description: entry.description,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function parseStorageKey(storeKey: string): { namespace: string; key: string } | null {
  const idx = storeKey.indexOf("::");
  if (idx <= 0) return null;
  return {
    namespace: storeKey.slice(0, idx),
    key: storeKey.slice(idx + 2),
  };
}

// ── Validation Error ──────────────────────────────────────────────────────────

export class ValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}

// ── Tool Definitions ──────────────────────────────────────────────────────────

export interface DataSaveArgs {
  key: string;
  value: StorageValue;
  namespace?: string;
  description?: string;
  ttl?: number;
}

export interface DataLoadArgs {
  key: string;
  namespace?: string;
}

export interface DataListArgs {
  namespace?: string;
}

export interface DataDeleteArgs {
  key: string;
  namespace?: string;
}

export function createDataSaveTool(store: UserDataStore): ToolDef<DataSaveArgs> {
  return {
    name: "data_save",
    description:
      "Save data to persistent user storage. Supports JSON objects, arrays, strings, numbers, and booleans. " +
      "Use namespaces to organize data (default namespace is 'default'). " +
      "Optionally set a TTL (in seconds) for temporary data.",
    parameters: {
      type: "object" as const,
      required: ["key", "value"],
      properties: {
        key: {
          type: "string" as const,
          description: `Unique key for the data entry (max ${MAX_KEY_LENGTH} chars)`,
        },
        value: {
          description: "The data to store — any JSON-serializable value (object, array, string, number, boolean, null)",
        },
        namespace: {
          type: "string" as const,
          description: "Namespace to organize data (default: 'default', max 50 namespaces per user)",
        },
        description: {
          type: "string" as const,
          description: "Optional description of what this data is for",
        },
        ttl: {
          type: "number" as const,
          description: "Optional TTL in seconds — the entry will be automatically deleted after this duration",
        },
      },
    },
    options: { idempotent: false, riskLevel: "low" },
    execute: async (args: DataSaveArgs, _ctx: ToolContext): Promise<ToolResult> => {
      try {
        const entry = await store.save({
          key: args.key,
          value: args.value,
          namespace: args.namespace,
          description: args.description,
          ttl: args.ttl,
        });

        const nsDisplay = entry.namespace ?? "default";
        const ttlNote = args.ttl ? ` (TTL: ${args.ttl}s)` : "";
        return {
          ok: true,
          content: `Saved "${args.key}" in namespace "${nsDisplay}"${ttlNote}.\nValue: ${JSON.stringify(entry.value, null, 2)}`,
        };
      } catch (err) {
        if (err instanceof ValidationError) {
          return errorResult("EXEC_ERROR", `[${err.code}] ${err.message}`, false);
        }
        return errorResult("EXEC_ERROR", err instanceof Error ? err.message : String(err), false);
      }
    },
  };
}

export function createDataLoadTool(store: UserDataStore): ToolDef<DataLoadArgs> {
  return {
    name: "data_load",
    description:
      "Load data from persistent user storage by key and optional namespace.",
    parameters: {
      type: "object" as const,
      required: ["key"],
      properties: {
        key: {
          type: "string" as const,
          description: "The key of the data entry to load",
        },
        namespace: {
          type: "string" as const,
          description: "Namespace to load from (default: 'default')",
        },
      },
    },
    options: { idempotent: true, riskLevel: "low" },
    execute: async (args: DataLoadArgs, _ctx: ToolContext): Promise<ToolResult> => {
      try {
        const entry = await store.load({
          key: args.key,
          namespace: args.namespace,
        });

        const nsDisplay = entry.namespace ?? "default";
        return {
          ok: true,
          content: `Loaded "${args.key}" from namespace "${nsDisplay}".\n` +
            `Description: ${entry.description ?? "(none)"}\n` +
            `Updated: ${entry.updatedAt}\n` +
            `Value: ${JSON.stringify(entry.value, null, 2)}`,
        };
      } catch (err) {
        if (err instanceof StorageNotFoundError) {
          return errorResult("NOT_FOUND", err.message, false);
        }
        if (err instanceof ValidationError) {
          return errorResult("EXEC_ERROR", `[${err.code}] ${err.message}`, false);
        }
        return errorResult("EXEC_ERROR", err instanceof Error ? err.message : String(err), false);
      }
    },
  };
}

export function createDataListTool(store: UserDataStore): ToolDef<DataListArgs> {
  return {
    name: "data_list",
    description:
      "List all data entries in a namespace. Returns keys, descriptions, and timestamps. " +
      "If no namespace is specified, lists entries in the 'default' namespace.",
    parameters: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string" as const,
          description: "Namespace to list (default: 'default'). Pass '*' to list all namespaces.",
        },
      },
    },
    options: { idempotent: true, riskLevel: "low" },
    execute: async (args: DataListArgs, _ctx: ToolContext): Promise<ToolResult> => {
      try {
        if (args.namespace === "*") {
          const namespaces = await store.listNamespaces();
          if (namespaces.length === 0) {
            return { ok: true, content: "No data stored yet." };
          }

          const allEntries: UserDataEntry[] = [];
          for (const ns of namespaces) {
            const entries = await store.list({ namespace: ns });
            allEntries.push(...entries);
          }

          return {
            ok: true,
            content: `Found ${allEntries.length} entries across ${namespaces.length} namespaces:\n` +
              namespaces.map((ns) => `  [${ns}]`).join("\n"),
          };
        }

        const ns = args.namespace ?? "default";
        const entries = await store.list({ namespace: ns });

        if (entries.length === 0) {
          return {
            ok: true,
            content: `No entries found in namespace "${ns}".`,
          };
        }

        const formatted = entries
          .map((e, i) => {
            const desc = e.description ? ` — ${e.description}` : "";
            return `  ${i + 1}. "${e.key}"${desc} (updated: ${e.updatedAt})`;
          })
          .join("\n");

        return {
          ok: true,
          content: `Found ${entries.length} entries in namespace "${ns}":\n${formatted}`,
        };
      } catch (err) {
        return errorResult("EXEC_ERROR", err instanceof Error ? err.message : String(err), false);
      }
    },
  };
}

export function createDataDeleteTool(store: UserDataStore): ToolDef<DataDeleteArgs> {
  return {
    name: "data_delete",
    description:
      "Delete a data entry from persistent user storage by key and optional namespace.",
    parameters: {
      type: "object" as const,
      required: ["key"],
      properties: {
        key: {
          type: "string" as const,
          description: "The key of the data entry to delete",
        },
        namespace: {
          type: "string" as const,
          description: "Namespace to delete from (default: 'default')",
        },
      },
    },
    options: { idempotent: false, riskLevel: "low" },
    execute: async (args: DataDeleteArgs, _ctx: ToolContext): Promise<ToolResult> => {
      try {
        const ns = args.namespace ?? "default";
        const deleted = await store.delete({
          key: args.key,
          namespace: args.namespace,
        });

        if (!deleted) {
          return errorResult(
            "NOT_FOUND",
            `Entry "${args.key}" not found in namespace "${ns}".`,
            false
          );
        }

        return {
          ok: true,
          content: `Deleted "${args.key}" from namespace "${ns}".`,
        };
      } catch (err) {
        if (err instanceof ValidationError) {
          return errorResult("EXEC_ERROR", `[${err.code}] ${err.message}`, false);
        }
        return errorResult("EXEC_ERROR", err instanceof Error ? err.message : String(err), false);
      }
    },
  };
}

// ── Tool Factory ──────────────────────────────────────────────────────────────

export interface UserDataToolSet {
  dataSave: ToolDef<DataSaveArgs>;
  dataLoad: ToolDef<DataLoadArgs>;
  dataList: ToolDef<DataListArgs>;
  dataDelete: ToolDef<DataDeleteArgs>;
}

/** Create all four user data tools backed by a single UserDataStore. */
export function createUserDataTools(store: UserDataStore): UserDataToolSet {
  return {
    dataSave: createDataSaveTool(store),
    dataLoad: createDataLoadTool(store),
    dataList: createDataListTool(store),
    dataDelete: createDataDeleteTool(store),
  };
}

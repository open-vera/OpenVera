/**
 * Data Exporter — Export storage data to JSONL, CSV, and JSON formats.
 *
 * Supports exporting:
 * - Session data (all entries or filtered)
 * - Memory entries (by tier)
 * - User data (by namespace)
 * - Arbitrary query results
 */

import type { SqliteStorageProvider } from "./sqlite.js";
import type { StorageQuery, StorageValue } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type ExportFormat = "jsonl" | "csv" | "json";

export interface ExportOptions {
  /** Storage namespace to export */
  namespace: string;
  /** Output format */
  format: ExportFormat;
  /** Optional query filter */
  filter?: StorageQuery;
  /** Include metadata (createdAt, updatedAt, tags) */
  includeMetadata?: boolean;
  /** Custom field separator for CSV (default: ",") */
  csvSeparator?: string;
  /** Pretty-print JSON output */
  prettyPrint?: boolean;
}

export interface ExportResult {
  /** The exported data as a string */
  data: string;
  /** Number of entries exported */
  count: number;
  /** Format used */
  format: ExportFormat;
}

// ── DataExporter ─────────────────────────────────────────────────────────────

export class DataExporter {
  constructor(private readonly storage: SqliteStorageProvider) {}

  /**
   * Export data from a namespace in the specified format.
   */
  async exportData(options: ExportOptions): Promise<ExportResult> {
    const { namespace, format, filter, includeMetadata = true } = options;

    const query: StorageQuery = filter ?? {};
    const result = await this.storage.query(namespace, query);
    const entries = result.entries;

    let data: string;

    switch (format) {
      case "jsonl":
        data = this.toJsonl(entries, includeMetadata);
        break;
      case "csv":
        data = this.toCsv(entries, includeMetadata, options.csvSeparator ?? ",");
        break;
      case "json":
        data = this.toJson(entries, includeMetadata, options.prettyPrint ?? true);
        break;
      default:
        data = this.toJsonl(entries, includeMetadata);
    }

    return {
      data,
      count: entries.length,
      format,
    };
  }

  /**
   * Export sessions as JSONL (raw session content).
   */
  async exportSessions(options: {
    format: ExportFormat;
    sessionIds?: string[];
    prettyPrint?: boolean;
  }): Promise<ExportResult> {
    const { format, sessionIds, prettyPrint = true } = options;

    const keys = sessionIds ?? await this.storage.listKeys("sessions");
    const entries: Array<Record<string, unknown>> = [];

    for (const key of keys) {
      const raw = await this.storage.get("sessions", key);
      if (!raw) continue;
      const stored = raw as unknown as {
        sessionId: string;
        content: string;
        createdAt: string;
        updatedAt: string;
        metadata: Record<string, unknown>;
      };

      if (format === "jsonl") {
        // Return raw JSONL content
        entries.push({
          sessionId: stored.sessionId,
          content: stored.content,
          createdAt: stored.createdAt,
          updatedAt: stored.updatedAt,
          metadata: stored.metadata,
        });
      } else {
        // Parse JSONL entries for structured export
        const parsed = this.parseJsonlContent(stored.content);
        entries.push({
          sessionId: stored.sessionId,
          entries: parsed,
          createdAt: stored.createdAt,
          updatedAt: stored.updatedAt,
          metadata: stored.metadata,
        });
      }
    }

    let data: string;
    switch (format) {
      case "jsonl":
        data = entries.map((e) => JSON.stringify(e)).join("\n");
        break;
      case "csv":
        data = this.objectsToCsv(entries, ",");
        break;
      case "json":
        data = JSON.stringify(entries, null, prettyPrint ? 2 : undefined);
        break;
      default:
        data = JSON.stringify(entries, null, 2);
    }

    return { data, count: entries.length, format };
  }

  /**
   * Export memory entries by tier.
   */
  async exportMemory(options: {
    format: ExportFormat;
    tiers?: string[];
    prettyPrint?: boolean;
  }): Promise<ExportResult> {
    const { format, tiers, prettyPrint = true } = options;

    const keys = await this.storage.listKeys("memory");
    const entries: Array<Record<string, unknown>> = [];

    for (const key of keys) {
      const raw = await this.storage.get("memory", key);
      if (!raw) continue;
      const entry = raw as unknown as Record<string, unknown>;

      if (tiers && tiers.length > 0) {
        if (!tiers.includes(entry.tier as string)) continue;
      }

      entries.push(entry);
    }

    let data: string;
    switch (format) {
      case "jsonl":
        data = entries.map((e) => JSON.stringify(e)).join("\n");
        break;
      case "csv":
        data = this.objectsToCsv(entries, ",");
        break;
      case "json":
        data = JSON.stringify(entries, null, prettyPrint ? 2 : undefined);
        break;
      default:
        data = JSON.stringify(entries, null, 2);
    }

    return { data, count: entries.length, format };
  }

  /**
   * Export user data by namespace.
   */
  async exportUserData(options: {
    format: ExportFormat;
    namespace?: string;
    prettyPrint?: boolean;
  }): Promise<ExportResult> {
    const { format, namespace, prettyPrint = true } = options;

    const keys = await this.storage.listKeys("user-data");
    const entries: Array<Record<string, unknown>> = [];

    for (const key of keys) {
      const raw = await this.storage.get("user-data", key);
      if (!raw) continue;
      const entry = raw as unknown as Record<string, unknown>;

      if (namespace && entry.namespace !== namespace) continue;

      entries.push(entry);
    }

    let data: string;
    switch (format) {
      case "jsonl":
        data = entries.map((e) => JSON.stringify(e)).join("\n");
        break;
      case "csv":
        data = this.objectsToCsv(entries, ",");
        break;
      case "json":
        data = JSON.stringify(entries, null, prettyPrint ? 2 : undefined);
        break;
      default:
        data = JSON.stringify(entries, null, 2);
    }

    return { data, count: entries.length, format };
  }

  // ── Formatters ─────────────────────────────────────────────────────────────

  private toJsonl(
    entries: Array<{ key: string; entry: { value: StorageValue; createdAt: string; updatedAt: string; tags?: string[] } }>,
    includeMetadata: boolean,
  ): string {
    return entries
      .map(({ key, entry }) => {
        if (includeMetadata) {
          return JSON.stringify({
            key,
            value: entry.value,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            ...(entry.tags ? { tags: entry.tags } : {}),
          });
        }
        return JSON.stringify({ key, value: entry.value });
      })
      .join("\n");
  }

  private toCsv(
    entries: Array<{ key: string; entry: { value: StorageValue; createdAt: string; updatedAt: string; tags?: string[] } }>,
    includeMetadata: boolean,
    separator: string,
  ): string {
    if (entries.length === 0) return "";

    const headers = includeMetadata
      ? ["key", "value", "createdAt", "updatedAt", "tags"]
      : ["key", "value"];

    const rows = entries.map(({ key, entry }) => {
      const valueStr = typeof entry.value === "string"
        ? entry.value
        : JSON.stringify(entry.value);

      if (includeMetadata) {
        return [
          this.escapeCsvField(key, separator),
          this.escapeCsvField(valueStr, separator),
          this.escapeCsvField(entry.createdAt, separator),
          this.escapeCsvField(entry.updatedAt, separator),
          this.escapeCsvField(entry.tags?.join(";") ?? "", separator),
        ].join(separator);
      }
      return [
        this.escapeCsvField(key, separator),
        this.escapeCsvField(valueStr, separator),
      ].join(separator);
    });

    return [headers.join(separator), ...rows].join("\n");
  }

  private toJson(
    entries: Array<{ key: string; entry: { value: StorageValue; createdAt: string; updatedAt: string; tags?: string[] } }>,
    includeMetadata: boolean,
    prettyPrint: boolean,
  ): string {
    const data = entries.map(({ key, entry }) => {
      if (includeMetadata) {
        return {
          key,
          value: entry.value,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          ...(entry.tags ? { tags: entry.tags } : {}),
        };
      }
      return { key, value: entry.value };
    });

    return JSON.stringify(data, null, prettyPrint ? 2 : undefined);
  }

  private objectsToCsv(objects: Array<Record<string, unknown>>, separator: string): string {
    if (objects.length === 0) return "";

    const keySet = new Set<string>();
    for (const obj of objects) {
      for (const key of Object.keys(obj)) {
        keySet.add(key);
      }
    }
    const headers = [...keySet];

    const rows = objects.map((obj) =>
      headers
        .map((h) => {
          const val = obj[h];
          const str = val === undefined || val === null
            ? ""
            : typeof val === "string"
              ? val
              : JSON.stringify(val);
          return this.escapeCsvField(str, separator);
        })
        .join(separator),
    );

    return [headers.join(separator), ...rows].join("\n");
  }

  private escapeCsvField(field: string, separator: string): string {
    if (field.includes(separator) || field.includes('"') || field.includes("\n")) {
      return `"${field.replace(/"/g, '""')}"`;
    }
    return field;
  }

  private parseJsonlContent(content: string): Array<Record<string, unknown>> {
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null);
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createDataExporter(storage: SqliteStorageProvider): DataExporter {
  return new DataExporter(storage);
}

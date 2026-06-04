import type { StorageEntry, StorageQuery } from "./types.js";

export function entryMatchesStorageQuery(
  key: string,
  entry: StorageEntry,
  filter: StorageQuery,
  isExpired: (entry: StorageEntry) => boolean,
  matchGlob: (value: string, pattern: string) => boolean
): boolean {
  if (!filter.includeExpired && isExpired(entry)) return false;
  if (filter.keyPrefix && !key.startsWith(filter.keyPrefix)) return false;
  if (filter.keyPattern && !matchGlob(key, filter.keyPattern)) return false;

  if (filter.tags?.length) {
    const entryTags = entry.tags ?? [];
    if (!filter.tags.every((t) => entryTags.includes(t))) return false;
  }

  if (filter.hasTtl !== undefined) {
    const hasTtl = Boolean(entry.ttl && entry.ttl > 0);
    if (filter.hasTtl !== hasTtl) return false;
  }

  if (filter.createdAfter && entry.createdAt <= filter.createdAfter) return false;
  if (filter.createdBefore && entry.createdAt >= filter.createdBefore) return false;
  if (filter.updatedAfter && entry.updatedAt <= filter.updatedAfter) return false;
  if (filter.updatedBefore && entry.updatedAt >= filter.updatedBefore) return false;

  if (filter.fullTextSearch) {
    const needle = filter.fullTextSearch.toLowerCase();
    const haystack = JSON.stringify(entry.value).toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  return true;
}

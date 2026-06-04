import { describe, expect, it } from "vitest";
import { entryMatchesStorageQuery } from "../entry-filter.js";
import type { StorageEntry } from "../types.js";

function entry(overrides: Partial<StorageEntry> = {}): StorageEntry {
  return {
    value: { note: "hello" },
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("entryMatchesStorageQuery", () => {
  it("matches prefix, tags, and full-text search", () => {
    const matches = entryMatchesStorageQuery(
      "docs/readme",
      entry({ tags: ["docs"], value: { note: "hello world" } }),
      { keyPrefix: "docs/", tags: ["docs"], fullTextSearch: "world" },
      () => false,
      () => true
    );
    expect(matches).toBe(true);
  });

  it("rejects expired entries when includeExpired is false", () => {
    const matches = entryMatchesStorageQuery(
      "k1",
      entry({ ttl: 1, createdAt: "2020-01-01T00:00:00.000Z" }),
      {},
      () => true,
      () => true
    );
    expect(matches).toBe(false);
  });

  it("applies glob patterns via matcher", () => {
    const matches = entryMatchesStorageQuery(
      "cache/tmp-1",
      entry(),
      { keyPattern: "cache/*" },
      () => false,
      (value, pattern) => pattern === "cache/*" && value.startsWith("cache/")
    );
    expect(matches).toBe(true);
  });
});

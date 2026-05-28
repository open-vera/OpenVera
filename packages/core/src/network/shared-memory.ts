/**
 * Shared Memory — Multi-agent shared semantic memory layer.
 *
 * Provides a shared key-value store that agents can read/write
 * to coordinate and share knowledge.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  key: string;
  value: unknown;
  owner: string;
  visibility: "private" | "shared" | "public";
  createdAt: string;
  updatedAt: string;
  ttl?: number; // Time to live in ms
  tags: string[];
}

export interface MemoryQuery {
  key?: string;
  keyPattern?: string;
  owner?: string;
  visibility?: MemoryEntry["visibility"];
  tags?: string[];
  since?: string;
}

// ── Shared Memory ────────────────────────────────────────────────────────────

export class SharedMemory {
  private store = new Map<string, MemoryEntry>();

  /**
   * Write a value to shared memory.
   */
  set(
    key: string,
    value: unknown,
    owner: string,
    options?: {
      visibility?: MemoryEntry["visibility"];
      ttl?: number;
      tags?: string[];
    },
  ): void {
    const now = new Date().toISOString();
    const existing = this.store.get(key);

    this.store.set(key, {
      key,
      value,
      owner,
      visibility: options?.visibility ?? "shared",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ttl: options?.ttl,
      tags: options?.tags ?? [],
    });
  }

  /**
   * Read a value from shared memory.
   */
  get(key: string, requester: string): MemoryEntry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    // Check visibility
    if (entry.visibility === "private" && entry.owner !== requester) {
      return undefined;
    }

    // Check TTL
    if (entry.ttl) {
      const age = Date.now() - new Date(entry.updatedAt).getTime();
      if (age > entry.ttl) {
        this.store.delete(key);
        return undefined;
      }
    }

    return entry;
  }

  /**
   * Delete a value from shared memory.
   */
  delete(key: string, requester: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;

    // Only owner can delete
    if (entry.owner !== requester) return false;

    this.store.delete(key);
    return true;
  }

  /**
   * Query shared memory.
   */
  query(query: MemoryQuery, requester: string): MemoryEntry[] {
    let results: MemoryEntry[] = [];

    for (const entry of this.store.values()) {
      // Check visibility
      if (entry.visibility === "private" && entry.owner !== requester) {
        continue;
      }

      // Check TTL
      if (entry.ttl) {
        const age = Date.now() - new Date(entry.updatedAt).getTime();
        if (age > entry.ttl) continue;
      }

      // Apply filters
      if (query.key && entry.key !== query.key) continue;
      if (query.keyPattern && !entry.key.includes(query.keyPattern)) continue;
      if (query.owner && entry.owner !== query.owner) continue;
      if (query.visibility && entry.visibility !== query.visibility) continue;
      if (query.tags && !query.tags.every((t) => entry.tags.includes(t))) continue;
      if (query.since && entry.updatedAt < query.since) continue;

      results.push(entry);
    }

    return results;
  }

  /**
   * Get all keys.
   */
  keys(): string[] {
    return [...this.store.keys()];
  }

  /**
   * Get memory size.
   */
  size(): number {
    return this.store.size;
  }

  /**
   * Clear expired entries.
   */
  cleanup(): number {
    let cleaned = 0;
    const now = Date.now();

    for (const [key, entry] of this.store) {
      if (entry.ttl) {
        const age = now - new Date(entry.updatedAt).getTime();
        if (age > entry.ttl) {
          this.store.delete(key);
          cleaned++;
        }
      }
    }

    return cleaned;
  }
}

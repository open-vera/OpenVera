/**
 * SharedContext — key-value store for sharing data between subagents.
 *
 * Provides a simple, typed mechanism for orchestrator tasks to read/write
 * shared state during execution.  Each key maps to an arbitrary value;
 * callers use generic get<T>() for type-safe retrieval.
 */

export class SharedContext {
  private readonly store = new Map<string, unknown>();

  /** Set a shared value. Overwrites any existing value for the key. */
  set(key: string, value: unknown): void {
    this.store.set(key, value);
  }

  /** Get a shared value, optionally typed. Returns undefined if missing. */
  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  /** Check whether a key exists in the context. */
  has(key: string): boolean {
    return this.store.has(key);
  }

  /** Delete a key. Returns true if the key existed, false otherwise. */
  delete(key: string): boolean {
    return this.store.delete(key);
  }

  /** List all keys currently in the context. */
  keys(): string[] {
    return [...this.store.keys()];
  }

  /** Return a shallow snapshot of all key-value pairs. */
  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.store);
  }

  /** Bulk-merge entries from a plain object into the context. */
  merge(data: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(data)) {
      this.store.set(key, value);
    }
  }
}

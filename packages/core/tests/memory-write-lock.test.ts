/**
 * Tests for review findings — Bug #5: MemoryStore concurrent write race.
 *
 * Bug: persistEntry() (append to episodic.jsonl) and persistAll() (full rewrite
 * of both episodic.jsonl + semantic.jsonl) could race when called concurrently.
 *
 * Fix: a writeLock Promise chains all writes, ensuring only one is in-flight
 * at a time. persistEntry() and persistAll() both await the lock.
 * flush() exposes the lock so tests can await it before assertions.
 */
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory/store.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `memory-writelock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("MemoryStore — writeLock for concurrent writes", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("should serialize concurrent persistEntry and persistAll calls", async () => {
    const store = new MemoryStore({ storeDir: dir });

    // addSemantic calls persistAll() (full rewrite)
    // addEpisodic calls persistEntry() (append)
    // Fire many concurrent calls — with writeLock they serialize without data loss
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      writes.push(
        Promise.resolve().then(() =>
          store.addSemantic(`sem-key-${i}`, `sem-value-${i}`, ["sem"])
        )
      );
      writes.push(
        Promise.resolve().then(() =>
          store.addEpisodic(`epi-task-${i}`, `epi-outcome-${i}`, [], ["epi"])
        )
      );
    }
    await Promise.all(writes);

    // Flush all pending writes before assertions
    await store.flush();

    expect(store.getSemantic()).toHaveLength(20);
    expect(store.getEpisodic()).toHaveLength(20);

    // Verify reload from disk
    const store2 = new MemoryStore({ storeDir: dir });
    expect(store2.getSemantic()).toHaveLength(20);
    expect(store2.getEpisodic()).toHaveLength(20);
  });

  it("should not corrupt semantic.jsonl when concurrent removeSemantic triggers persistAll", async () => {
    const store = new MemoryStore({ storeDir: dir });

    for (let i = 0; i < 10; i++) {
      store.addSemantic(`key-${i}`, `value-${i}`, ["tag"]);
    }
    await store.flush();

    // Concurrently update and remove
    const ops: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      ops.push(
        Promise.resolve().then(() => store.addSemantic(`key-${i}`, `updated-${i}`, ["tag"]))
      );
      ops.push(
        Promise.resolve().then(() => store.removeSemantic(`key-${i}`))
      );
    }
    await Promise.all(ops);
    await store.flush();

    // File should be valid JSONL, not truncated/corrupt
    const semanticFile = join(dir, "semantic.jsonl");
    const raw = readFileSync(semanticFile, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    expect(store.getSemantic().length).toBeLessThanOrEqual(5);
  });

  it("should handle rapid-fire alternating addSemantic + addEpisodic without loss", async () => {
    const store = new MemoryStore({ storeDir: dir });

    const ops: Promise<void>[] = [];
    for (let i = 0; i < 30; i++) {
      ops.push(Promise.resolve().then(() => store.addSemantic(`k${i}`, `v${i}`)));
      ops.push(Promise.resolve().then(() => store.addEpisodic(`t${i}`, `o${i}`, [])));
    }
    await Promise.all(ops);
    await store.flush();

    const reloaded = new MemoryStore({ storeDir: dir });
    expect(reloaded.getSemantic()).toHaveLength(30);
    expect(reloaded.getEpisodic()).toHaveLength(30);
  });

  it("should complete all writes before flush() resolves", async () => {
    const store = new MemoryStore({ storeDir: dir });

    store.addSemantic("key-a", "value-a");
    store.addSemantic("key-b", "value-b");
    store.addEpisodic("task-b", "outcome-b", []);

    await store.flush();

    // After flush, data must be on disk
    const semanticFile = join(dir, "semantic.jsonl");
    const content = readFileSync(semanticFile, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});

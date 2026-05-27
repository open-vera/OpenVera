import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory/store.js";
import type {
  DecayConfig,
  MemoryCompressionResult,
  MemoryOrganizeResult,
} from "../src/memory/store.js";
import { MemoryGraph } from "../src/memory/graph.js";
import type { MemoryEntry } from "../src/memory/store.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `memory-enhance-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeEntry(overrides: Partial<MemoryEntry> & { content: string }): MemoryEntry {
  return {
    id: overrides.id ?? `mem-${Math.random().toString(36).slice(2, 8)}`,
    tier: overrides.tier ?? "semantic",
    content: overrides.content,
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    source: overrides.source,
    importance: overrides.importance ?? 0.5,
    accessCount: overrides.accessCount,
    lastAccessedAt: overrides.lastAccessedAt,
  };
}

// ─── M1: Auto-Extract ────────────────────────────────────────────────────────

describe("M1: Auto-Extract", () => {
  it("extracts high-value content as semantic memory", () => {
    const store = new MemoryStore();
    const entry = store.autoExtract(
      "Discovered a critical bug in the checkpoint system: JSONL files were not flushed before rename, causing data loss on crash.",
      { source: "debug-session", tags: ["bug"] },
    );

    expect(entry).not.toBeNull();
    expect(entry!.tier).toBe("semantic");
    expect(entry!.tags).toContain("auto-extracted");
    expect(entry!.tags).toContain("bug");
    expect(entry!.source).toBe("debug-session");
    expect(entry!.importance).toBeGreaterThan(0.3);
  });

  it("rejects low-value content below threshold", () => {
    const store = new MemoryStore();
    const entry = store.autoExtract("hello world", { threshold: 0.5 });
    expect(entry).toBeNull();
  });

  it("respects custom threshold", () => {
    const store = new MemoryStore();
    // Low-value content should pass a very low threshold
    const entry = store.autoExtract("hello world", { threshold: 0.01 });
    expect(entry).not.toBeNull();
  });

  it("auto-extract batch processes multiple contents", () => {
    const store = new MemoryStore();
    const results = store.autoExtractBatch(
      [
        "The solution to the memory leak was found in the event listener cleanup",
        "hello",
        "Important: learned that async/await in TypeScript strict mode requires explicit error handling",
      ],
      { source: "batch" },
    );

    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const entry of results) {
      expect(entry.tags).toContain("auto-extracted");
    }
  });

  it("extracts a concise key from long content", () => {
    const store = new MemoryStore();
    const longContent = "Discovered a critical bug in the checkpoint system where JSONL files were not being flushed before rename, causing data loss on crash. The fix involves calling fsync before rename.";
    const entry = store.autoExtract(longContent);

    expect(entry).not.toBeNull();
    expect(entry!.key.length).toBeLessThanOrEqual(80);
  });
});

// ─── M2: Auto-Organize ───────────────────────────────────────────────────────

describe("M2: Auto-Organize", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("merges duplicate semantic entries", () => {
    const store = new MemoryStore({ storeDir: dir });
    store.addSemantic("TypeScript strict mode", "TS strict mode requires explicit types", ["ts"]);
    store.addSemantic("TS strict mode", "TypeScript strict mode requires explicit type annotations", ["typescript"]);

    const result = store.autoOrganize({ similarityThreshold: 0.5 });
    expect(result.duplicatesMerged).toBeGreaterThanOrEqual(1);
    expect(store.getSemantic().length).toBeLessThan(2);
  });

  it("removes expired entries when TTL is set", () => {
    const store = new MemoryStore({ storeDir: dir });

    // Add an entry with a very old timestamp
    const oldDate = new Date(Date.now() - 60 * 86400000).toISOString(); // 60 days ago
    store.addSemantic("old-fact", "This is old", ["old"]);
    // Manually backdate it
    const semantic = store.getSemantic();
    semantic[0]!.createdAt = oldDate;
    semantic[0]!.updatedAt = oldDate;

    const result = store.autoOrganize({ ttlDays: 30 });
    expect(result.expiredRemoved).toBe(1);
    expect(store.getSemantic()).toHaveLength(0);
  });

  it("does not remove fresh entries", () => {
    const store = new MemoryStore({ storeDir: dir });
    store.addSemantic("fresh-fact", "This is new", ["new"]);

    const result = store.autoOrganize({ ttlDays: 30 });
    expect(result.expiredRemoved).toBe(0);
    expect(store.getSemantic()).toHaveLength(1);
  });

  it("returns empty result when nothing to organize", () => {
    const store = new MemoryStore({ storeDir: dir });
    store.addSemantic("unique-1", "First unique entry", ["a"]);
    store.addSemantic("unique-2", "Completely different content about quantum physics", ["b"]);

    const result = store.autoOrganize({ similarityThreshold: 0.9 });
    expect(result.duplicatesMerged).toBe(0);
    expect(result.expiredRemoved).toBe(0);
  });

  it("merges duplicate episodic entries by task summary", () => {
    const store = new MemoryStore({ storeDir: dir });
    store.addEpisodic("Implemented checkpoint system", "Success", ["Use JSONL"]);
    store.addEpisodic("Implemented the checkpoint system", "Done", ["JSONL is crash-safe"]);

    const result = store.autoOrganize({ similarityThreshold: 0.5 });
    expect(result.duplicatesMerged).toBeGreaterThanOrEqual(1);
  });
});

// ─── M3: Memory Compression ──────────────────────────────────────────────────

describe("M3: Memory Compression", () => {
  it("compresses a cluster of tag-related entries into a summary", () => {
    const store = new MemoryStore();
    // Create entries with shared tags to form a cluster
    store.addSemantic("ts-1", "TypeScript strict mode catches null errors", ["typescript", "config"]);
    store.addSemantic("ts-2", "TypeScript interfaces define object shapes", ["typescript", "types"]);
    store.addSemantic("ts-3", "TypeScript generics enable reusable components", ["typescript", "advanced"]);
    store.addSemantic("ts-4", "TypeScript enums define named constants", ["typescript", "basics"]);

    const result = store.compressMemories({ minClusterSize: 3 });
    expect(result.clustersCompressed).toBeGreaterThanOrEqual(1);
    expect(result.summaries.length).toBeGreaterThanOrEqual(1);
    expect(result.after).toBeLessThan(result.before);
    // Summary should have "compressed" tag
    expect(result.summaries[0]!.tags).toContain("compressed");
  });

  it("does not compress when entries are below minClusterSize", () => {
    const store = new MemoryStore();
    store.addSemantic("a", "Entry A about dogs", ["pets"]);
    store.addSemantic("b", "Entry B about cats", ["pets"]);

    const result = store.compressMemories({ minClusterSize: 3 });
    expect(result.clustersCompressed).toBe(0);
    expect(result.before).toBe(result.after);
  });

  it("respects maxClusters limit", () => {
    const store = new MemoryStore();
    // Create two separate clusters
    for (let i = 0; i < 4; i++) {
      store.addSemantic(`cluster-a-${i}`, `Alpha entry ${i} about TypeScript`, ["alpha", "ts"]);
    }
    for (let i = 0; i < 4; i++) {
      store.addSemantic(`cluster-b-${i}`, `Beta entry ${i} about Python`, ["beta", "python"]);
    }

    const result = store.compressMemories({ minClusterSize: 3, maxClusters: 1 });
    expect(result.clustersCompressed).toBe(1);
  });
});

// ─── M4: Memory Decay ────────────────────────────────────────────────────────

describe("M4: Memory Decay", () => {
  it("decays importance of old entries", () => {
    const store = new MemoryStore();
    const oldDate = new Date(Date.now() - 60 * 86400000).toISOString(); // 60 days ago
    store.addSemantic("old-fact", "An old fact", ["old"]);
    const semantic = store.getSemantic();
    semantic[0]!.createdAt = oldDate;
    semantic[0]!.updatedAt = oldDate;
    const originalImportance = semantic[0]!.importance;

    const updated = store.decayImportance({
      halfLifeDays: 30,
      minImportance: 0.05,
      minAgeDays: 1,
    });

    expect(updated).toBeGreaterThan(0);
    expect(semantic[0]!.importance).toBeLessThan(originalImportance);
    expect(semantic[0]!.importance).toBeGreaterThanOrEqual(0.05);
  });

  it("does not decay fresh entries", () => {
    const store = new MemoryStore();
    store.addSemantic("fresh", "Brand new fact", ["new"]);
    const originalImportance = store.getSemantic()[0]!.importance;

    store.decayImportance({ halfLifeDays: 30, minImportance: 0.05, minAgeDays: 7 });
    expect(store.getSemantic()[0]!.importance).toBe(originalImportance);
  });

  it("respects minImportance floor", () => {
    const store = new MemoryStore();
    // Very old entry with low importance
    const veryOld = new Date(Date.now() - 365 * 86400000).toISOString(); // 1 year ago
    store.addSemantic("ancient", "Ancient fact", ["old"]);
    const semantic = store.getSemantic();
    semantic[0]!.createdAt = veryOld;
    semantic[0]!.updatedAt = veryOld;
    semantic[0]!.importance = 0.1;

    store.decayImportance({
      halfLifeDays: 7,
      minImportance: 0.05,
      minAgeDays: 1,
    });

    expect(semantic[0]!.importance).toBeGreaterThanOrEqual(0.05);
  });

  it("access refresh slows decay", () => {
    const store = new MemoryStore();
    const oldDate = new Date(Date.now() - 60 * 86400000).toISOString();
    const recentAccess = new Date(Date.now() - 5 * 86400000).toISOString(); // 5 days ago

    store.addSemantic("accessed", "Recently accessed old fact", ["accessed"]);
    const entry = store.getSemantic()[0]!;
    entry.createdAt = oldDate;
    entry.updatedAt = oldDate;
    entry.accessCount = 10;
    entry.lastAccessedAt = recentAccess;

    store.addSemantic("unaccessed", "Never accessed old fact", ["unaccessed"]);
    const entry2 = store.getSemantic()[1]!;
    entry2.createdAt = oldDate;
    entry2.updatedAt = oldDate;

    store.decayImportance({ halfLifeDays: 30, minImportance: 0.05, minAgeDays: 1 });

    // Accessed entry should have higher importance than unaccessed
    expect(entry.importance).toBeGreaterThan(entry2.importance);
  });

  it("recordAccess updates accessCount and lastAccessedAt", () => {
    const store = new MemoryStore();
    store.addSemantic("tracked", "Tracked entry", ["tracking"]);
    const entry = store.getSemantic()[0]!;
    expect(entry.accessCount).toBeUndefined();

    store.recordAccess(entry.id);
    expect(entry.accessCount).toBe(1);
    expect(entry.lastAccessedAt).toBeDefined();

    store.recordAccess(entry.id);
    expect(entry.accessCount).toBe(2);
  });

  it("getDecayedEntries returns entries below threshold", () => {
    const store = new MemoryStore();
    store.addSemantic("high", "High importance", ["high"]);
    store.getSemantic()[0]!.importance = 0.8;

    store.addSemantic("low", "Low importance", ["low"]);
    store.getSemantic()[1]!.importance = 0.05;

    const decayed = store.getDecayedEntries(0.1);
    expect(decayed).toHaveLength(1);
    expect(decayed[0]!.id).toBe(store.getSemantic()[1]!.id);
  });
});

// ─── M5: Memory Graph ────────────────────────────────────────────────────────

describe("M5: Memory Graph", () => {
  it("builds relations from shared keywords", () => {
    const graph = new MemoryGraph({ minKeywordOverlap: 1 });
    const entries: MemoryEntry[] = [
      makeEntry({ id: "a", content: "TypeScript strict mode configuration", tags: ["ts"] }),
      makeEntry({ id: "b", content: "TypeScript generics and advanced types", tags: ["ts"] }),
      makeEntry({ id: "c", content: "Python machine learning basics", tags: ["python"] }),
    ];

    graph.build(entries);
    const stats = graph.stats();
    expect(stats.nodes).toBe(3);
    expect(stats.edges).toBeGreaterThan(0);

    // a and b should be related (shared "typescript" keyword)
    const related = graph.findRelated("a", { maxResults: 5 });
    const relatedIds = related.map((r) => r.entry.id);
    expect(relatedIds).toContain("b");
  });

  it("finds related entries via BFS traversal", () => {
    const graph = new MemoryGraph({ minKeywordOverlap: 1 });
    const entries: MemoryEntry[] = [
      makeEntry({ id: "a", content: "JavaScript async await patterns", tags: ["js"] }),
      makeEntry({ id: "b", content: "JavaScript Promise handling", tags: ["js"] }),
      makeEntry({ id: "c", content: "JavaScript async callback patterns", tags: ["js"] }),
    ];

    graph.build(entries);
    const related = graph.findRelated("a", { maxResults: 10, maxDistance: 2 });
    expect(related.length).toBeGreaterThanOrEqual(1);
    // All related entries should have distance >= 1
    for (const r of related) {
      expect(r.distance).toBeGreaterThanOrEqual(1);
    }
  });

  it("finds shortest path between two entries", () => {
    const graph = new MemoryGraph({ minKeywordOverlap: 1 });
    const entries: MemoryEntry[] = [
      makeEntry({ id: "a", content: "Node.js server setup Express", tags: ["node"] }),
      makeEntry({ id: "b", content: "Node.js middleware Express routes", tags: ["node"] }),
      makeEntry({ id: "c", content: "React frontend components", tags: ["react"] }),
    ];

    graph.build(entries);
    const path = graph.findPath("a", "b");
    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(path[0]).toBe("a");
    expect(path[path.length - 1]).toBe("b");
  });

  it("returns empty path for disconnected entries", () => {
    const graph = new MemoryGraph({
      minKeywordOverlap: 5,
      minTagOverlap: 5,
      coOccurrenceWeight: 0,
    });
    const entries: MemoryEntry[] = [
      makeEntry({ id: "a", content: "cats", tags: ["pets"] }),
      makeEntry({ id: "b", content: "dogs", tags: ["animals"] }),
    ];

    graph.build(entries);
    const path = graph.findPath("a", "b");
    expect(path).toHaveLength(0);
  });

  it("builds relations from shared tags", () => {
    const graph = new MemoryGraph({ minKeywordOverlap: 10, minTagOverlap: 1 }); // High keyword threshold, low tag
    const entries: MemoryEntry[] = [
      makeEntry({ id: "a", content: "xyz", tags: ["shared-tag", "alpha"] }),
      makeEntry({ id: "b", content: "abc", tags: ["shared-tag", "beta"] }),
    ];

    graph.build(entries);
    const stats = graph.stats();
    expect(stats.edges).toBe(1);
  });

  it("handles empty entries gracefully", () => {
    const graph = new MemoryGraph();
    graph.build([]);
    expect(graph.stats().nodes).toBe(0);
    expect(graph.findRelated("nonexistent")).toHaveLength(0);
    expect(graph.findPath("a", "b")).toHaveLength(0);
  });

  it("returns correct graph stats", () => {
    const graph = new MemoryGraph({ minKeywordOverlap: 1 });
    const entries: MemoryEntry[] = [
      makeEntry({ id: "a", content: "database optimization queries SQL", tags: ["db"] }),
      makeEntry({ id: "b", content: "database indexing performance SQL", tags: ["db"] }),
      makeEntry({ id: "c", content: "database caching layer Redis", tags: ["db"] }),
    ];

    graph.build(entries);
    const stats = graph.stats();
    expect(stats.nodes).toBe(3);
    expect(stats.edges).toBeGreaterThan(0);
    expect(stats.avgDegree).toBeGreaterThan(0);
  });

  it("getNode returns the correct graph node", () => {
    const graph = new MemoryGraph();
    const entries: MemoryEntry[] = [
      makeEntry({ id: "a", content: "Test entry content", tags: ["test"] }),
    ];

    graph.build(entries);
    const node = graph.getNode("a");
    expect(node).toBeDefined();
    expect(node!.entryId).toBe("a");
    expect(node!.keywords).toContain("test");
    expect(node!.keywords).toContain("entry");
  });

  it("co-occurrence creates relations for entries created close in time", () => {
    const graph = new MemoryGraph({
      minKeywordOverlap: 100, // No keyword overlap
      minTagOverlap: 100,     // No tag overlap
      coOccurrenceWeight: 1.0,
      coOccurrenceWindowMs: 60000, // 1 minute
    });

    const now = new Date();
    const entries: MemoryEntry[] = [
      makeEntry({ id: "a", content: "aaa", tags: ["x"], createdAt: now.toISOString() }),
      makeEntry({ id: "b", content: "bbb", tags: ["y"], createdAt: new Date(now.getTime() + 30000).toISOString() }),
    ];

    graph.build(entries);
    const stats = graph.stats();
    expect(stats.edges).toBe(1);
  });
});

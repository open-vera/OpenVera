import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory/store.js";

/**
 * Performance and correctness tests for memory_search with the inverted index.
 *
 * These tests verify that:
 * 1. Search remains correct at scale (1000+ entries)
 * 2. Performance is consistently sub-millisecond for small queries
 * 3. Mixed add/remove operations don't break search
 * 4. The inverted index (added as B1 improvement) correctly replaces O(n) scan
 */

describe("MemorySearch performance and correctness", () => {
  it("search returns correct results at 2000 entries", () => {
    const store = new MemoryStore();

    // Add entries with "falcon" in their content, and others without
    for (let i = 0; i < 200; i++) {
      store.addSemantic(`falcon${i}`, `falcon bird${i} soar${i} wings${i}`, ["bird"]);
    }
    for (let i = 0; i < 1800; i++) {
      store.addSemantic(`other${i}`, `ocean${i} wave${i} tide${i}`, ["water"]);
    }

    const results = store.search("falcon", { limit: 250 });
    expect(results.length).toBe(200);

    for (const r of results) {
      expect(r.entry.content).toContain("falcon");
    }
  });

  it("search is fast: 100 queries on 2000 entries complete under 100ms total", () => {
    const store = new MemoryStore();

    for (let i = 0; i < 2000; i++) {
      store.addSemantic(
        `fact${i}`,
        `alpha${i} beta${i} gamma${i}`,
        [`tag${i % 20}`, "bulk"],
      );
    }

    const queries = [
      "alpha42 beta42",
      "gamma999",
      "alpha1000 beta1000 gamma1000",
      "alpha500",
      "beta777 gamma777",
      "alpha0 beta0 gamma0",
      "alpha1999",
      "gamma1",
      "alpha1500 beta1500",
      "beta999",
    ];

    const start = performance.now();
    for (let round = 0; round < 10; round++) {
      for (const q of queries) {
        store.search(q);
      }
    }
    const elapsed = performance.now() - start;
    const totalQueries = queries.length * 10;

    // Should be well under 100ms total for 100 queries
    expect(elapsed).toBeLessThan(100);
    const avgMs = elapsed / totalQueries;
    expect(avgMs).toBeLessThan(2);
  });

  it("search handles removed entries correctly at scale", () => {
    const store = new MemoryStore();

    for (let i = 0; i < 500; i++) {
      store.addSemantic(`key${i}`, `unique${i} marker${i} sharedtoken`, ["test"]);
    }

    // Verify a specific entry exists
    expect(store.search("unique0").length).toBe(1);

    // Remove the first 250 entries
    for (let i = 0; i < 250; i++) {
      store.removeSemantic(`key${i}`);
    }

    // Old entries should be gone
    expect(store.search("unique0").length).toBe(0);
    expect(store.search("unique100").length).toBe(0);

    // New entries should still be found
    expect(store.search("unique250").length).toBe(1);
    expect(store.search("unique499").length).toBe(1);

    // Shared token still matches remaining entries (need high limit)
    const commonResults = store.search("sharedtoken", { limit: 300 });
    expect(commonResults.length).toBe(250);
  });

  it("search across tiers correctly filters results", () => {
    const store = new MemoryStore();

    // Use 51 iterations so index 50 exists (whale50 / dolphin50)
    for (let i = 0; i <= 50; i++) {
      store.addSemantic(`sem${i}`, `semantic entry about dolphin${i}`, []);
      store.addEpisodic(`ep${i} task`, `outcome about whale${i}`, [`lesson about eagle${i}`], []);
      store.addWorking(`working note about dolphin${i}`, []);
    }

    // "dolphin0" appears in semantic[0] and working[0]
    const allResults = store.search("dolphin0", { limit: 51 });
    const tiers = new Set(allResults.map((r) => r.entry.tier));
    expect(tiers.has("semantic")).toBe(true);
    expect(tiers.has("working")).toBe(true);

    // Filter to semantic only
    const semanticOnly = store.search("dolphin0", { tiers: ["semantic"], limit: 51 });
    expect(semanticOnly.length).toBe(1);
    expect(semanticOnly[0]!.entry.tier).toBe("semantic");

    // Filter to episodic — "whale50" is in episodic entries
    const episodicOnly = store.search("whale50", { tiers: ["episodic"], limit: 51 });
    expect(episodicOnly.length).toBe(1);
    expect(episodicOnly[0]!.entry.tier).toBe("episodic");
  });

  it("empty and nonsense queries return empty quickly", () => {
    const store = new MemoryStore();

    for (let i = 0; i < 2000; i++) {
      store.addSemantic(`x${i}`, `content${i}`, []);
    }

    expect(store.search("")).toHaveLength(0);
    expect(store.search("   ")).toHaveLength(0);
    expect(store.search("zzzznonexistentzzzz")).toHaveLength(0);
  });
});

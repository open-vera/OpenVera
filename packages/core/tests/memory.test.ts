import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory/store.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("MemoryStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ─── Working Memory ────────────────────────────────────────────────────

  describe("Working Memory", () => {
    it("adds and retrieves working memory entries", () => {
      const store = new MemoryStore();
      store.addWorking("Remember this fact", ["important"], "session-1", 0.9);

      const working = store.getWorking();
      expect(working).toHaveLength(1);
      expect(working[0]!.content).toBe("Remember this fact");
      expect(working[0]!.tags).toEqual(["important"]);
      expect(working[0]!.tier).toBe("working");
    });

    it("clears working memory", () => {
      const store = new MemoryStore();
      store.addWorking("a");
      store.addWorking("b");
      expect(store.getWorking()).toHaveLength(2);

      store.clearWorking();
      expect(store.getWorking()).toHaveLength(0);
    });

    it("evicts least important when exceeding maxWorkingEntries", () => {
      const store = new MemoryStore({ maxWorkingEntries: 3 });
      store.addWorking("low", [], undefined, 0.1);
      store.addWorking("medium", [], undefined, 0.5);
      store.addWorking("high", [], undefined, 0.9);
      store.addWorking("critical", [], undefined, 1.0); // triggers eviction

      const entries = store.getWorking();
      expect(entries).toHaveLength(3);
      // "low" should be evicted (lowest importance)
      const contents = entries.map((e) => e.content);
      expect(contents).not.toContain("low");
      expect(contents).toContain("high");
      expect(contents).toContain("critical");
    });

    it("is volatile — not persisted to disk", () => {
      const store1 = new MemoryStore({ storeDir: dir });
      store1.addWorking("volatile data");

      // Create a new store from same dir — working memory should be empty
      const store2 = new MemoryStore({ storeDir: dir });
      expect(store2.getWorking()).toHaveLength(0);
    });
  });

  // ─── Episodic Memory ──────────────────────────────────────────────────

  describe("Episodic Memory", () => {
    it("adds episodic entries with task summary, outcome, lessons", () => {
      const store = new MemoryStore({ storeDir: dir });
      const entry = store.addEpisodic(
        "Implemented checkpoint system",
        "Success — all tests pass",
        ["Use JSONL for crash safety", "Always skip corrupt lines"],
        ["checkpoint", "storage"],
        "task-42",
        0.8
      );

      expect(entry.tier).toBe("episodic");
      expect(entry.taskSummary).toBe("Implemented checkpoint system");
      expect(entry.outcome).toBe("Success — all tests pass");
      expect(entry.lessons).toEqual(["Use JSONL for crash safety", "Always skip corrupt lines"]);
      expect(entry.tags).toEqual(["checkpoint", "storage"]);
    });

    it("persists episodic entries to disk", async () => {
      const store1 = new MemoryStore({ storeDir: dir });
      store1.addEpisodic("Task A", "Done", ["Lesson 1"]);
      await store1.flush();

      // Verify the JSONL file exists
      expect(existsSync(join(dir, "episodic.jsonl"))).toBe(true);

      // Load in new store
      const store2 = new MemoryStore({ storeDir: dir });
      const episodic = store2.getEpisodic();
      expect(episodic).toHaveLength(1);
      expect(episodic[0]!.taskSummary).toBe("Task A");
    });
  });

  // ─── Semantic Memory ──────────────────────────────────────────────────

  describe("Semantic Memory", () => {
    it("adds semantic entries with key/value", () => {
      const store = new MemoryStore({ storeDir: dir });
      const entry = store.addSemantic(
        "openvera uses pnpm",
        "The monorepo is managed with pnpm workspaces",
        ["tooling", "monorepo"]
      );

      expect(entry.tier).toBe("semantic");
      expect(entry.key).toBe("openvera uses pnpm");
      expect(entry.value).toBe("The monorepo is managed with pnpm workspaces");
    });

    it("deduplicates by key — updates existing entries", () => {
      const store = new MemoryStore({ storeDir: dir });
      store.addSemantic("project-name", "OpenVera", ["meta"]);
      store.addSemantic("project-name", "OpenVera v2", ["meta", "updated"]);

      const semantic = store.getSemantic();
      expect(semantic).toHaveLength(1);
      expect(semantic[0]!.value).toBe("OpenVera v2");
      expect(semantic[0]!.tags).toContain("updated");
    });

    it("persists semantic entries to disk", async () => {
      const store1 = new MemoryStore({ storeDir: dir });
      store1.addSemantic("fact-1", "TypeScript is used", ["lang"]);
      store1.addSemantic("fact-2", "Vitest is the test runner", ["testing"]);
      await store1.flush();

      const store2 = new MemoryStore({ storeDir: dir });
      const semantic = store2.getSemantic();
      expect(semantic).toHaveLength(2);
    });

    it("removes semantic entries by key", () => {
      const store = new MemoryStore({ storeDir: dir });
      store.addSemantic("to-remove", "temporary");
      store.addSemantic("to-keep", "permanent");

      expect(store.removeSemantic("to-remove")).toBe(true);
      expect(store.removeSemantic("nonexistent")).toBe(false);
      expect(store.getSemantic()).toHaveLength(1);
      expect(store.getSemantic()[0]!.key).toBe("to-keep");
    });
  });

  // ─── Search ───────────────────────────────────────────────────────────

  describe("Search", () => {
    it("finds relevant entries by keyword overlap", () => {
      const store = new MemoryStore();
      store.addWorking("The checkpoint system uses JSONL format", ["storage"]);
      store.addWorking("Memory system has three tiers", ["memory"]);
      store.addEpisodic("Implemented checkpoint", "Success", ["JSONL is crash-safe"]);

      const results = store.search("checkpoint JSONL");
      expect(results.length).toBeGreaterThan(0);
      // First result should be most relevant
      expect(results[0]!.entry.content).toContain("checkpoint");
    });

    it("filters by tier", () => {
      const store = new MemoryStore({ storeDir: dir });
      store.addWorking("Working note about AI", ["ai"]);
      store.addEpisodic("Built an AI agent", "Success", ["learned about agents"]);
      store.addSemantic("AI definition", "Artificial Intelligence", ["ai"]);

      const workingOnly = store.search("AI", { tiers: ["working"] });
      expect(workingOnly.every((r) => r.entry.tier === "working")).toBe(true);

      const semanticOnly = store.search("AI", { tiers: ["semantic"] });
      expect(semanticOnly.every((r) => r.entry.tier === "semantic")).toBe(true);
    });

    it("respects limit", () => {
      const store = new MemoryStore();
      for (let i = 0; i < 20; i++) {
        store.addWorking(`Entry ${i} about testing`, ["test"]);
      }

      const results = store.search("testing", { limit: 5 });
      expect(results).toHaveLength(5);
    });

    it("returns empty for no matches", () => {
      const store = new MemoryStore();
      store.addWorking("TypeScript is great", []);

      const results = store.search("blockchain cryptocurrency");
      expect(results).toHaveLength(0);
    });
  });

  // ─── Stats ────────────────────────────────────────────────────────────

  describe("Stats", () => {
    it("returns correct counts for all tiers", () => {
      const store = new MemoryStore({ storeDir: dir });
      store.addWorking("a");
      store.addWorking("b");
      store.addEpisodic("task", "done", []);
      store.addSemantic("key", "value");

      const stats = store.stats();
      expect(stats.working).toBe(2);
      expect(stats.episodic).toBe(1);
      expect(stats.semantic).toBe(1);
      expect(stats.total).toBe(4);
    });
  });

  // ─── Cross-tier Search ────────────────────────────────────────────────

  describe("Cross-tier Search", () => {
    it("searches across all tiers and ranks by relevance", () => {
      const store = new MemoryStore({ storeDir: dir });
      store.addWorking("vitest configuration tips", ["testing"], undefined, 0.3);
      store.addSemantic("vitest runner", "OpenVera uses vitest for testing", ["testing"], undefined, 0.9);
      store.addEpisodic("Set up vitest", "Configured vitest for the project", ["testing is important"]);

      const results = store.search("vitest testing");
      expect(results.length).toBe(3);
      // Semantic should rank highest due to importance boost
      expect(results[0]!.entry.tier).toBe("semantic");
    });
  });
});

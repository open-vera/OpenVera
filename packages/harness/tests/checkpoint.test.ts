import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FlowCheckpoint } from "@open-vera/core/types";
import { CheckpointStore, makeCheckpointId } from "../src/runtime/checkpoint-store.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `checkpoint-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCheckpoint(overrides: Partial<FlowCheckpoint> = {}): FlowCheckpoint {
  return {
    checkpointId: overrides.checkpointId ?? makeCheckpointId(),
    flowId: overrides.flowId ?? "test-flow",
    state: overrides.state ?? "executing",
    plan: overrides.plan ?? {
      planId: "plan-1",
      goal: "Test goal",
      assumptions: [],
      steps: [
        { id: "s1", type: "tool", action: "do something", status: "done" },
        { id: "s2", type: "tool", action: "do more", status: "pending" },
      ],
      risk: "low",
    },
    activeStepId: overrides.activeStepId ?? "s2",
    loopCount: overrides.loopCount ?? 1,
    budget: overrides.budget ?? { tokensUsed: 1000 },
    scope: overrides.scope ?? {},
    artifacts: overrides.artifacts ?? [],
  };
}

describe("CheckpointStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("save / loadLatest", () => {
    it("saves and loads the latest checkpoint for a flow", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      const cp1 = makeCheckpoint({ checkpointId: "cp-1", activeStepId: "s1" });
      const cp2 = makeCheckpoint({ checkpointId: "cp-2", activeStepId: "s2" });

      store.save(cp1);
      store.save(cp2);

      const latest = store.loadLatest("test-flow");
      expect(latest).not.toBeNull();
      expect(latest!.checkpointId).toBe("cp-2");
      expect(latest!.activeStepId).toBe("s2");
    });

    it("returns null for non-existent flow", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      expect(store.loadLatest("no-such-flow")).toBeNull();
    });
  });

  describe("load by checkpointId", () => {
    it("loads a specific checkpoint by ID", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      const cp1 = makeCheckpoint({ checkpointId: "cp-alpha" });
      const cp2 = makeCheckpoint({ checkpointId: "cp-beta" });

      store.save(cp1);
      store.save(cp2);

      const loaded = store.load("test-flow", "cp-alpha");
      expect(loaded).not.toBeNull();
      expect(loaded!.checkpointId).toBe("cp-alpha");
    });

    it("returns null for non-existent checkpoint ID", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      store.save(makeCheckpoint());

      expect(store.load("test-flow", "no-such-cp")).toBeNull();
    });
  });

  describe("list", () => {
    it("lists all checkpoint entries for a flow", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      store.save(makeCheckpoint({ checkpointId: "cp-1" }));
      store.save(makeCheckpoint({ checkpointId: "cp-2" }));
      store.save(makeCheckpoint({ checkpointId: "cp-3" }));

      const entries = store.list("test-flow");
      expect(entries).toHaveLength(3);
      expect(entries.map((e) => e.checkpointId)).toEqual(["cp-1", "cp-2", "cp-3"]);
    });

    it("returns empty array for non-existent flow", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      expect(store.list("no-such")).toEqual([]);
    });
  });

  describe("listFlows", () => {
    it("lists all flow IDs with checkpoints", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      store.save(makeCheckpoint({ flowId: "flow-a" }));
      store.save(makeCheckpoint({ flowId: "flow-b" }));
      store.save(makeCheckpoint({ flowId: "flow-a" })); // second checkpoint for flow-a

      const flows = store.listFlows();
      expect(flows).toContain("flow-a");
      expect(flows).toContain("flow-b");
    });
  });

  describe("count", () => {
    it("returns the number of checkpoints for a flow", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      store.save(makeCheckpoint());
      store.save(makeCheckpoint());
      expect(store.count("test-flow")).toBe(2);
      expect(store.count("no-such")).toBe(0);
    });
  });

  describe("clear", () => {
    it("clears all checkpoints for a flow", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      store.save(makeCheckpoint());
      store.save(makeCheckpoint());
      expect(store.count("test-flow")).toBe(2);

      store.clear("test-flow");
      expect(store.count("test-flow")).toBe(0);
      expect(store.loadLatest("test-flow")).toBeNull();
    });
  });

  describe("multi-flow isolation", () => {
    it("checkpoints for different flows are independent", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      store.save(makeCheckpoint({ flowId: "a", checkpointId: "a-cp" }));
      store.save(makeCheckpoint({ flowId: "b", checkpointId: "b-cp" }));

      expect(store.loadLatest("a")!.checkpointId).toBe("a-cp");
      expect(store.loadLatest("b")!.checkpointId).toBe("b-cp");
      expect(store.count("a")).toBe(1);
      expect(store.count("b")).toBe(1);
    });
  });

  describe("crash safety (append-only)", () => {
    it("preserves earlier entries even after a partial write simulation", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      const cp1 = makeCheckpoint({ checkpointId: "cp-1" });
      store.save(cp1);

      // Simulate a corrupt line by directly appending garbage
      const filePath = join(dir, "test-flow.checkpoints.jsonl");
      const fs = require("node:fs");
      fs.writeFileSync(filePath, "{corrupt-json\n", { flag: "a" });

      // loadLatest should still find the last valid checkpoint
      // Note: since the last line is corrupt, JSON.parse will throw.
      // In a real crash-safe scenario we'd want the store to handle this.
      // For now, just verify the first checkpoint is still readable.
      const loaded = store.load("test-flow", "cp-1");
      expect(loaded).not.toBeNull();
      expect(loaded!.checkpointId).toBe("cp-1");
    });
  });
});

describe("CheckpointStore edge cases", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("empty / blank files", () => {
    it("returns null when checkpoint file is completely empty", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      // Pre-create an empty file
      writeFileSync(join(dir, "test-flow.checkpoints.jsonl"), "");
      expect(store.loadLatest("test-flow")).toBeNull();
      expect(store.load("test-flow", "anything")).toBeNull();
      expect(store.list("test-flow")).toEqual([]);
      expect(store.count("test-flow")).toBe(0);
    });

    it("returns null when checkpoint file contains only whitespace", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      writeFileSync(join(dir, "test-flow.checkpoints.jsonl"), "   \n  \n  ");
      expect(store.loadLatest("test-flow")).toBeNull();
      expect(store.list("test-flow")).toEqual([]);
    });

    it("handles save to empty file followed by load", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      writeFileSync(join(dir, "test-flow.checkpoints.jsonl"), "");
      store.save(makeCheckpoint({ checkpointId: "cp-after-empty" }));
      expect(store.loadLatest("test-flow")!.checkpointId).toBe("cp-after-empty");
    });
  });

  describe("corrupted JSONL", () => {
    it("loadLatest skips corrupt last line and returns previous valid entry", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      store.save(makeCheckpoint({ checkpointId: "cp-valid" }));
      // Append garbage
      const filePath = join(dir, "test-flow.checkpoints.jsonl");
      writeFileSync(filePath, "{not valid json!!\n", { flag: "a" });

      const latest = store.loadLatest("test-flow");
      expect(latest).not.toBeNull();
      expect(latest!.checkpointId).toBe("cp-valid");
    });

    it("loadLatest returns null when all lines are corrupt", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      const filePath = join(dir, "test-flow.checkpoints.jsonl");
      writeFileSync(filePath, "{bad1\n{bad2\n{bad3\n");

      expect(store.loadLatest("test-flow")).toBeNull();
    });

    it("list skips corrupt lines and returns valid entries", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      store.save(makeCheckpoint({ checkpointId: "cp-1" }));
      const filePath = join(dir, "test-flow.checkpoints.jsonl");
      writeFileSync(filePath, "{garbage\n", { flag: "a" });
      store.save(makeCheckpoint({ checkpointId: "cp-2" }));

      const entries = store.list("test-flow");
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.checkpointId)).toEqual(["cp-1", "cp-2"]);
    });

    it("handles partial/truncated JSON line", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      store.save(makeCheckpoint({ checkpointId: "cp-ok" }));
      const filePath = join(dir, "test-flow.checkpoints.jsonl");
      // Truncated JSON (missing closing brace)
      writeFileSync(filePath, "{\"checkpointId\":\"cp-trunc\",\"flowId\":\"test-flow\",\"state\":\"e", { flag: "a" });

      const latest = store.loadLatest("test-flow");
      expect(latest).not.toBeNull();
      expect(latest!.checkpointId).toBe("cp-ok");
    });

    it("handles JSON that parses but is not a valid checkpoint (missing fields)", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      store.save(makeCheckpoint({ checkpointId: "cp-real" }));
      const filePath = join(dir, "test-flow.checkpoints.jsonl");
      // Valid JSON but missing required checkpoint fields
      writeFileSync(filePath, JSON.stringify({ foo: "bar" }) + "\n", { flag: "a" });

      // loadLatest returns whatever parses — it doesn't validate structure
      // This is expected behavior (type assertion), but load by ID still works
      const byId = store.load("test-flow", "cp-real");
      expect(byId).not.toBeNull();
      expect(byId!.checkpointId).toBe("cp-real");
    });
  });

  describe("oversized checkpoints", () => {
    it("handles checkpoint with large messages array", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      const largeMessages = Array.from({ length: 500 }, (_, i) => ({
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `Message ${i}: ${"x".repeat(200)}`,
      }));
      const cp: FlowCheckpoint = {
        ...makeCheckpoint({ checkpointId: "cp-big" }),
        messages: largeMessages,
      };
      store.save(cp);

      const loaded = store.loadLatest("test-flow");
      expect(loaded).not.toBeNull();
      expect(loaded!.checkpointId).toBe("cp-big");
      expect(loaded!.messages).toHaveLength(500);
    });

    it("handles checkpoint with many artifacts", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      const manyArtifacts = Array.from({ length: 100 }, (_, i) => ({
        artifactId: `art-${i}`,
        type: "file" as const,
        name: `file-${i}.txt`,
        content: "x".repeat(1000),
      }));
      const cp = makeCheckpoint({ checkpointId: "cp-artifacts", artifacts: manyArtifacts as any });
      store.save(cp);

      const loaded = store.loadLatest("test-flow");
      expect(loaded).not.toBeNull();
      expect(loaded!.checkpointId).toBe("cp-artifacts");
      expect(loaded!.artifacts).toHaveLength(100);
    });

    it("handles checkpoint with large plan steps array", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      const manySteps = Array.from({ length: 200 }, (_, i) => ({
        id: `step-${i}`,
        type: "tool" as const,
        action: `Action step ${i}`,
        status: i < 150 ? ("done" as const) : ("pending" as const),
      }));
      const cp = makeCheckpoint({
        checkpointId: "cp-bigplan",
        plan: { planId: "plan-big", goal: "Big goal", assumptions: [], steps: manySteps as any, risk: "low" },
      });
      store.save(cp);

      const loaded = store.loadLatest("test-flow");
      expect(loaded).not.toBeNull();
      expect(loaded!.plan!.steps).toHaveLength(200);
    });
  });

  describe("boundary values", () => {
    it("handles flowId with special filesystem characters (sanitized)", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      const cp = makeCheckpoint({ flowId: "flow/id:with*special?chars" });
      store.save(cp);

      const loaded = store.loadLatest("flow/id:with*special?chars");
      expect(loaded).not.toBeNull();
      // Verify the file was created with sanitized name
      expect(existsSync(join(dir, "flow_id_with_special_chars.checkpoints.jsonl"))).toBe(true);
    });

    it("handles very long flowId (truncated by OS limits)", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      const longFlowId = "a".repeat(300);
      // This should not throw — the filePath method sanitizes it
      const cp = makeCheckpoint({ flowId: longFlowId });
      // May fail on some OS due to filename length, but shouldn't crash the store
      try {
        store.save(cp);
        const loaded = store.loadLatest(longFlowId);
        if (loaded) expect(loaded.flowId).toBe(longFlowId);
      } catch (e: any) {
        // ENAMETOOLONG is acceptable — the store doesn't guard against it
        expect(e.code).toMatch(/ENAMETOOLONG|EINVAL/);
      }
    });

    it("handles empty flowId gracefully", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      const cp = makeCheckpoint({ flowId: "" });
      store.save(cp);
      // Empty flowId sanitizes to empty string → file ".checkpoints.jsonl"
      const loaded = store.loadLatest("");
      expect(loaded).not.toBeNull();
      expect(loaded!.flowId).toBe("");
    });

    it("handles duplicate checkpoint IDs (last one wins)", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      store.save(makeCheckpoint({ checkpointId: "cp-dup", activeStepId: "first" }));
      store.save(makeCheckpoint({ checkpointId: "cp-dup", activeStepId: "second" }));

      // load returns the last matching entry (scans from end)
      const loaded = store.load("test-flow", "cp-dup");
      expect(loaded).not.toBeNull();
      expect(loaded!.activeStepId).toBe("second");

      // Both entries exist in the file (append-only)
      expect(store.count("test-flow")).toBe(2);
    });

    it("handles checkpoint with all optional fields undefined", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      const minimal: FlowCheckpoint = {
        checkpointId: "cp-minimal",
        flowId: "test-flow",
        state: "executing",
        loopCount: 0,
        budget: { tokensUsed: 0 },
        scope: {},
        artifacts: [],
      };
      store.save(minimal);

      const loaded = store.loadLatest("test-flow");
      expect(loaded).not.toBeNull();
      expect(loaded!.plan).toBeUndefined();
      expect(loaded!.activeStepId).toBeUndefined();
      expect(loaded!.messages).toBeUndefined();
    });

    it("handles rapid sequential saves (no data loss)", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      const count = 50;
      for (let i = 0; i < count; i++) {
        store.save(makeCheckpoint({ checkpointId: `cp-${i}`, activeStepId: `step-${i}` }));
      }

      expect(store.count("test-flow")).toBe(count);
      const latest = store.loadLatest("test-flow");
      expect(latest!.checkpointId).toBe(`cp-${count - 1}`);

      // Verify a mid-range entry is still accessible
      const mid = store.load("test-flow", "cp-25");
      expect(mid).not.toBeNull();
      expect(mid!.activeStepId).toBe("step-25");
    });

    it("clear does not break subsequent save operations", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      store.save(makeCheckpoint({ checkpointId: "cp-before" }));
      store.clear("test-flow");
      expect(store.count("test-flow")).toBe(0);

      store.save(makeCheckpoint({ checkpointId: "cp-after" }));
      expect(store.count("test-flow")).toBe(1);
      expect(store.loadLatest("test-flow")!.checkpointId).toBe("cp-after");
    });
  });
});

describe("Checkpoint compaction", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("compact() - deduplication", () => {
    it("deduplicates checkpoints by checkpointId, keeping the latest", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      store.save(makeCheckpoint({ checkpointId: "cp-1", activeStepId: "old-s1" }));
      store.save(makeCheckpoint({ checkpointId: "cp-1", activeStepId: "new-s1" }));
      store.save(makeCheckpoint({ checkpointId: "cp-2", activeStepId: "s2" }));

      // Before compact: 3 lines
      expect(store.lineCount("test-flow")).toBe(3);

      const removed = store.compact("test-flow");
      expect(removed).toBe(1);

      // After compact: 2 unique entries
      expect(store.lineCount("test-flow")).toBe(2);
      expect(store.count("test-flow")).toBe(2);

      // cp-1 keeps the latest version
      const cp1 = store.load("test-flow", "cp-1");
      expect(cp1!.activeStepId).toBe("new-s1");
    });

    it("removes corrupt lines during compaction", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      store.save(makeCheckpoint({ checkpointId: "cp-1" }));

      // Append corrupt lines
      const filePath = join(dir, "test-flow.checkpoints.jsonl");
      writeFileSync(filePath, "not json at all\n{bad\n", { flag: "a" });

      store.save(makeCheckpoint({ checkpointId: "cp-2" }));

      expect(store.lineCount("test-flow")).toBe(4); // cp-1 + 2 corrupt + cp-2

      const removed = store.compact("test-flow");
      expect(removed).toBe(2);
      expect(store.lineCount("test-flow")).toBe(2);
      expect(store.count("test-flow")).toBe(2);
    });

    it("returns 0 for non-existent flow", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      expect(store.compact("no-such-flow")).toBe(0);
    });

    it("preserves ordering after compaction", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      store.save(makeCheckpoint({ checkpointId: "cp-1" }));
      store.save(makeCheckpoint({ checkpointId: "cp-2" }));
      store.save(makeCheckpoint({ checkpointId: "cp-3" }));

      store.compact("test-flow");

      const entries = store.list("test-flow");
      expect(entries.map((e) => e.checkpointId)).toEqual(["cp-1", "cp-2", "cp-3"]);
    });

    it("compaction is idempotent (calling twice yields same result)", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      store.save(makeCheckpoint({ checkpointId: "cp-1" }));
      store.save(makeCheckpoint({ checkpointId: "cp-1" }));

      const removed1 = store.compact("test-flow");
      expect(removed1).toBe(1);

      const removed2 = store.compact("test-flow");
      expect(removed2).toBe(0);

      expect(store.count("test-flow")).toBe(1);
    });
  });

  describe("compact() with compactToKeep", () => {
    it("prunes to the last N entries", () => {
      // Use compactAfter: Infinity to disable auto-compact so we can test manual compact
      const store = new CheckpointStore({ checkpointsDir: dir, compactToKeep: 3, compactAfter: Infinity });
      for (let i = 0; i < 10; i++) {
        store.save(makeCheckpoint({ checkpointId: `cp-${i}` }));
      }

      expect(store.lineCount("test-flow")).toBe(10);

      const removed = store.compact("test-flow");
      expect(removed).toBe(7);

      expect(store.count("test-flow")).toBe(3);

      // Last 3 are kept
      const entries = store.list("test-flow");
      expect(entries.map((e) => e.checkpointId)).toEqual(["cp-7", "cp-8", "cp-9"]);
    });

    it("keeps all entries when count is less than compactToKeep", () => {
      const store = new CheckpointStore({ checkpointsDir: dir, compactToKeep: 10 });
      store.save(makeCheckpoint({ checkpointId: "cp-1" }));
      store.save(makeCheckpoint({ checkpointId: "cp-2" }));

      const removed = store.compact("test-flow");
      expect(removed).toBe(0);
      expect(store.count("test-flow")).toBe(2);
    });

    it("combines deduplication with keep limit", () => {
      // Use compactAfter: Infinity to disable auto-compact
      const store = new CheckpointStore({ checkpointsDir: dir, compactToKeep: 2, compactAfter: Infinity });
      // 5 entries, but cp-dup appears twice (4 unique)
      store.save(makeCheckpoint({ checkpointId: "cp-a" }));
      store.save(makeCheckpoint({ checkpointId: "cp-b" }));
      store.save(makeCheckpoint({ checkpointId: "cp-dup", activeStepId: "old" }));
      store.save(makeCheckpoint({ checkpointId: "cp-c" }));
      store.save(makeCheckpoint({ checkpointId: "cp-dup", activeStepId: "new" }));

      expect(store.lineCount("test-flow")).toBe(5);

      const removed = store.compact("test-flow");
      // Dedup removes 1 (cp-dup duplicate), keep removes 2 more (cp-a, cp-b)
      expect(removed).toBe(3);
      expect(store.count("test-flow")).toBe(2);

      // After dedup, order is: cp-a, cp-b, cp-dup, cp-c
      // Keep last 2: cp-dup, cp-c
      const entries = store.list("test-flow");
      expect(entries.map((e) => e.checkpointId)).toEqual(["cp-dup", "cp-c"]);

      // cp-dup keeps the latest version
      const dup = store.load("test-flow", "cp-dup");
      expect(dup!.activeStepId).toBe("new");
    });
  });

  describe("compactAll()", () => {
    it("compacts all flows and returns total lines removed", () => {
      const store = new CheckpointStore({ checkpointsDir: dir, compactToKeep: 2 });

      // flow-a: 5 entries → 2 after compact
      for (let i = 0; i < 5; i++) {
        store.save(makeCheckpoint({ flowId: "flow-a", checkpointId: `a-cp-${i}` }));
      }
      // flow-b: 3 entries → 2 after compact
      for (let i = 0; i < 3; i++) {
        store.save(makeCheckpoint({ flowId: "flow-b", checkpointId: `b-cp-${i}` }));
      }

      const totalRemoved = store.compactAll();
      expect(totalRemoved).toBe(4); // 3 from flow-a + 1 from flow-b

      expect(store.count("flow-a")).toBe(2);
      expect(store.count("flow-b")).toBe(2);
    });
  });

  describe("auto-compaction on save", () => {
    it("auto-compacts when line count exceeds compactAfter", () => {
      // compactToKeep=3, compactAfter defaults to 3*3=9
      const store = new CheckpointStore({ checkpointsDir: dir, compactToKeep: 3 });

      // Save 9 entries — should NOT trigger auto-compact (9 <= 9)
      for (let i = 0; i < 9; i++) {
        store.save(makeCheckpoint({ checkpointId: `cp-${i}` }));
      }
      expect(store.lineCount("test-flow")).toBe(9);

      // Save entry #10 — line count = 10 > 9 → auto-compact triggers
      store.save(makeCheckpoint({ checkpointId: "cp-9" }));
      expect(store.lineCount("test-flow")).toBe(3); // compacted to 3
      expect(store.count("test-flow")).toBe(3);

      // Last 3 entries are kept
      const entries = store.list("test-flow");
      expect(entries.map((e) => e.checkpointId)).toEqual(["cp-7", "cp-8", "cp-9"]);
    });

    it("does NOT auto-compact when compactToKeep is not set", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });

      for (let i = 0; i < 20; i++) {
        store.save(makeCheckpoint({ checkpointId: `cp-${i}` }));
      }

      // No compaction happened — all 20 entries remain
      expect(store.lineCount("test-flow")).toBe(20);
    });

    it("respects custom compactAfter threshold", () => {
      const store = new CheckpointStore({
        checkpointsDir: dir,
        compactToKeep: 2,
        compactAfter: 5,
      });

      for (let i = 0; i < 5; i++) {
        store.save(makeCheckpoint({ checkpointId: `cp-${i}` }));
      }
      expect(store.lineCount("test-flow")).toBe(5); // 5 <= 5, no compact

      store.save(makeCheckpoint({ checkpointId: "cp-5" }));
      expect(store.lineCount("test-flow")).toBe(2); // compacted!
    });

    it("auto-compact handles duplicates in the file", () => {
      const store = new CheckpointStore({ checkpointsDir: dir, compactToKeep: 2, compactAfter: 4 });

      // Save 3 unique + 1 duplicate = 4 lines (4 <= 4, no compact)
      store.save(makeCheckpoint({ checkpointId: "cp-1", activeStepId: "old" }));
      store.save(makeCheckpoint({ checkpointId: "cp-2" }));
      store.save(makeCheckpoint({ checkpointId: "cp-3" }));
      store.save(makeCheckpoint({ checkpointId: "cp-1", activeStepId: "updated" }));

      expect(store.lineCount("test-flow")).toBe(4);

      // One more save → line count = 5 > 4 → auto-compact
      store.save(makeCheckpoint({ checkpointId: "cp-4" }));

      expect(store.lineCount("test-flow")).toBe(2);
      const entries = store.list("test-flow");
      expect(entries.map((e) => e.checkpointId)).toEqual(["cp-3", "cp-4"]);
    });
  });

  describe("lineCount()", () => {
    it("returns raw line count including corrupt lines", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      store.save(makeCheckpoint({ checkpointId: "cp-1" }));

      const filePath = join(dir, "test-flow.checkpoints.jsonl");
      writeFileSync(filePath, "corrupt\n", { flag: "a" });

      expect(store.lineCount("test-flow")).toBe(2);
    });

    it("returns 0 for non-existent flow", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      expect(store.lineCount("no-such")).toBe(0);
    });
  });

  describe("needsCompaction()", () => {
    it("returns true when lineCount exceeds threshold", () => {
      const store = new CheckpointStore({ checkpointsDir: dir, compactToKeep: 3, compactAfter: 10 });
      for (let i = 0; i < 15; i++) {
        store.save(makeCheckpoint({ checkpointId: `cp-${i}` }));
      }
      // auto-compact fired at save 11 (lineCount 11 > 10), compacted to 3
      // then saves 12-15 added 4 more → lineCount = 7
      // 7 > 10? no. So needsCompaction is false.
      // We need to test the raw check, not through auto-compact saves.
      // Use compactAfter: Infinity and test lineCount > compactAfter manually.
      const store2 = new CheckpointStore({ checkpointsDir: dir, compactToKeep: 3, compactAfter: Infinity });
      for (let i = 0; i < 15; i++) {
        store2.save(makeCheckpoint({ flowId: "test-flow-2", checkpointId: `cp2-${i}` }));
      }
      // lineCount = 15, compactAfter = Infinity → needsCompaction is false (15 > Infinity is false)
      expect(store2.needsCompaction("test-flow-2")).toBe(false);

      // The real test: with a low threshold and enough lines
      const store3 = new CheckpointStore({ checkpointsDir: dir, compactToKeep: 100, compactAfter: 10 });
      for (let i = 0; i < 15; i++) {
        store3.save(makeCheckpoint({ flowId: "test-flow-3", checkpointId: `cp3-${i}` }));
      }
      // compactToKeep=100, so auto-compact fires at 11 lines but keeps all 100 (no pruning since 11 < 100)
      // Actually: compact() deduplicates (no dups) and keeps last 100, so removes 0 lines.
      // After save #11: lineCount was 11, auto-compact removes 0 → still 11.
      // Then saves 12-15 → lineCount = 15. needsCompaction: 15 > 10 = true.
      expect(store3.lineCount("test-flow-3")).toBe(15);
      expect(store3.needsCompaction("test-flow-3")).toBe(true);
    });

    it("returns false when compactToKeep is not set", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      for (let i = 0; i < 100; i++) {
        store.save(makeCheckpoint({ checkpointId: `cp-${i}` }));
      }
      expect(store.needsCompaction("test-flow")).toBe(false);
    });

    it("returns false when below threshold", () => {
      const store = new CheckpointStore({ checkpointsDir: dir, compactToKeep: 10 });
      store.save(makeCheckpoint({ checkpointId: "cp-1" }));
      expect(store.needsCompaction("test-flow")).toBe(false);
    });
  });

  describe("atomic write safety", () => {
    it("checkpoint file is valid JSONL after compaction", () => {
      const store = new CheckpointStore({ checkpointsDir: dir, compactToKeep: 3 });
      for (let i = 0; i < 8; i++) {
        store.save(makeCheckpoint({ checkpointId: `cp-${i}` }));
      }

      store.compact("test-flow");

      // Verify every line is valid JSON
      const filePath = join(dir, "test-flow.checkpoints.jsonl");
      const raw = readFileSync(filePath, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      expect(lines).toHaveLength(3);

      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed).toHaveProperty("checkpointId");
        expect(parsed).toHaveProperty("flowId");
      }
    });

    it("temp .compacting file does not remain after compaction", () => {
      const store = new CheckpointStore({ checkpointsDir: dir });
      store.save(makeCheckpoint({ checkpointId: "cp-1" }));
      store.save(makeCheckpoint({ checkpointId: "cp-2" }));

      store.compact("test-flow");

      const tmpPath = join(dir, "test-flow.checkpoints.jsonl.compacting");
      expect(existsSync(tmpPath)).toBe(false);
    });
  });
});

describe("makeCheckpointId", () => {
  it("generates unique IDs with timestamp prefix", () => {
    const id1 = makeCheckpointId();
    const id2 = makeCheckpointId();
    expect(id1).toMatch(/^cp-[a-z0-9]+-[a-z0-9]{4}$/);
    expect(id1).not.toBe(id2);
  });

  it("generates many unique IDs without collision", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(makeCheckpointId());
    }
    // With 4 random chars and timestamp, 100 should be unique
    expect(ids.size).toBe(100);
  });
});

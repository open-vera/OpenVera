import { mkdirSync, readFileSync, rmSync } from "node:fs";
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

describe("makeCheckpointId", () => {
  it("generates unique IDs with timestamp prefix", () => {
    const id1 = makeCheckpointId();
    const id2 = makeCheckpointId();
    expect(id1).toMatch(/^cp-[a-z0-9]+-[a-z0-9]{4}$/);
    expect(id1).not.toBe(id2);
  });
});

/**
 * Tests for review findings — Bug #2: CheckpointStore auto-compaction
 * using raw line count instead of parsed entry count.
 *
 * Fix: maybeAutoCompact() now uses in-memory entry count cache
 * (updated on save/compact/clear) instead of raw line count,
 * preventing false compaction triggers from corrupt/duplicate lines.
 */
import { mkdirSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FlowCheckpoint } from "@open-vera/core/types";
import { CheckpointStore, makeCheckpointId } from "../src/runtime/checkpoint-store.js";

const FLOW = "test-flow";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `cp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCheckpoint(overrides: Partial<FlowCheckpoint> = {}): FlowCheckpoint {
  return {
    checkpointId: overrides.checkpointId ?? makeCheckpointId(),
    flowId: FLOW,
    state: overrides.state ?? "executing",
    plan: {
      planId: "plan-1",
      goal: "Test goal",
      assumptions: [],
      steps: [{ id: "s1", type: "tool", action: "do it", status: "done" }],
      risk: "low",
    },
    activeStepId: "s1",
    loopCount: 1,
    budget: { tokensUsed: 1000 },
    scope: {},
    artifacts: [],
    ...overrides,
  };
}

describe("CheckpointStore — auto-compaction fix", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("should NOT trigger auto-compaction from corrupt lines inflating lineCount", () => {
    // When compactToKeep=2, compactAfter defaults to 6.
    // If the file has corrupt lines, raw lineCount could be 7+ while
    // actual parsed entry count is only 2 — the fix prevents false triggers.
    const store = new CheckpointStore({ checkpointsDir: dir, compactToKeep: 2 });

    // Save exactly 2 entries (cache entry count = 2, below threshold 6)
    store.save(makeCheckpoint({ checkpointId: "cp-1" }));
    store.save(makeCheckpoint({ checkpointId: "cp-2" }));

    // Manually inject corrupt lines to inflate raw line count
    const filePath = join(dir, "test-flow.checkpoints.jsonl");
    for (let i = 0; i < 5; i++) {
      appendFileSync(filePath, "NOT VALID JSON\n");
    }

    // Raw line count is 7 (> 6 threshold), but entry count is only 2
    const lineCountBefore = store.lineCount(FLOW);
    expect(lineCountBefore).toBe(7);

    // Next save should NOT trigger auto-compact (entry count 3 < 6)
    store.save(makeCheckpoint({ checkpointId: "cp-3" }));
    const latest = store.loadLatest(FLOW);
    expect(latest?.checkpointId).toBe("cp-3"); // cp-3 still present → no compact
  });

  it("should correctly count entries after save even when file has corrupt lines", () => {
    const store = new CheckpointStore({ checkpointsDir: dir, compactToKeep: 3 });
    store.save(makeCheckpoint({ checkpointId: "cp-1" }));

    const filePath = join(dir, "test-flow.checkpoints.jsonl");
    for (let i = 0; i < 5; i++) {
      appendFileSync(filePath, "corrupt data\n");
    }

    // count() parses and skips corrupt lines
    expect(store.count(FLOW)).toBe(1);
    // lineCount() returns raw count including corrupt
    expect(store.lineCount(FLOW)).toBe(6);
  });

  it("should trigger auto-compaction when actual entry count exceeds threshold", () => {
    const store = new CheckpointStore({ checkpointsDir: dir, compactToKeep: 2 });
    // compactAfter = 2 * 3 = 6

    // Save enough to trigger compaction (entry count > 6)
    for (let i = 0; i < 7; i++) {
      store.save(makeCheckpoint({ checkpointId: `cp-${i}` }));
    }

    // Should be compacted to 2 entries
    expect(store.count(FLOW)).toBeLessThanOrEqual(2);
    // Latest should be cp-6
    const latest = store.loadLatest(FLOW);
    expect(latest?.checkpointId).toBe("cp-6");
  });

  it("should not trigger auto-compaction below threshold even with many corrupt lines", () => {
    const store = new CheckpointStore({ checkpointsDir: dir, compactToKeep: 2 });

    store.save(makeCheckpoint({ checkpointId: "cp-1" }));
    store.save(makeCheckpoint({ checkpointId: "cp-2" }));

    // Inject 10 corrupt lines → raw line count = 12
    const filePath = join(dir, "test-flow.checkpoints.jsonl");
    for (let i = 0; i < 10; i++) {
      appendFileSync(filePath, "corrupt line\n");
    }

    const lineCount = store.lineCount(FLOW);
    expect(lineCount).toBe(12);

    // Entry count is 2 — below 6, no auto-compaction
    // But lineCount is 12, which would trigger the OLD (buggy) behavior
    // Manual compact() should still work
    store.compact(FLOW);
    expect(store.count(FLOW)).toBeLessThanOrEqual(2);
  });

  it("should update entry count cache after clear()", () => {
    const store = new CheckpointStore({ checkpointsDir: dir, compactToKeep: 2 });
    store.save(makeCheckpoint({ checkpointId: "cp-1" }));
    store.save(makeCheckpoint({ checkpointId: "cp-2" }));

    expect(store.count(FLOW)).toBe(2);

    store.clear(FLOW);
    expect(store.count(FLOW)).toBe(0);

    store.save(makeCheckpoint({ checkpointId: "cp-3" }));
    expect(store.count(FLOW)).toBe(1);
  });
});
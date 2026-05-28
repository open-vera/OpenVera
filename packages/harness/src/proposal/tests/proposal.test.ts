/**
 * Tests for Proposal Pipeline (PP1-PP6).
 * Covers: ProposalStore, ProposalPipeline.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProposalStore } from "../store.js";
import { ProposalPipeline } from "../pipeline.js";
import type { ImprovementProposal } from "../../dreaming/runner.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(name: string): string {
  const dir = join(tmpdir(), `proposal-test-${name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function makeProposal(overrides: Partial<ImprovementProposal> = {}): ImprovementProposal {
  return {
    id: `proposal-${Math.random().toString(36).slice(2, 8)}`,
    type: "workflow",
    priority: "medium",
    status: "pending",
    title: "Test proposal",
    description: "A test improvement proposal",
    rationale: "Testing purposes",
    insights: ["insight-1"],
    suggestedChange: "Do something better",
    expectedImpact: "Improved performance",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── ProposalStore Tests ─────────────────────────────────────────────────────

describe("ProposalStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir("store");
  });

  afterEach(() => cleanup(tmpDir));

  it("should add and retrieve proposals", () => {
    const store = new ProposalStore(join(tmpDir, "proposals.json"));
    const p = makeProposal({ id: "p-1" });
    store.add(p);

    expect(store.get("p-1")).toBeDefined();
    expect(store.get("p-1")!.title).toBe("Test proposal");
  });

  it("should prevent duplicate IDs", () => {
    const store = new ProposalStore(join(tmpDir, "proposals.json"));
    store.add(makeProposal({ id: "p-1", title: "First" }));
    store.add(makeProposal({ id: "p-1", title: "Duplicate" }));

    expect(store.count()).toBe(1);
    expect(store.get("p-1")!.title).toBe("First");
  });

  it("should add multiple proposals", () => {
    const store = new ProposalStore(join(tmpDir, "proposals.json"));
    store.addAll([
      makeProposal({ id: "p-1" }),
      makeProposal({ id: "p-2" }),
      makeProposal({ id: "p-3" }),
    ]);

    expect(store.count()).toBe(3);
  });

  it("should update status", () => {
    const store = new ProposalStore(join(tmpDir, "proposals.json"));
    store.add(makeProposal({ id: "p-1" }));

    expect(store.updateStatus("p-1", "approved")).toBe(true);
    expect(store.get("p-1")!.status).toBe("approved");
  });

  it("should return false for non-existent status update", () => {
    const store = new ProposalStore(join(tmpDir, "proposals.json"));
    expect(store.updateStatus("nonexistent", "approved")).toBe(false);
  });

  it("should filter by status", () => {
    const store = new ProposalStore(join(tmpDir, "proposals.json"));
    store.add(makeProposal({ id: "p-1", status: "pending" }));
    store.add(makeProposal({ id: "p-2", status: "approved" }));
    store.add(makeProposal({ id: "p-3", status: "pending" }));

    const pending = store.list({ status: "pending" });
    expect(pending.length).toBe(2);
  });

  it("should filter by type", () => {
    const store = new ProposalStore(join(tmpDir, "proposals.json"));
    store.add(makeProposal({ id: "p-1", type: "workflow" }));
    store.add(makeProposal({ id: "p-2", type: "skill" }));
    store.add(makeProposal({ id: "p-3", type: "workflow" }));

    const workflows = store.list({ type: "workflow" });
    expect(workflows.length).toBe(2);
  });

  it("should get ready for rollout", () => {
    const store = new ProposalStore(join(tmpDir, "proposals.json"));
    store.add(makeProposal({ id: "p-1", status: "pending" }));
    store.add(makeProposal({ id: "p-2", status: "approved" }));
    store.add(makeProposal({ id: "p-3", status: "approved" }));

    const ready = store.getReadyForRollout();
    expect(ready.length).toBe(2);
  });

  it("should get applied proposals", () => {
    const store = new ProposalStore(join(tmpDir, "proposals.json"));
    store.add(makeProposal({ id: "p-1", status: "applied" }));
    store.add(makeProposal({ id: "p-2", status: "pending" }));

    expect(store.getApplied().length).toBe(1);
  });

  it("should remove proposals", () => {
    const store = new ProposalStore(join(tmpDir, "proposals.json"));
    store.add(makeProposal({ id: "p-1" }));

    expect(store.remove("p-1")).toBe(true);
    expect(store.get("p-1")).toBeUndefined();
    expect(store.remove("nonexistent")).toBe(false);
  });

  it("should count by status", () => {
    const store = new ProposalStore(join(tmpDir, "proposals.json"));
    store.add(makeProposal({ id: "p-1", status: "pending" }));
    store.add(makeProposal({ id: "p-2", status: "approved" }));
    store.add(makeProposal({ id: "p-3", status: "pending" }));

    const counts = store.countByStatus();
    expect(counts.pending).toBe(2);
    expect(counts.approved).toBe(1);
    expect(counts.rejected).toBe(0);
  });

  it("should persist across instances", () => {
    const path = join(tmpDir, "proposals.json");
    const store1 = new ProposalStore(path);
    store1.add(makeProposal({ id: "p-1" }));

    const store2 = new ProposalStore(path);
    expect(store2.count()).toBe(1);
    expect(store2.get("p-1")).toBeDefined();
  });
});

// ── ProposalPipeline Tests ──────────────────────────────────────────────────

describe("ProposalPipeline", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir("pipeline");
  });

  afterEach(() => cleanup(tmpDir));

  function createPipeline(options?: {
    applySuccess?: boolean;
    verifyPassRate?: number;
    rollbackSuccess?: boolean;
  }) {
    const store = new ProposalStore(join(tmpDir, "proposals.json"));
    return new ProposalPipeline({
      store,
      applyFn: async () => options?.applySuccess ?? true,
      verifyFn: async () => ({ passRate: options?.verifyPassRate ?? 0.85 }),
      rollbackFn: async () => options?.rollbackSuccess ?? true,
      baselinePassRate: 0.8,
      regressionThreshold: 0.05,
    });
  }

  it("should submit proposals", () => {
    const pipeline = createPipeline();
    pipeline.submitProposals([
      makeProposal({ id: "p-1" }),
      makeProposal({ id: "p-2" }),
    ]);

    expect(pipeline.getStore().count()).toBe(2);
  });

  it("should approve proposals", () => {
    const pipeline = createPipeline();
    pipeline.submitProposals([makeProposal({ id: "p-1" })]);

    expect(pipeline.approve("p-1")).toBe(true);
    expect(pipeline.getStore().get("p-1")!.status).toBe("approved");
  });

  it("should reject proposals", () => {
    const pipeline = createPipeline();
    pipeline.submitProposals([makeProposal({ id: "p-1" })]);

    expect(pipeline.reject("p-1")).toBe(true);
    expect(pipeline.getStore().get("p-1")!.status).toBe("rejected");
  });

  it("should defer proposals", () => {
    const pipeline = createPipeline();
    pipeline.submitProposals([makeProposal({ id: "p-1" })]);

    expect(pipeline.defer("p-1")).toBe(true);
    expect(pipeline.getStore().get("p-1")!.status).toBe("deferred");
  });

  it("should rollout approved proposals", async () => {
    const pipeline = createPipeline({ applySuccess: true, verifyPassRate: 0.9 });
    pipeline.submitProposals([
      makeProposal({ id: "p-1", status: "approved" }),
      makeProposal({ id: "p-2", status: "approved" }),
    ]);

    const result = await pipeline.rollout();
    expect(result.applied).toContain("p-1");
    expect(result.applied).toContain("p-2");
    expect(result.failed.length).toBe(0);
  });

  it("should rollback on verification failure", async () => {
    const pipeline = createPipeline({ applySuccess: true, verifyPassRate: 0.5 });
    pipeline.submitProposals([makeProposal({ id: "p-1", status: "approved" })]);

    const result = await pipeline.rollout();
    expect(result.applied).toContain("p-1");
    expect(result.verificationResults[0].passed).toBe(false);

    // Should have been rolled back to pending
    expect(pipeline.getStore().get("p-1")!.status).toBe("pending");
  });

  it("should handle apply failures", async () => {
    const pipeline = createPipeline({ applySuccess: false });
    pipeline.submitProposals([makeProposal({ id: "p-1", status: "approved" })]);

    const result = await pipeline.rollout();
    expect(result.failed).toContain("p-1");
    expect(result.applied.length).toBe(0);
  });

  it("should respect batch size", async () => {
    const pipeline = createPipeline();
    pipeline.submitProposals(
      Array.from({ length: 10 }, (_, i) =>
        makeProposal({ id: `p-${i}`, status: "approved" }),
      ),
    );

    const result = await pipeline.rollout({ batchSize: 3 });
    expect(result.applied.length).toBeLessThanOrEqual(3);
  });

  it("should provide pipeline statistics", () => {
    const pipeline = createPipeline();
    pipeline.submitProposals([
      makeProposal({ id: "p-1", status: "pending", type: "workflow" }),
      makeProposal({ id: "p-2", status: "approved", type: "skill" }),
      makeProposal({ id: "p-3", status: "pending", type: "workflow" }),
    ]);

    const stats = pipeline.getStats();
    expect(stats.total).toBe(3);
    expect(stats.byStatus.pending).toBe(2);
    expect(stats.byType.workflow).toBe(2);
  });
});

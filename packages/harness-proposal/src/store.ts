/**
 * Proposal Store — Persistent storage for improvement proposals.
 *
 * Stores proposals with status tracking, enabling human review
 * and lifecycle management (pending → approved → applied → verified).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ImprovementProposal } from "@open-vera/harness-dreaming";

// ── Types ────────────────────────────────────────────────────────────────────

export type ProposalStoreStatus = ImprovementProposal["status"];

export interface ProposalFilter {
  status?: ProposalStoreStatus;
  type?: ImprovementProposal["type"];
  priority?: ImprovementProposal["priority"];
  since?: string;
}

// ── Proposal Store ───────────────────────────────────────────────────────────

export class ProposalStore {
  private proposals: ImprovementProposal[] = [];
  private storagePath: string;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    this.load();
  }

  /**
   * Add a new proposal.
   */
  add(proposal: ImprovementProposal): void {
    // Prevent duplicates by ID
    if (this.proposals.some((p) => p.id === proposal.id)) {
      return;
    }
    this.proposals.push(proposal);
    this.save();
  }

  /**
   * Add multiple proposals.
   */
  addAll(proposals: ImprovementProposal[]): void {
    for (const p of proposals) {
      if (!this.proposals.some((existing) => existing.id === p.id)) {
        this.proposals.push(p);
      }
    }
    this.save();
  }

  /**
   * Get a proposal by ID.
   */
  get(id: string): ImprovementProposal | undefined {
    return this.proposals.find((p) => p.id === id);
  }

  /**
   * Update proposal status.
   */
  updateStatus(id: string, status: ProposalStoreStatus): boolean {
    const proposal = this.proposals.find((p) => p.id === id);
    if (!proposal) return false;

    proposal.status = status;
    this.save();
    return true;
  }

  /**
   * List proposals with optional filter.
   */
  list(filter?: ProposalFilter): ImprovementProposal[] {
    let results = [...this.proposals];

    if (filter?.status) {
      results = results.filter((p) => p.status === filter.status);
    }
    if (filter?.type) {
      results = results.filter((p) => p.type === filter.type);
    }
    if (filter?.priority) {
      results = results.filter((p) => p.priority === filter.priority);
    }
    if (filter?.since) {
      results = results.filter((p) => p.createdAt >= filter.since!);
    }

    return results;
  }

  /**
   * Get proposals ready for rollout (approved, not yet applied).
   */
  getReadyForRollout(): ImprovementProposal[] {
    return this.proposals.filter((p) => p.status === "approved");
  }

  /**
   * Get applied proposals (for verification/rollback).
   */
  getApplied(): ImprovementProposal[] {
    return this.proposals.filter((p) => p.status === "applied");
  }

  /**
   * Remove a proposal.
   */
  remove(id: string): boolean {
    const idx = this.proposals.findIndex((p) => p.id === id);
    if (idx < 0) return false;

    this.proposals.splice(idx, 1);
    this.save();
    return true;
  }

  /**
   * Get count of proposals.
   */
  count(): number {
    return this.proposals.length;
  }

  /**
   * Get counts by status.
   */
  countByStatus(): Record<ProposalStoreStatus, number> {
    const counts: Record<ProposalStoreStatus, number> = {
      pending: 0,
      approved: 0,
      rejected: 0,
      deferred: 0,
      applied: 0,
    };

    for (const p of this.proposals) {
      counts[p.status]++;
    }

    return counts;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private load(): void {
    if (existsSync(this.storagePath)) {
      try {
        const content = readFileSync(this.storagePath, "utf-8");
        this.proposals = JSON.parse(content) as ImprovementProposal[];
      } catch {
        this.proposals = [];
      }
    }
  }

  private save(): void {
    const dir = dirname(this.storagePath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.storagePath, JSON.stringify(this.proposals, null, 2), "utf-8");
  }
}

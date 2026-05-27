/**
 * Proposal Pipeline — Manages the full lifecycle of improvement proposals.
 *
 * Lifecycle: pending → approved → applied → verified (or rolled back)
 * Includes rollout, verification, and rollback capabilities.
 */

import { ProposalStore } from "./store.js";
import type { ProposalFilter } from "./store.js";
import type { ImprovementProposal } from "../dreaming/runner.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RolloutConfig {
  /** Maximum proposals to apply in one rollout */
  batchSize?: number;
  /** Rollout scope: "all" or specific component */
  scope?: string;
}

export interface VerificationResult {
  proposalId: string;
  passed: boolean;
  passRateBefore: number;
  passRateAfter: number;
  delta: number;
  details: string;
}

export interface RolloutResult {
  applied: string[];
  failed: string[];
  verificationResults: VerificationResult[];
}

// ── Proposal Pipeline ────────────────────────────────────────────────────────

export class ProposalPipeline {
  private store: ProposalStore;
  private applyFn: (proposal: ImprovementProposal) => Promise<boolean>;
  private verifyFn: (proposalId: string) => Promise<{ passRate: number }>;
  private rollbackFn: (proposalId: string) => Promise<boolean>;
  private baselinePassRate: number;
  private regressionThreshold: number;

  constructor(options: {
    store: ProposalStore;
    applyFn: (proposal: ImprovementProposal) => Promise<boolean>;
    verifyFn: (proposalId: string) => Promise<{ passRate: number }>;
    rollbackFn: (proposalId: string) => Promise<boolean>;
    baselinePassRate?: number;
    regressionThreshold?: number;
  }) {
    this.store = options.store;
    this.applyFn = options.applyFn;
    this.verifyFn = options.verifyFn;
    this.rollbackFn = options.rollbackFn;
    this.baselinePassRate = options.baselinePassRate ?? 0.8;
    this.regressionThreshold = options.regressionThreshold ?? 0.05;
  }

  /**
   * Get the store instance.
   */
  getStore(): ProposalStore {
    return this.store;
  }

  /**
   * Submit proposals from dreaming.
   */
  submitProposals(proposals: ImprovementProposal[]): void {
    this.store.addAll(proposals);
  }

  /**
   * Approve a proposal for rollout.
   */
  approve(id: string): boolean {
    return this.store.updateStatus(id, "approved");
  }

  /**
   * Reject a proposal.
   */
  reject(id: string): boolean {
    return this.store.updateStatus(id, "rejected");
  }

  /**
   * Defer a proposal for later consideration.
   */
  defer(id: string): boolean {
    return this.store.updateStatus(id, "deferred");
  }

  /**
   * Execute rollout: apply approved proposals, verify, and rollback if needed.
   */
  async rollout(config?: RolloutConfig): Promise<RolloutResult> {
    const batchSize = config?.batchSize ?? 5;
    const ready = this.store.getReadyForRollout().slice(0, batchSize);

    const applied: string[] = [];
    const failed: string[] = [];
    const verificationResults: VerificationResult[] = [];

    for (const proposal of ready) {
      try {
        const success = await this.applyFn(proposal);
        if (success) {
          this.store.updateStatus(proposal.id, "applied");
          applied.push(proposal.id);

          // Verify the change
          const verification = await this.verifyProposal(proposal);
          verificationResults.push(verification);

          if (!verification.passed) {
            // Rollback if verification fails
            await this.rollback(proposal.id);
          }
        } else {
          failed.push(proposal.id);
        }
      } catch {
        failed.push(proposal.id);
      }
    }

    return { applied, failed, verificationResults };
  }

  /**
   * Verify an applied proposal.
   */
  async verifyProposal(proposal: ImprovementProposal): Promise<VerificationResult> {
    const result = await this.verifyFn(proposal.id);
    const delta = result.passRate - this.baselinePassRate;
    const passed = delta >= -this.regressionThreshold;

    return {
      proposalId: proposal.id,
      passed,
      passRateBefore: this.baselinePassRate,
      passRateAfter: result.passRate,
      delta,
      details: passed
        ? `Verification passed (${(result.passRate * 100).toFixed(1)}%)`
        : `Regression detected (${(delta * 100).toFixed(1)}% drop)`,
    };
  }

  /**
   * Rollback an applied proposal.
   */
  async rollback(id: string): Promise<boolean> {
    const success = await this.rollbackFn(id);
    if (success) {
      this.store.updateStatus(id, "pending");
    }
    return success;
  }

  /**
   * Get pipeline statistics.
   */
  getStats(): {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    byPriority: Record<string, number>;
  } {
    const all = this.store.list();
    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    const byPriority: Record<string, number> = {};

    for (const p of all) {
      byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
      byType[p.type] = (byType[p.type] ?? 0) + 1;
      byPriority[p.priority] = (byPriority[p.priority] ?? 0) + 1;
    }

    return { total: all.length, byStatus, byType, byPriority };
  }
}

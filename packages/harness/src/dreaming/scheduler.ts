/**
 * Dreaming Scheduler — Triggers dreaming during agent idle time.
 *
 * Monitors agent activity and triggers dreaming when the agent has been
 * idle for a configurable duration. New user input cancels ongoing dreaming.
 */

import { DreamingRunner } from "./runner.js";
import type { Experience, DreamingResult, DreamingConfig } from "./runner.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SchedulerConfig extends DreamingConfig {
  /** Idle time in ms before triggering dreaming (default: 300_000 = 5 min) */
  idleThresholdMs?: number;
  /** Minimum experiences required to trigger dreaming */
  minExperiences?: number;
  /** Callback when dreaming completes */
  onComplete?: (result: DreamingResult) => void;
  /** Callback when dreaming is interrupted */
  onInterrupt?: () => void;
}

// ── Dreaming Scheduler ──────────────────────────────────────────────────────

export class DreamingScheduler {
  private config: Required<SchedulerConfig>;
  private runner: DreamingRunner;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private isDreaming = false;
  private abortController: AbortController | null = null;
  private lastActivityTime = Date.now();
  private experienceSource: () => Experience[];

  constructor(
    experienceSource: () => Experience[],
    config?: SchedulerConfig,
  ) {
    this.experienceSource = experienceSource;
    this.config = {
      maxExperiences: config?.maxExperiences ?? 100,
      minConfidence: config?.minConfidence ?? 0.5,
      maxProposals: config?.maxProposals ?? 10,
      proposalTypes: config?.proposalTypes ?? ["prompt", "tool_policy", "workflow", "skill"],
      idleThresholdMs: config?.idleThresholdMs ?? 300_000,
      minExperiences: config?.minExperiences ?? 5,
      onComplete: config?.onComplete ?? (() => {}),
      onInterrupt: config?.onInterrupt ?? (() => {}),
    };

    this.runner = new DreamingRunner({
      maxExperiences: this.config.maxExperiences,
      minConfidence: this.config.minConfidence,
      maxProposals: this.config.maxProposals,
      proposalTypes: this.config.proposalTypes,
    });
  }

  /**
   * Notify the scheduler that the agent is active.
   * Resets the idle timer and interrupts ongoing dreaming.
   */
  notifyActivity(): void {
    this.lastActivityTime = Date.now();

    if (this.isDreaming) {
      this.interrupt();
    }

    this.resetIdleTimer();
  }

  /**
   * Start monitoring for idle time.
   */
  start(): void {
    this.resetIdleTimer();
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.interrupt();
  }

  /**
   * Check if dreaming is currently in progress.
   */
  getIsActive(): boolean {
    return this.isDreaming;
  }

  /**
   * Get time since last activity.
   */
  getIdleTimeMs(): number {
    return Date.now() - this.lastActivityTime;
  }

  /**
   * Manually trigger dreaming (ignores idle threshold).
   */
  async triggerDream(): Promise<DreamingResult | null> {
    const experiences = this.experienceSource();
    if (experiences.length < this.config.minExperiences) {
      return null;
    }

    return this.runDreaming(experiences);
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      this.onIdle();
    }, this.config.idleThresholdMs);
  }

  private async onIdle(): Promise<void> {
    const experiences = this.experienceSource();
    if (experiences.length < this.config.minExperiences) {
      return;
    }

    await this.runDreaming(experiences);
  }

  private async runDreaming(experiences: Experience[]): Promise<DreamingResult> {
    this.isDreaming = true;
    this.abortController = new AbortController();

    try {
      const result = await this.runner.dream(experiences);

      if (!this.abortController.signal.aborted) {
        this.config.onComplete(result);
      }

      return result;
    } finally {
      this.isDreaming = false;
      this.abortController = null;
    }
  }

  private interrupt(): void {
    if (this.isDreaming && this.abortController) {
      this.abortController.abort();
      this.isDreaming = false;
      this.config.onInterrupt();
    }
  }
}

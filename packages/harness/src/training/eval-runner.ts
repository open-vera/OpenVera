/**
 * Eval Runner — Evaluates trained skills using SkillOpt evaluation capabilities.
 *
 * Supports multiple evaluation modes and produces structured reports.
 */

import { SkillOptAdapter } from "./skill-opt-adapter.js";
import type { SkillOptConfig, EvalOnlyResult } from "./skill-opt-adapter.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type EvalMode = "valid_unseen" | "valid_seen" | "train" | "all";

export interface EvalRunOptions {
  /** Path to the skill file to evaluate */
  skillPath: string;
  /** Path to data directory (containing train/val/test splits) */
  dataDir: string;
  /** Evaluation mode */
  mode?: EvalMode;
}

export interface EvalReport {
  skillPath: string;
  mode: EvalMode;
  passRate: number;
  accuracy: number;
  avgSteps: number;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  timestamp: string;
}

// ── Eval Runner ──────────────────────────────────────────────────────────────

export class TrainingEvalRunner {
  private adapter: SkillOptAdapter;

  constructor(config: SkillOptConfig) {
    this.adapter = new SkillOptAdapter(config);
  }

  /**
   * Run evaluation on a skill file.
   */
  async evaluate(options: EvalRunOptions): Promise<EvalReport> {
    const mode = options.mode ?? "valid_unseen";
    const result = await this.adapter.evaluate(options.skillPath, options.dataDir, mode);
    return this.buildReport(options.skillPath, mode, result);
  }

  /**
   * Run evaluation across all modes for comprehensive assessment.
   */
  async evaluateAll(skillPath: string, dataDir: string): Promise<EvalReport[]> {
    const modes: EvalMode[] = ["valid_unseen", "valid_seen", "train"];
    const reports: EvalReport[] = [];

    for (const mode of modes) {
      const report = await this.evaluate({ skillPath, dataDir, mode });
      reports.push(report);
    }

    return reports;
  }

  /**
   * Compare two skills head-to-head.
   */
  async compare(
    skillPathA: string,
    skillPathB: string,
    dataDir: string,
    mode: EvalMode = "valid_unseen",
  ): Promise<{ skillA: EvalReport; skillB: EvalReport; winner: "A" | "B" | "tie" }> {
    const [skillA, skillB] = await Promise.all([
      this.evaluate({ skillPath: skillPathA, dataDir, mode }),
      this.evaluate({ skillPath: skillPathB, dataDir, mode }),
    ]);

    let winner: "A" | "B" | "tie" = "tie";
    if (skillA.passRate > skillB.passRate) winner = "A";
    else if (skillB.passRate > skillA.passRate) winner = "B";
    else if (skillA.accuracy > skillB.accuracy) winner = "A";
    else if (skillB.accuracy > skillA.accuracy) winner = "B";

    return { skillA, skillB, winner };
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private buildReport(skillPath: string, mode: EvalMode, result: EvalOnlyResult): EvalReport {
    const passedCases = result.cases.filter((c) => c.pass).length;
    return {
      skillPath,
      mode,
      passRate: result.passRate,
      accuracy: result.accuracy,
      avgSteps: result.avgSteps,
      totalCases: result.cases.length,
      passedCases,
      failedCases: result.cases.length - passedCases,
      timestamp: new Date().toISOString(),
    };
  }
}

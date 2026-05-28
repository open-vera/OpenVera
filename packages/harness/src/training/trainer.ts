/**
 * Trainer — Orchestrates SkillOpt training runs with monitoring and checkpoint resume.
 *
 * Wraps SkillOptAdapter to provide a higher-level training API with
 * progress tracking, checkpoint management, and automatic retry.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SkillOptAdapter } from "./skill-opt-adapter.js";
import type { SkillOptConfig, TrainingRun, TrainingEpoch } from "./skill-opt-adapter.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TrainerConfig extends SkillOptConfig {
  /** Base output directory for all runs */
  outputBaseDir: string;
  /** Maximum retries on failure */
  maxRetries?: number;
  /** Callback for progress updates */
  onProgress?: (update: TrainingProgress) => void;
}

export interface TrainingProgress {
  runName: string;
  epoch: number;
  totalEpochs: number;
  loss: number;
  accuracy: number;
  bestSkillUpdated: boolean;
  elapsedMs: number;
}

export interface TrainOptions {
  /** Name for this training run */
  runName: string;
  /** Path to prepared data directory (containing train/val/test) */
  dataDir: string;
  /** Resume from a checkpoint */
  resumeFrom?: string;
  /** Override number of epochs for this run */
  epochs?: number;
}

// ── Trainer ──────────────────────────────────────────────────────────────────

export class Trainer {
  private adapter: SkillOptAdapter;
  private config: TrainerConfig;

  constructor(config: TrainerConfig) {
    this.config = config;
    this.adapter = new SkillOptAdapter(config);
  }

  /**
   * Run a training job.
   */
  async train(options: TrainOptions): Promise<TrainingRun> {
    const runName = options.runName;
    const outputDir = join(this.config.outputBaseDir, runName);

    // Check for existing checkpoint
    if (options.resumeFrom) {
      const checkpointDir = join(this.config.outputBaseDir, options.resumeFrom);
      if (!existsSync(checkpointDir)) {
        throw new Error(`Checkpoint not found: ${checkpointDir}`);
      }
    }

    const startTime = Date.now();
    const totalEpochs = options.epochs ?? this.config.numEpochs ?? 5;

    let lastRun: TrainingRun | null = null;
    let attempt = 0;
    const maxRetries = this.config.maxRetries ?? 0;

    while (attempt <= maxRetries) {
      try {
        lastRun = await this.adapter.train(options.dataDir, runName, {
          resumeFrom: options.resumeFrom,
          onEpochComplete: (epoch: TrainingEpoch) => {
            if (this.config.onProgress) {
              this.config.onProgress({
                runName,
                epoch: epoch.epoch,
                totalEpochs,
                loss: epoch.loss,
                accuracy: epoch.accuracy,
                bestSkillUpdated: epoch.bestSkillUpdated,
                elapsedMs: Date.now() - startTime,
              });
            }
          },
        });

        if (lastRun.status === "completed") {
          return lastRun;
        }

        if (lastRun.status === "failed" && attempt < maxRetries) {
          attempt++;
          continue;
        }

        return lastRun;
      } catch (err) {
        if (attempt < maxRetries) {
          attempt++;
          continue;
        }
        throw err;
      }
    }

    return lastRun!;
  }

  /**
   * Check if a run checkpoint exists and can be resumed.
   */
  canResume(runName: string): boolean {
    const statePath = join(this.config.outputBaseDir, runName, "runtime_state.json");
    return existsSync(statePath);
  }

  /**
   * Get checkpoint info for a run.
   */
  getCheckpointInfo(runName: string): { completedEpochs: number; hasBestSkill: boolean } | null {
    const statePath = join(this.config.outputBaseDir, runName, "runtime_state.json");
    if (!existsSync(statePath)) return null;

    try {
      const state = JSON.parse(readFileSync(statePath, "utf-8")) as {
        completed_epochs?: number;
        best_skill_path?: string;
      };
      return {
        completedEpochs: state.completed_epochs ?? 0,
        hasBestSkill: !!state.best_skill_path,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get the current adapter instance.
   */
  getAdapter(): SkillOptAdapter {
    return this.adapter;
  }
}

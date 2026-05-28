/**
 * SkillOpt Adapter — Interface to the SkillOpt Python training framework.
 *
 * SkillOpt trains agent skills like neural networks using epochs, batch sizes,
 * and validation gates. This adapter wraps the Python CLI for TypeScript integration.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SkillOptConfig {
  /** Path to SkillOpt installation (directory containing train.py) */
  skillOptPath: string;
  /** Optimizer model (e.g., "gpt-4", "claude-3-opus") */
  optimizerModel: string;
  /** Target model being trained (e.g., "gpt-4o-mini") */
  targetModel: string;
  /** Number of training epochs */
  numEpochs?: number;
  /** Batch size */
  batchSize?: number;
  /** Number of parallel workers */
  workers?: number;
  /** Learning rate */
  learningRate?: number;
  /** API key for the optimizer model */
  apiKey?: string;
  /** API base URL (for Azure or custom endpoints) */
  apiBaseUrl?: string;
}

export interface TrainingRun {
  /** Unique run name */
  runName: string;
  /** Path to output directory */
  outputDir: string;
  /** Training status */
  status: "pending" | "running" | "completed" | "failed";
  /** Current epoch */
  currentEpoch: number;
  /** Total epochs */
  totalEpochs: number;
  /** Best skill content (if completed) */
  bestSkill?: string;
  /** Training history */
  history: TrainingEpoch[];
  /** Error message if failed */
  error?: string;
}

export interface TrainingEpoch {
  epoch: number;
  loss: number;
  accuracy: number;
  bestSkillUpdated: boolean;
  durationMs: number;
}

export interface EvalOnlyResult {
  /** Evaluation mode */
  mode: "valid_unseen" | "valid_seen" | "train" | "all";
  /** Pass rate */
  passRate: number;
  /** Accuracy */
  accuracy: number;
  /** Average steps per task */
  avgSteps: number;
  /** Individual case results */
  cases: Array<{ id: string; pass: boolean; steps: number }>;
}

// ── SkillOpt Adapter ─────────────────────────────────────────────────────────

export class SkillOptAdapter {
  private config: Required<SkillOptConfig>;
  private currentRun: TrainingRun | null = null;

  constructor(config: SkillOptConfig) {
    if (!config.skillOptPath) throw new Error("skillOptPath is required");
    if (!existsSync(config.skillOptPath)) {
      throw new Error(`SkillOpt path does not exist: ${config.skillOptPath}`);
    }

    this.config = {
      skillOptPath: config.skillOptPath,
      optimizerModel: config.optimizerModel,
      targetModel: config.targetModel,
      numEpochs: config.numEpochs ?? 5,
      batchSize: config.batchSize ?? 8,
      workers: config.workers ?? 4,
      learningRate: config.learningRate ?? 0.1,
      apiKey: config.apiKey ?? "",
      apiBaseUrl: config.apiBaseUrl ?? "",
    };
  }

  /**
   * Start a training run.
   */
  async train(
    dataDir: string,
    runName: string,
    options?: {
      resumeFrom?: string;
      onEpochComplete?: (epoch: TrainingEpoch) => void;
    },
  ): Promise<TrainingRun> {
    const outputDir = join(this.config.skillOptPath, "outputs", runName);

    this.currentRun = {
      runName,
      outputDir,
      status: "running",
      currentEpoch: 0,
      totalEpochs: this.config.numEpochs,
      history: [],
    };

    try {
      const args = [
        join(this.config.skillOptPath, "train.py"),
        "--data-dir", dataDir,
        "--output-dir", outputDir,
        "--optimizer-model", this.config.optimizerModel,
        "--target-model", this.config.targetModel,
        "--epochs", String(this.config.numEpochs),
        "--batch-size", String(this.config.batchSize),
        "--workers", String(this.config.workers),
        "--learning-rate", String(this.config.learningRate),
      ];

      if (this.config.apiKey) {
        args.push("--api-key", this.config.apiKey);
      }
      if (this.config.apiBaseUrl) {
        args.push("--api-base-url", this.config.apiBaseUrl);
      }
      if (options?.resumeFrom) {
        args.push("--resume-from", options.resumeFrom);
      }

      const result = execFileSync("python3", args, {
        cwd: this.config.skillOptPath,
        encoding: "utf-8",
        timeout: 3600_000, // 1 hour max
        env: {
          ...process.env,
          ...(this.config.apiKey ? { OPENAI_API_KEY: this.config.apiKey } : {}),
        },
      });

      // Parse training output
      this.currentRun.status = "completed";
      this.currentRun.bestSkill = this.extractBestSkill(outputDir);
      this.currentRun.history = this.parseHistory(outputDir);
      this.currentRun.currentEpoch = this.currentRun.history.length;
    } catch (err) {
      this.currentRun.status = "failed";
      this.currentRun.error = err instanceof Error ? err.message : String(err);
    }

    return { ...this.currentRun };
  }

  /**
   * Run evaluation only (no training).
   */
  async evaluate(
    skillPath: string,
    dataDir: string,
    mode: "valid_unseen" | "valid_seen" | "train" | "all" = "valid_unseen",
  ): Promise<EvalOnlyResult> {
    const args = [
      join(this.config.skillOptPath, "eval_only.py"),
      "--skill", skillPath,
      "--data-dir", dataDir,
      "--mode", mode,
      "--target-model", this.config.targetModel,
    ];

    if (this.config.apiKey) {
      args.push("--api-key", this.config.apiKey);
    }

    const result = execFileSync("python3", args, {
      cwd: this.config.skillOptPath,
      encoding: "utf-8",
      timeout: 600_000,
    });

    return this.parseEvalResult(result);
  }

  /**
   * Get the current training run.
   */
  getCurrentRun(): TrainingRun | null {
    return this.currentRun;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private extractBestSkill(outputDir: string): string | undefined {
    const skillPath = join(outputDir, "best_skill.md");
    if (existsSync(skillPath)) {
      return readFileSync(skillPath, "utf-8");
    }
    return undefined;
  }

  private parseHistory(outputDir: string): TrainingEpoch[] {
    const historyPath = join(outputDir, "history.json");
    if (existsSync(historyPath)) {
      try {
        const content = readFileSync(historyPath, "utf-8");
        return JSON.parse(content) as TrainingEpoch[];
      } catch {
        return [];
      }
    }
    return [];
  }

  private parseEvalResult(output: string): EvalOnlyResult {
    try {
      return JSON.parse(output) as EvalOnlyResult;
    } catch {
      return {
        mode: "valid_unseen",
        passRate: 0,
        accuracy: 0,
        avgSteps: 0,
        cases: [],
      };
    }
  }
}

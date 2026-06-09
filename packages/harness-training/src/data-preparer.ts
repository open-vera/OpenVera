/**
 * Data Preparer — Converts Vera task/evaluation data into SkillOpt training format.
 *
 * Supports multiple dataset formats: SearchQA, ALFWorld, DocVQA,
 * LiveMathematicianBench, OfficeQA. Generates train/val/test split directories.
 */

import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export type DatasetFormat =
  | "searchqa"
  | "alfworld"
  | "docvqa"
  | "livemath"
  | "officeqa"
  | "vera-custom";

export interface DataSample {
  id: string;
  input: string;
  output: string;
  metadata?: Record<string, unknown>;
}

export interface DataSplit {
  train: DataSample[];
  val: DataSample[];
  test: DataSample[];
}

export interface PrepareOptions {
  /** Source data directory or file */
  sourcePath: string;
  /** Output directory for train/val/test splits */
  outputDir: string;
  /** Dataset format for parsing */
  format: DatasetFormat;
  /** Train/val/test split ratios (must sum to 1) */
  splitRatio?: { train: number; val: number; test: number };
  /** Random seed for reproducible splits */
  seed?: number;
  /** Maximum samples to include (0 = all) */
  maxSamples?: number;
}

export interface PrepareResult {
  outputDir: string;
  totalSamples: number;
  trainCount: number;
  valCount: number;
  testCount: number;
  format: DatasetFormat;
}

// ── Data Preparer ────────────────────────────────────────────────────────────

export class DataPreparer {
  private readonly defaultSplit = { train: 0.8, val: 0.1, test: 0.1 };

  /**
   * Prepare data for SkillOpt training.
   */
  prepare(options: PrepareOptions): PrepareResult {
    const splitRatio = options.splitRatio ?? this.defaultSplit;
    this.validateSplitRatio(splitRatio);

    const samples = this.loadSamples(options.sourcePath, options.format, options.maxSamples);
    const split = this.splitData(samples, splitRatio, options.seed);
    this.writeSplit(options.outputDir, split);

    return {
      outputDir: options.outputDir,
      totalSamples: samples.length,
      trainCount: split.train.length,
      valCount: split.val.length,
      testCount: split.test.length,
      format: options.format,
    };
  }

  /**
   * Load samples from Vera custom JSON format.
   */
  loadVeraCustom(filePath: string): DataSample[] {
    const content = readFileSync(filePath, "utf-8");
    const cases = JSON.parse(content) as Array<{
      id: string;
      prompt: string;
      expected?: string;
      description?: string;
      level?: number;
      evalType?: string;
    }>;

    return cases.map((c) => ({
      id: c.id,
      input: c.prompt,
      output: c.expected ?? "",
      metadata: {
        description: c.description,
        level: c.level,
        evalType: c.evalType,
      },
    }));
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private loadSamples(
    sourcePath: string,
    format: DatasetFormat,
    maxSamples?: number,
  ): DataSample[] {
    let samples: DataSample[];

    switch (format) {
      case "vera-custom":
        samples = this.loadVeraCustom(sourcePath);
        break;
      case "searchqa":
        samples = this.loadSearchQA(sourcePath);
        break;
      case "alfworld":
        samples = this.loadALFWorld(sourcePath);
        break;
      case "docvqa":
        samples = this.loadDocVQA(sourcePath);
        break;
      case "livemath":
        samples = this.loadLiveMath(sourcePath);
        break;
      case "officeqa":
        samples = this.loadOfficeQA(sourcePath);
        break;
      default:
        throw new Error(`Unsupported format: ${format}`);
    }

    if (maxSamples && maxSamples > 0 && samples.length > maxSamples) {
      samples = samples.slice(0, maxSamples);
    }

    return samples;
  }

  private loadSearchQA(sourcePath: string): DataSample[] {
    return this.loadGenericQA(sourcePath);
  }

  private loadALFWorld(sourcePath: string): DataSample[] {
    if (!existsSync(sourcePath)) return [];
    const content = readFileSync(sourcePath, "utf-8");
    const data = JSON.parse(content) as Array<{
      task_id?: string;
      id?: string;
      goal?: string;
      input?: string;
      solution?: string;
      output?: string;
    }>;

    return data.map((d, i) => ({
      id: d.task_id ?? d.id ?? `alfworld-${i}`,
      input: d.goal ?? d.input ?? "",
      output: d.solution ?? d.output ?? "",
    }));
  }

  private loadDocVQA(sourcePath: string): DataSample[] {
    return this.loadGenericQA(sourcePath);
  }

  private loadLiveMath(sourcePath: string): DataSample[] {
    return this.loadGenericQA(sourcePath);
  }

  private loadOfficeQA(sourcePath: string): DataSample[] {
    return this.loadGenericQA(sourcePath);
  }

  private loadGenericQA(sourcePath: string): DataSample[] {
    if (!existsSync(sourcePath)) return [];

    if (sourcePath.endsWith(".json")) {
      const content = readFileSync(sourcePath, "utf-8");
      const data = JSON.parse(content) as Array<Record<string, unknown>>;
      return data.map((d, i) => ({
        id: (d.id as string) ?? `sample-${i}`,
        input: (d.input as string) ?? (d.question as string) ?? (d.prompt as string) ?? "",
        output: (d.output as string) ?? (d.answer as string) ?? (d.expected as string) ?? "",
      }));
    }

    if (sourcePath.endsWith(".jsonl")) {
      const lines = readFileSync(sourcePath, "utf-8").trim().split("\n");
      return lines.map((line, i) => {
        const d = JSON.parse(line) as Record<string, unknown>;
        return {
          id: (d.id as string) ?? `sample-${i}`,
          input: (d.input as string) ?? (d.question as string) ?? "",
          output: (d.output as string) ?? (d.answer as string) ?? "",
        };
      });
    }

    // Directory of JSON files
    if (existsSync(sourcePath) && readdirSync(sourcePath).length > 0) {
      const files = readdirSync(sourcePath).filter((f) => f.endsWith(".json"));
      const samples: DataSample[] = [];
      for (const file of files) {
        const content = readFileSync(join(sourcePath, file), "utf-8");
        const data = JSON.parse(content) as Record<string, unknown>;
        samples.push({
          id: (data.id as string) ?? file,
          input: (data.input as string) ?? (data.question as string) ?? "",
          output: (data.output as string) ?? (data.answer as string) ?? "",
        });
      }
      return samples;
    }

    return [];
  }

  private splitData(
    samples: DataSample[],
    ratio: { train: number; val: number; test: number },
    seed?: number,
  ): DataSplit {
    const shuffled = this.shuffle([...samples], seed);
    const trainEnd = Math.floor(shuffled.length * ratio.train);
    const valEnd = trainEnd + Math.floor(shuffled.length * ratio.val);

    return {
      train: shuffled.slice(0, trainEnd),
      val: shuffled.slice(trainEnd, valEnd),
      test: shuffled.slice(valEnd),
    };
  }

  private shuffle<T>(arr: T[], seed?: number): T[] {
    const rng = this.createRNG(seed ?? Date.now());
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  private createRNG(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) & 0xffffffff;
      return (s >>> 0) / 0xffffffff;
    };
  }

  private writeSplit(outputDir: string, split: DataSplit): void {
    mkdirSync(outputDir, { recursive: true });

    for (const [name, samples] of Object.entries(split) as [string, DataSample[]][]) {
      const dir = join(outputDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "data.json"), JSON.stringify(samples, null, 2), "utf-8");
    }
  }

  private validateSplitRatio(ratio: { train: number; val: number; test: number }): void {
    const sum = ratio.train + ratio.val + ratio.test;
    if (Math.abs(sum - 1) > 0.001) {
      throw new Error(`Split ratios must sum to 1, got ${sum}`);
    }
  }
}

/**
 * Skill Importer — Imports trained best_skill.md files as Vera skills.
 *
 * Generates SKILL.md metadata, manages versions, and supports A/B comparison.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SkillMetadata {
  name: string;
  version: number;
  description: string;
  trainedFrom: string;
  trainedAt: string;
  passRate?: number;
  accuracy?: number;
  tags: string[];
}

export interface ImportOptions {
  /** Path to best_skill.md from training output */
  skillPath: string;
  /** Target directory for the imported skill */
  targetDir: string;
  /** Skill name (defaults to filename-based) */
  name?: string;
  /** Description for SKILL.md */
  description?: string;
  /** Tags for categorization */
  tags?: string[];
  /** Training run metadata */
  trainingMeta?: {
    runName: string;
    passRate?: number;
    accuracy?: number;
  };
}

export interface ImportResult {
  skillDir: string;
  skillMdPath: string;
  metadataPath: string;
  metadata: SkillMetadata;
}

export interface TrainedSkillVersion {
  version: number;
  path: string;
  trainedAt: string;
  passRate?: number;
}

// ── Skill Importer ──────────────────────────────────────────────────────────

export class SkillImporter {
  /**
   * Import a trained skill into the Vera skill directory.
   */
  import(options: ImportOptions): ImportResult {
    if (!existsSync(options.skillPath)) {
      throw new Error(`Skill file not found: ${options.skillPath}`);
    }

    const skillContent = readFileSync(options.skillPath, "utf-8");
    const name = options.name ?? this.deriveName(options.skillPath);
    const targetDir = join(options.targetDir, name);

    mkdirSync(targetDir, { recursive: true });

    const version = this.getNextVersion(targetDir);

    const metadata: SkillMetadata = {
      name,
      version,
      description: options.description ?? `Trained skill: ${name}`,
      trainedFrom: options.trainingMeta?.runName ?? options.skillPath,
      trainedAt: new Date().toISOString(),
      passRate: options.trainingMeta?.passRate,
      accuracy: options.trainingMeta?.accuracy,
      tags: options.tags ?? ["trained", "skillopt"],
    };

    // Write SKILL.md with metadata header
    const skillMdContent = this.buildSkillMd(skillContent, metadata);
    const skillMdPath = join(targetDir, "SKILL.md");
    writeFileSync(skillMdPath, skillMdContent, "utf-8");

    // Write metadata JSON
    const metadataPath = join(targetDir, "metadata.json");
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");

    return { skillDir: targetDir, skillMdPath, metadataPath, metadata };
  }

  /**
   * List all versions of a skill.
   */
  listVersions(targetDir: string, skillName: string): TrainedSkillVersion[] {
    const skillDir = join(targetDir, skillName);
    if (!existsSync(skillDir)) return [];

    const metadataPath = join(skillDir, "metadata.json");
    if (!existsSync(metadataPath)) return [];

    try {
      const meta = JSON.parse(readFileSync(metadataPath, "utf-8")) as SkillMetadata;
      return [{
        version: meta.version,
        path: skillDir,
        trainedAt: meta.trainedAt,
        passRate: meta.passRate,
      }];
    } catch {
      return [];
    }
  }

  /**
   * Compare two skill versions.
   */
  compare(skillDirA: string, skillDirB: string): {
    nameA: string;
    nameB: string;
    versionA: number;
    versionB: number;
    passRateDiff: number;
    accuracyDiff: number;
  } | null {
    const metaA = this.loadMetadata(skillDirA);
    const metaB = this.loadMetadata(skillDirB);
    if (!metaA || !metaB) return null;

    return {
      nameA: metaA.name,
      nameB: metaB.name,
      versionA: metaA.version,
      versionB: metaB.version,
      passRateDiff: (metaB.passRate ?? 0) - (metaA.passRate ?? 0),
      accuracyDiff: (metaB.accuracy ?? 0) - (metaA.accuracy ?? 0),
    };
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private deriveName(skillPath: string): string {
    const file = basename(skillPath, ".md");
    // Extract run name from path like outputs/run-name/best_skill.md
    return file === "best_skill" ? "trained-skill" : file;
  }

  private getNextVersion(targetDir: string): number {
    const metadataPath = join(targetDir, "metadata.json");
    if (!existsSync(metadataPath)) return 1;

    try {
      const meta = JSON.parse(readFileSync(metadataPath, "utf-8")) as SkillMetadata;
      return (meta.version ?? 0) + 1;
    } catch {
      return 1;
    }
  }

  private buildSkillMd(content: string, meta: SkillMetadata): string {
    const lines = [
      "---",
      `name: ${meta.name}`,
      `version: ${meta.version}`,
      `description: ${meta.description}`,
      `trained_from: ${meta.trainedFrom}`,
      `trained_at: ${meta.trainedAt}`,
      `tags: [${meta.tags.join(", ")}]`,
      ...(meta.passRate !== undefined ? [`pass_rate: ${meta.passRate}`] : []),
      ...(meta.accuracy !== undefined ? [`accuracy: ${meta.accuracy}`] : []),
      "---",
      "",
      content,
    ];
    return lines.join("\n");
  }

  private loadMetadata(skillDir: string): SkillMetadata | null {
    const metadataPath = join(skillDir, "metadata.json");
    if (!existsSync(metadataPath)) return null;

    try {
      return JSON.parse(readFileSync(metadataPath, "utf-8")) as SkillMetadata;
    } catch {
      return null;
    }
  }
}

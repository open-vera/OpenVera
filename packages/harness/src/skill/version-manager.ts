/**
 * Skill Version Manager (SK4)
 *
 * Tracks skill definition changes over time, providing:
 * - Version snapshots with timestamps
 * - Diff between versions
 * - Rollback to any previous version
 * - Version history querying
 */

import type { Skill } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** A versioned snapshot of a skill definition. */
export interface SkillVersion {
  /** Skill ID. */
  skillId: string;
  /** Monotonically increasing version number. */
  version: number;
  /** ISO timestamp when this version was created. */
  timestamp: string;
  /** The full skill definition at this version. */
  snapshot: SkillSnapshot;
  /** Optional description of what changed. */
  changeDescription?: string;
}

/** Serializable snapshot of a skill (no executor references). */
export interface SkillSnapshot {
  id: string;
  name: string;
  description: string;
  triggers: Skill["triggers"];
  systemFragment?: string;
  /** Tool names (not full definitions, since executors aren't serializable). */
  toolNames: string[];
}

/** Summary of differences between two skill versions. */
export interface SkillDiff {
  skillId: string;
  fromVersion: number;
  toVersion: number;
  changes: DiffEntry[];
}

/** A single change in a diff. */
export interface DiffEntry {
  field: string;
  type: "added" | "removed" | "changed";
  oldValue?: unknown;
  newValue?: unknown;
}

// ── SkillVersionManager ───────────────────────────────────────────────────────

export class SkillVersionManager {
  /** skillId → ordered version history (newest last). */
  private history: Map<string, SkillVersion[]> = new Map();

  /**
   * Record a new version of a skill.
   * Returns the new version number.
   */
  recordVersion(
    skill: Skill,
    changeDescription?: string
  ): number {
    const snapshot = this.toSnapshot(skill);
    const versions = this.history.get(skill.id) ?? [];
    const nextVersion = versions.length > 0 ? versions[versions.length - 1]!.version + 1 : 1;

    const entry: SkillVersion = {
      skillId: skill.id,
      version: nextVersion,
      timestamp: new Date().toISOString(),
      snapshot,
      changeDescription,
    };

    versions.push(entry);
    this.history.set(skill.id, versions);

    return nextVersion;
  }

  /** Get the latest version of a skill, or null if not tracked. */
  getLatest(skillId: string): SkillVersion | null {
    const versions = this.history.get(skillId);
    if (!versions || versions.length === 0) return null;
    return versions[versions.length - 1]!;
  }

  /** Get a specific version of a skill. */
  getVersion(skillId: string, version: number): SkillVersion | null {
    const versions = this.history.get(skillId);
    if (!versions) return null;
    return versions.find((v) => v.version === version) ?? null;
  }

  /** Get the full version history for a skill (newest first). */
  getHistory(skillId: string): SkillVersion[] {
    const versions = this.history.get(skillId);
    if (!versions) return [];
    return [...versions].reverse();
  }

  /** Get the total number of versions for a skill. */
  getVersionCount(skillId: string): number {
    return this.history.get(skillId)?.length ?? 0;
  }

  /** List all tracked skill IDs. */
  listSkillIds(): string[] {
    return [...this.history.keys()];
  }

  /**
   * Compute the diff between two versions of a skill.
   * If toVersion is omitted, compares with the latest.
   */
  diff(skillId: string, fromVersion: number, toVersion?: number): SkillDiff | null {
    const from = this.getVersion(skillId, fromVersion);
    const to = toVersion
      ? this.getVersion(skillId, toVersion)
      : this.getLatest(skillId);

    if (!from || !to) return null;

    const changes: DiffEntry[] = [];
    this.compareField("name", from.snapshot.name, to.snapshot.name, changes);
    this.compareField("description", from.snapshot.description, to.snapshot.description, changes);
    this.compareField("systemFragment", from.snapshot.systemFragment, to.snapshot.systemFragment, changes);
    this.compareArrayField("triggers", from.snapshot.triggers, to.snapshot.triggers, changes);
    this.compareArrayField("toolNames", from.snapshot.toolNames, to.snapshot.toolNames, changes);

    return {
      skillId,
      fromVersion: from.version,
      toVersion: to.version,
      changes,
    };
  }

  /**
   * Rollback a skill to a previous version.
   * Returns the snapshot of the target version, or null if not found.
   */
  rollback(skillId: string, targetVersion: number): SkillSnapshot | null {
    const target = this.getVersion(skillId, targetVersion);
    if (!target) return null;

    // Record the rollback as a new version
    const rollbackSkill: Skill = {
      id: target.snapshot.id,
      name: target.snapshot.name,
      description: target.snapshot.description,
      triggers: target.snapshot.triggers,
      systemFragment: target.snapshot.systemFragment,
    };

    this.recordVersion(rollbackSkill, `Rollback to version ${targetVersion}`);
    return target.snapshot;
  }

  /** Convert a Skill to a serializable snapshot. */
  private toSnapshot(skill: Skill): SkillSnapshot {
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      triggers: [...skill.triggers],
      systemFragment: skill.systemFragment,
      toolNames: skill.tools?.map((t) => t.definition.name) ?? [],
    };
  }

  /** Compare scalar fields. */
  private compareField(
    field: string,
    oldVal: unknown,
    newVal: unknown,
    changes: DiffEntry[]
  ): void {
    if (oldVal === newVal) return;
    if (oldVal === undefined && newVal !== undefined) {
      changes.push({ field, type: "added", newValue: newVal });
    } else if (oldVal !== undefined && newVal === undefined) {
      changes.push({ field, type: "removed", oldValue: oldVal });
    } else {
      changes.push({ field, type: "changed", oldValue: oldVal, newValue: newVal });
    }
  }

  /** Compare array fields. */
  private compareArrayField(
    field: string,
    oldVal: unknown[],
    newVal: unknown[],
    changes: DiffEntry[]
  ): void {
    const oldStr = JSON.stringify(oldVal);
    const newStr = JSON.stringify(newVal);
    if (oldStr !== newStr) {
      changes.push({ field, type: "changed", oldValue: oldVal, newValue: newVal });
    }
  }
}

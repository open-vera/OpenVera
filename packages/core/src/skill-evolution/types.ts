/**
 * Skill Evolution Types — Phase 20D
 *
 * Type definitions for SkillAutoCreator (OC13), SkillReflector (OC14),
 * VersionManager (OC15), and SkillFilter (OC16).
 */

// ── Skill Template (OC13) ────────────────────────────────────────────────

export interface SkillTemplate {
  /** Skill name (kebab-case) */
  name: string;
  /** One-line description */
  description: string;
  /** Trigger conditions — when to invoke this skill */
  triggers: string[];
  /** Steps to execute the skill */
  steps: string[];
  /** Required tools (Bash, Read, etc.) */
  allowedTools: string[];
  /** Argument hints for the skill */
  argumentHint?: string;
  /** Source task ID or description that inspired this skill */
  sourceTask: string;
  /** Confidence score 0-1 that this template is reusable */
  confidence: number;
}

export interface AutoCreatorOptions {
  /** Minimum task rounds before extraction attempt. Default: 3 */
  minRounds?: number;
  /** Minimum confidence to output a template. Default: 0.6 */
  minConfidence?: number;
  /** LLM adapter for analysis */
  adapter: LLMAdapter;
  /** Model to use */
  model: string;
}

export interface AutoCreatorResult {
  /** Whether extraction was triggered (false if below round threshold) */
  triggered: boolean;
  /** Extracted skill templates */
  templates: SkillTemplate[];
}

// ── Skill Reflection (OC14) ──────────────────────────────────────────────

export interface ReflectionIssue {
  /** Issue severity */
  severity: "high" | "medium" | "low";
  /** Issue category */
  category: "clarity" | "coverage" | "correctness" | "efficiency";
  /** Description of the issue */
  description: string;
  /** Suggested fix */
  suggestion: string;
}

export interface SkillReflection {
  /** Skill name analyzed */
  skillName: string;
  /** Overall quality score 0-1 */
  qualityScore: number;
  /** Issues found */
  issues: ReflectionIssue[];
  /** Whether the skill needs updates */
  needsUpdate: boolean;
  /** Suggested version bump type */
  bumpType?: "major" | "minor" | "patch";
}

export interface ReflectorOptions {
  /** LLM adapter for analysis */
  adapter: LLMAdapter;
  /** Model to use */
  model: string;
  /** Minimum quality score to skip update. Default: 0.8 */
  minQuality?: number;
}

// ── Version Manager (OC15) ───────────────────────────────────────────────

export interface SkillVersion {
  /** Current version (semver) */
  version: string;
  /** Version history entries */
  history: VersionEntry[];
}

export interface VersionEntry {
  /** Version number */
  version: string;
  /** What changed */
  changes: string[];
  /** When this version was created (ISO timestamp) */
  timestamp: string;
  /** Source of the change (reflection, manual, auto-create) */
  source: "reflection" | "manual" | "auto-create";
}

export interface VersionUpdateResult {
  /** Whether an update was applied */
  updated: boolean;
  /** Previous version */
  previousVersion?: string;
  /** New version */
  newVersion?: string;
  /** Changes applied */
  changes?: string[];
}

// ── Skill Filter (OC16) ──────────────────────────────────────────────────

export type SkillOrigin = "system" | "brand" | "user" | "marketplace";

export interface SkillMetadata {
  /** Skill name */
  name: string;
  /** Origin of the skill */
  origin: SkillOrigin;
  /** Whether auto-evolution is allowed */
  evolvable: boolean;
}

export interface FilterOptions {
  /** Origins that are allowed to evolve. Default: ["user", "marketplace"] */
  evolvableOrigins?: SkillOrigin[];
}

// ── Re-export LLMAdapter type (avoid circular dep) ───────────────────────

import type { LLMAdapter } from "../adapters/base.js";

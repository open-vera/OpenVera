import type {
  PromptTemplate,
  PromptProfile,
  PromptIntent,
  RenderedPrompt,
} from "./types.js";
import { renderTemplate } from "./renderer.js";
import {
  BUILTIN_TEMPLATES,
  BUILTIN_PROFILES,
} from "./builtins.js";

/**
 * Central registry for prompt templates and profiles.
 *
 * Holds templates (versioned) and profiles in memory.
 * Built-in defaults are registered automatically.
 * Additional templates/profiles can be loaded from disk via the loader helpers.
 */
export class PromptStore {
  /** templateId → sorted versions (newest first) */
  private templates: Map<string, PromptTemplate[]> = new Map();
  /** profileId → profile */
  private profiles: Map<string, PromptProfile> = new Map();

  constructor() {
    for (const t of BUILTIN_TEMPLATES) this.addTemplate(t);
    for (const p of BUILTIN_PROFILES) this.addProfile(p);
  }

  // ── Templates ──────────────────────────────────────────────────────────────

  /** Register a template version. */
  addTemplate(template: PromptTemplate): void {
    const versions = this.templates.get(template.id) ?? [];
    const existing = versions.findIndex(
      (t) => t.version === template.version
    );
    if (existing >= 0) {
      versions[existing] = template;
    } else {
      versions.push(template);
    }
    versions.sort((a, b) => b.version - a.version);
    this.templates.set(template.id, versions);
  }

  /** Get the latest (or specific) version of a template. */
  getTemplate(
    id: string,
    version?: number
  ): PromptTemplate | undefined {
    const versions = this.templates.get(id);
    if (!versions || versions.length === 0) return undefined;
    if (version !== undefined) {
      return versions.find((t) => t.version === version);
    }
    return versions[0]; // newest
  }

  /** List all registered template IDs. */
  listTemplates(): PromptTemplate[] {
    return [...this.templates.values()].map((v) => v[0]!);
  }

  /** Return sorted version numbers for a template. */
  getVersionHistory(id: string): number[] {
    const versions = this.templates.get(id);
    if (!versions) return [];
    return versions.map((t) => t.version);
  }

  /** Produce a simple diff description between two versions. */
  diffVersions(id: string, v1: number, v2: number): string | null {
    const a = this.getTemplate(id, v1);
    const b = this.getTemplate(id, v2);
    if (!a || !b) return null;

    const aNames = new Set(a.sections.map((s) => s.name));
    const bNames = new Set(b.sections.map((s) => s.name));

    const lines: string[] = [];
    const added = [...bNames].filter((n) => !aNames.has(n));
    const removed = [...aNames].filter((n) => !bNames.has(n));

    if (added.length) lines.push(`+ sections: ${added.join(", ")}`);
    if (removed.length) lines.push(`- sections: ${removed.join(", ")}`);
    if (!added.length && !removed.length) {
      lines.push("Content changes within existing sections (no section add/remove)");
    }
    return lines.join("\n");
  }

  // ── Profiles ───────────────────────────────────────────────────────────────

  /** Register a profile. */
  addProfile(profile: PromptProfile): void {
    this.profiles.set(profile.id, profile);
  }

  /** Get a profile by id. */
  getProfile(id: string): PromptProfile | undefined {
    return this.profiles.get(id);
  }

  /** List all profiles. */
  listProfiles(): PromptProfile[] {
    return [...this.profiles.values()];
  }

  // ── Resolution ─────────────────────────────────────────────────────────────

  /**
   * Resolve the best matching profile for an intent, then render its template.
   *
   * Matching strategy (first wins):
   * 1. Explicit profileId override
   * 2. Profiles with conditions that match the intent (most specific first)
   * 3. Fallback "general" profile
   */
  resolve(
    intent: PromptIntent,
    overrides?: { profileId?: string; variables?: Record<string, string> }
  ): RenderedPrompt | null {
    let profile: PromptProfile | undefined;

    if (overrides?.profileId) {
      profile = this.profiles.get(overrides.profileId);
    }

    if (!profile) {
      // Filter profiles with conditions that match the intent
      const candidates = [...this.profiles.values()]
        .filter((p) => p.conditions && this.matchesProfile(p, intent))
        // Sort by specificity: more conditions = more specific
        .sort((a, b) => this.conditionCount(b) - this.conditionCount(a));

      profile = candidates[0];
    }

    // Fallback to general
    if (!profile) {
      profile = this.profiles.get("general");
    }

    if (!profile) return null;

    const template = this.getTemplate(
      profile.templateId,
      profile.templateVersion
    );
    if (!template) return null;

    // Merge profile variable overrides with call-site overrides
    const variables: Record<string, string> = {
      ...profile.variables,
      ...overrides?.variables,
    };

    const system = renderTemplate(
      template,
      intent,
      variables,
      (id) => this.getTemplate(id)
    );

    return {
      system,
      templateId: template.id,
      templateVersion: template.version,
      profileId: profile.id,
      ...(profile.maxTurns !== undefined ? { maxTurns: profile.maxTurns } : {}),
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private matchesProfile(
    profile: PromptProfile,
    intent: PromptIntent
  ): boolean {
    const c = profile.conditions;
    if (!c) return false;
    if (c.domain && !c.domain.includes(intent.domain)) return false;
    if (c.minLevel !== undefined && intent.level < c.minLevel) return false;
    if (c.needsTools !== undefined && intent.needs_tools !== c.needsTools)
      return false;
    return true;
  }

  private conditionCount(profile: PromptProfile): number {
    const c = profile.conditions;
    if (!c) return 0;
    let n = 0;
    if (c.domain) n++;
    if (c.minLevel !== undefined) n++;
    if (c.needsTools !== undefined) n++;
    return n;
  }
}

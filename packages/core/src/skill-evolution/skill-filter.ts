/**
 * SkillFilter — OC16
 *
 * Determines whether a skill is eligible for automatic evolution.
 * System skills (default/brand) are protected from auto-modification;
 * only user-created and marketplace-installed skills can evolve.
 *
 * Skill origin is determined by:
 * 1. Frontmatter `origin` field in SKILL.md
 * 2. Directory location (.claude/skills/ vs system paths)
 * 3. Name prefix conventions (brand skills often have company prefix)
 */

import type { SkillOrigin, SkillMetadata, FilterOptions } from "./types.js";

const DEFAULT_EVOLVABLE_ORIGINS: SkillOrigin[] = ["user", "marketplace"];

/** Known system/brand skill prefixes that should not auto-evolve */
const SYSTEM_PREFIXES = ["default/", "brand/", "system/"];

export class SkillFilter {
  private readonly evolvableOrigins: Set<SkillOrigin>;

  constructor(options?: FilterOptions) {
    const origins = options?.evolvableOrigins ?? DEFAULT_EVOLVABLE_ORIGINS;
    this.evolvableOrigins = new Set(origins);
  }

  /**
   * Check if a skill is eligible for automatic evolution.
   */
  canEvolve(metadata: SkillMetadata): boolean {
    return this.evolvableOrigins.has(metadata.origin) && metadata.evolvable !== false;
  }

  /**
   * Determine a skill's origin from its SKILL.md content and path.
   */
  detectOrigin(name: string, content: string, filePath?: string): SkillOrigin {
    // Check explicit origin in frontmatter
    const originMatch = content.match(/origin:\s*"?(\w+)"?/);
    if (originMatch) {
      const origin = originMatch[1] as SkillOrigin;
      if (["system", "brand", "user", "marketplace"].includes(origin)) {
        return origin;
      }
    }

    // Check system prefixes
    for (const prefix of SYSTEM_PREFIXES) {
      if (name.startsWith(prefix)) return "system";
    }

    // Check file path for system indicators
    if (filePath) {
      if (filePath.includes("/extra/") || filePath.includes("/system/")) return "system";
      if (filePath.includes("/.vera/skills/")) return "user";
      if (filePath.includes("/.claude/skills/")) return "user";
    }

    // Default to user origin
    return "user";
  }

  /**
   * Filter a list of skill metadata to only evolvable ones.
   */
  filterEvolvable(skills: SkillMetadata[]): SkillMetadata[] {
    return skills.filter((s) => this.canEvolve(s));
  }

  /**
   * Parse skill metadata from SKILL.md content and path.
   */
  parseMetadata(name: string, content: string, filePath?: string): SkillMetadata {
    const origin = this.detectOrigin(name, content, filePath);

    // Check for explicit no-evolve flag
    const noEvolve = content.match(/evolve:\s*false/i);
    const evolvable = !noEvolve;

    return { name, origin, evolvable };
  }
}

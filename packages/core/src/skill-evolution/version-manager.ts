/**
 * VersionManager — OC15
 *
 * Manages skill versioning. When a SkillReflector identifies improvements,
 * this module applies version bumps (semver) and updates SKILL.md content.
 *
 * Version format: MAJOR.MINOR.PATCH
 * - MAJOR: breaking changes to skill behavior
 * - MINOR: new features/steps added
 * - PATCH: clarity improvements, typo fixes
 */

import type {
  SkillVersion,
  VersionEntry,
  VersionUpdateResult,
  SkillReflection,
} from "./types.js";

const VERSION_HEADER_RE = /version:\s*"?(\d+\.\d+\.\d+)"?/;
const VERSION_IN_CONTENT_RE = /(\*\*Version\*\*|version):\s*(\d+\.\d+\.\d+)/i;

export class VersionManager {
  /**
   * Parse version from SKILL.md content.
   * Looks for `version: "X.Y.Z"` in frontmatter or `**Version**: X.Y.Z` in body.
   */
  parseVersion(content: string): string {
    const frontmatterMatch = content.match(VERSION_HEADER_RE);
    if (frontmatterMatch) return frontmatterMatch[1];

    const bodyMatch = content.match(VERSION_IN_CONTENT_RE);
    if (bodyMatch) return bodyMatch[2];

    return "0.1.0";
  }

  /**
   * Bump a semver version string.
   */
  bumpVersion(version: string, type: "major" | "minor" | "patch"): string {
    const parts = version.split(".").map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return "0.1.0";

    switch (type) {
      case "major":
        return `${parts[0] + 1}.0.0`;
      case "minor":
        return `${parts[0]}.${parts[1] + 1}.0`;
      case "patch":
        return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
    }
  }

  /**
   * Apply a version update to SKILL.md content based on reflection results.
   * Returns the updated content and version info.
   */
  applyUpdate(
    content: string,
    reflection: SkillReflection,
    history: VersionEntry[] = [],
  ): { content: string; result: VersionUpdateResult } {
    if (!reflection.needsUpdate || !reflection.bumpType) {
      return {
        content,
        result: { updated: false },
      };
    }

    const currentVersion = this.parseVersion(content);
    const newVersion = this.bumpVersion(currentVersion, reflection.bumpType);

    // Update version in frontmatter
    let updatedContent = content.replace(
      VERSION_HEADER_RE,
      `version: "${newVersion}"`,
    );

    // If no frontmatter version found, add to body
    if (!content.match(VERSION_HEADER_RE)) {
      updatedContent = updatedContent.replace(
        VERSION_IN_CONTENT_RE,
        `$1: ${newVersion}`,
      );
    }

    // Append changelog entry
    const changes = reflection.issues.map((i) => i.suggestion);
    const entry: VersionEntry = {
      version: newVersion,
      changes,
      timestamp: new Date().toISOString(),
      source: "reflection",
    };

    const changelog = this.buildChangelogEntry(entry);
    updatedContent = this.appendToChangelog(updatedContent, changelog);

    return {
      content: updatedContent,
      result: {
        updated: true,
        previousVersion: currentVersion,
        newVersion,
        changes,
      },
    };
  }

  /**
   * Build a markdown changelog entry for a version.
   */
  private buildChangelogEntry(entry: VersionEntry): string {
    const lines = [`### v${entry.version} (${entry.timestamp.split("T")[0]})`];
    for (const change of entry.changes) {
      lines.push(`- ${change}`);
    }
    return lines.join("\n");
  }

  /**
   * Append changelog to SKILL.md content. Inserts before the last `---` or at end.
   */
  private appendToChangelog(content: string, changelog: string): string {
    // Look for existing changelog section
    const changelogIdx = content.lastIndexOf("## Changelog");
    if (changelogIdx >= 0) {
      return content.slice(0, changelogIdx) + "## Changelog\n\n" + changelog + "\n\n" + content.slice(changelogIdx + "## Changelog".length);
    }

    // No changelog section — append at end
    return content.trimEnd() + "\n\n## Changelog\n\n" + changelog + "\n";
  }
}

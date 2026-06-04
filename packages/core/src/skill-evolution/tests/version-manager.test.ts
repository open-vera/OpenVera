import { describe, it, expect, vi } from "vitest";
import { makeMessages, mockAdapter, mockAdapterRaw } from "./skill-evolution-test-helpers.js";
import { VersionManager } from "../version-manager.js";

// ── OC15: VersionManager ───────────────────────────────────────────────────

describe("OC15: VersionManager", () => {
  const vm = new VersionManager();

  it("should parse version from frontmatter", () => {
    const content = '---\nname: test\nversion: "1.2.3"\n---\n# Test';
    expect(vm.parseVersion(content)).toBe("1.2.3");
  });

  it("should parse version from body", () => {
    const content = "# Test Skill\n**Version**: 2.0.1\n\nDescription";
    expect(vm.parseVersion(content)).toBe("2.0.1");
  });

  it("should default to 0.1.0 when no version found", () => {
    expect(vm.parseVersion("# No version here")).toBe("0.1.0");
  });

  it("should bump major version correctly", () => {
    expect(vm.bumpVersion("1.2.3", "major")).toBe("2.0.0");
  });

  it("should bump minor version correctly", () => {
    expect(vm.bumpVersion("1.2.3", "minor")).toBe("1.3.0");
  });

  it("should bump patch version correctly", () => {
    expect(vm.bumpVersion("1.2.3", "patch")).toBe("1.2.4");
  });

  it("should apply version update to SKILL.md", () => {
    const content =
      '---\nname: test-skill\nversion: "1.0.0"\n---\n# Test Skill\n\nSome content.';
    const reflection = {
      skillName: "test-skill",
      qualityScore: 0.6,
      issues: [
        {
          severity: "medium" as const,
          category: "clarity" as const,
          description: "Unclear step",
          suggestion: "Rewrite step",
        },
      ],
      needsUpdate: true,
      bumpType: "minor" as const,
    };

    const { content: updated, result } = vm.applyUpdate(content, reflection);

    expect(result.updated).toBe(true);
    expect(result.previousVersion).toBe("1.0.0");
    expect(result.newVersion).toBe("1.1.0");
    expect(updated).toContain('version: "1.1.0"');
    expect(updated).toContain("## Changelog");
    expect(updated).toContain("Rewrite step");
  });

  it("should not update when reflection says no update needed", () => {
    const content = '---\nname: test\nversion: "1.0.0"\n---\n# Test';
    const reflection = {
      skillName: "test",
      qualityScore: 0.95,
      issues: [],
      needsUpdate: false,
    };

    const { result } = vm.applyUpdate(content, reflection);
    expect(result.updated).toBe(false);
  });

  // ── bumpVersion edge cases ─────────────────────────────────────────

  it("should return 0.1.0 for invalid version string (< 3 parts)", () => {
    expect(vm.bumpVersion("1.2", "patch")).toBe("0.1.0");
    expect(vm.bumpVersion("1", "major")).toBe("0.1.0");
    expect(vm.bumpVersion("", "minor")).toBe("0.1.0");
  });

  it("should return 0.1.0 for NaN version parts", () => {
    expect(vm.bumpVersion("a.b.c", "patch")).toBe("0.1.0");
    expect(vm.bumpVersion("1.x.3", "major")).toBe("0.1.0");
  });

  it("should bump when crossing major 9→10", () => {
    expect(vm.bumpVersion("9.0.0", "major")).toBe("10.0.0");
  });

  // ── applyUpdate with history ───────────────────────────────────────

  it("should accept and apply history parameter", () => {
    const content =
      '---\nname: test\nversion: "1.0.0"\n---\n# Test\n\nSome content.';
    const reflection = {
      skillName: "test",
      qualityScore: 0.7,
      issues: [
        {
          severity: "low" as const,
          category: "clarity" as const,
          description: "Typo",
          suggestion: "Fix typo",
        },
      ],
      needsUpdate: true,
      bumpType: "patch" as const,
    };
    const history = [
      {
        version: "0.9.0",
        changes: ["Initial"],
        timestamp: "2025-01-01T00:00:00.000Z",
        source: "manual" as const,
      },
    ];

    const { content: updated, result } = vm.applyUpdate(
      content,
      reflection,
      history,
    );

    expect(result.updated).toBe(true);
    expect(result.newVersion).toBe("1.0.1");
    expect(updated).toContain("Fix typo");
  });

  // ── applyUpdate when version only in body ──────────────────────────

  it("should update version in body when no frontmatter version", () => {
    const content = "# Test Skill\n**Version**: 1.0.0\n\nDescription.";
    const reflection = {
      skillName: "test",
      qualityScore: 0.6,
      issues: [
        {
          severity: "medium" as const,
          category: "correctness" as const,
          description: "Wrong approach",
          suggestion: "Use different method",
        },
      ],
      needsUpdate: true,
      bumpType: "patch" as const,
    };

    const { content: updated, result } = vm.applyUpdate(content, reflection);

    expect(result.updated).toBe(true);
    expect(result.newVersion).toBe("1.0.1");
    expect(updated).toContain("1.0.1");
    expect(updated).toContain("## Changelog");
  });

  it("should append changelog when no existing section", () => {
    const content =
      '---\nname: test\nversion: "1.0.0"\n---\n# Test Skill\n\nNo changelog here.';
    const reflection = {
      skillName: "test",
      qualityScore: 0.7,
      issues: [
        {
          severity: "low" as const,
          category: "clarity" as const,
          description: "Minor",
          suggestion: "Improve wording",
        },
      ],
      needsUpdate: true,
      bumpType: "patch" as const,
    };

    const { content: updated, result } = vm.applyUpdate(content, reflection);

    expect(result.updated).toBe(true);
    expect(updated).toContain("## Changelog");
    expect(updated).toContain("Improve wording");
    // Should be at end
    expect(updated.endsWith("\n")).toBe(true);
  });

  it("should replace existing changelog section", () => {
    const content =
      '---\nname: test\nversion: "1.0.0"\n---\n# Test\n\n## Changelog\n\nOld entry\n\nMore content.';
    const reflection = {
      skillName: "test",
      qualityScore: 0.7,
      issues: [
        {
          severity: "medium" as const,
          category: "coverage" as const,
          description: "Missing",
          suggestion: "Add more tests",
        },
      ],
      needsUpdate: true,
      bumpType: "minor" as const,
    };

    const { content: updated, result } = vm.applyUpdate(content, reflection);

    expect(result.updated).toBe(true);
    expect(result.newVersion).toBe("1.1.0");
    // Should contain the new changelog entry
    expect(updated).toContain("Add more tests");
    // Should retain content after changelog
    expect(updated).toContain("More content.");
  });

  it("should not update when bumpType is falsy", () => {
    const content = '---\nname: test\nversion: "1.0.0"\n---\n# Test';
    const reflection = {
      skillName: "test",
      qualityScore: 0.6,
      issues: [],
      needsUpdate: true,
      bumpType: undefined as unknown,
    };

    const { result } = vm.applyUpdate(content, reflection);
    expect(result.updated).toBe(false);
  });
});

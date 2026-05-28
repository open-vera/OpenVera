/**
 * OC13-OC17: SkillAutoCreator, SkillReflector, VersionManager, SkillFilter tests
 */
import { describe, it, expect, vi } from "vitest";
import { SkillAutoCreator } from "../skill-auto-creator.js";
import { SkillReflector } from "../skill-reflector.js";
import { VersionManager } from "../version-manager.js";
import { SkillFilter } from "../skill-filter.js";
import type { Message } from "../../types/index.js";
import type { LLMAdapter } from "../../adapters/base.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMessages(count: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({ role: "user", content: `User message ${i}` });
    msgs.push({ role: "assistant", content: `Assistant response ${i}` });
  }
  return msgs;
}

function mockAdapter(response: string): LLMAdapter {
  return {
    complete: vi.fn().mockResolvedValue({
      message: { role: "assistant", content: response },
      stop_reason: "end_turn",
    }),
  } as unknown as LLMAdapter;
}

// ── OC13: SkillAutoCreator ─────────────────────────────────────────────────

describe("OC13: SkillAutoCreator", () => {
  it("should skip extraction when rounds < minRounds", async () => {
    const adapter = mockAdapter("{}");
    const creator = new SkillAutoCreator({
      minRounds: 5,
      adapter,
      model: "test",
    });

    const messages = makeMessages(3); // 3 rounds < 5
    const result = await creator.extract(messages);

    expect(result.triggered).toBe(false);
    expect(result.templates).toHaveLength(0);
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  it("should extract templates when rounds >= minRounds", async () => {
    const response = JSON.stringify({
      templates: [
        {
          name: "fix-lint-errors",
          description: "Automatically fix common lint errors in TypeScript files",
          triggers: ["lint error", "eslint error"],
          steps: ["Read file", "Identify errors", "Apply fixes", "Verify"],
          allowedTools: ["Bash", "Read", "Edit"],
          argumentHint: "[file-path]",
          sourceTask: "Fixed lint errors in 3 files",
          confidence: 0.85,
        },
      ],
    });
    const adapter = mockAdapter(response);
    const creator = new SkillAutoCreator({
      minRounds: 3,
      adapter,
      model: "test",
    });

    const messages = makeMessages(5);
    const result = await creator.extract(messages, "Fix lint errors");

    expect(result.triggered).toBe(true);
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]!.name).toBe("fix-lint-errors");
    expect(result.templates[0]!.confidence).toBe(0.85);
  });

  it("should filter templates below confidence threshold", async () => {
    const response = JSON.stringify({
      templates: [
        {
          name: "high-confidence",
          description: "A good template",
          triggers: ["test"],
          steps: ["step1"],
          allowedTools: ["Bash"],
          sourceTask: "task",
          confidence: 0.8,
        },
        {
          name: "low-confidence",
          description: "A weak template",
          triggers: ["test"],
          steps: ["step1"],
          allowedTools: ["Bash"],
          sourceTask: "task",
          confidence: 0.3,
        },
      ],
    });
    const adapter = mockAdapter(response);
    const creator = new SkillAutoCreator({
      minRounds: 2,
      minConfidence: 0.6,
      adapter,
      model: "test",
    });

    const messages = makeMessages(3);
    const result = await creator.extract(messages);

    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]!.name).toBe("high-confidence");
  });

  it("should handle invalid LLM response gracefully", async () => {
    const adapter = mockAdapter("This is not valid JSON at all");
    const creator = new SkillAutoCreator({
      minRounds: 2,
      adapter,
      model: "test",
    });

    const messages = makeMessages(3);
    const result = await creator.extract(messages);

    expect(result.triggered).toBe(true);
    expect(result.templates).toHaveLength(0);
  });
});

// ── OC14: SkillReflector ───────────────────────────────────────────────────

describe("OC14: SkillReflector", () => {
  it("should parse reflection response with issues", async () => {
    const response = JSON.stringify({
      qualityScore: 0.65,
      issues: [
        {
          severity: "high",
          category: "clarity",
          description: "Step 3 is ambiguous",
          suggestion: "Rewrite step 3 with specific command",
        },
        {
          severity: "medium",
          category: "coverage",
          description: "Missing error handling for network failures",
          suggestion: "Add retry logic with exponential backoff",
        },
      ],
      needsUpdate: true,
      bumpType: "minor",
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({ adapter, model: "test" });

    const messages: Message[] = [
      { role: "user", content: "Run the skill" },
      { role: "assistant", content: "Executed step 1, step 2, step 3 failed" },
    ];

    const result = await reflector.reflect("test-skill", "# Test Skill\nversion: 1.0.0", messages);

    expect(result.qualityScore).toBe(0.65);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]!.severity).toBe("high");
    expect(result.needsUpdate).toBe(true);
    expect(result.bumpType).toBe("minor");
  });

  it("should infer bump type from issue severity when not specified", async () => {
    const response = JSON.stringify({
      qualityScore: 0.5,
      issues: [
        { severity: "high", category: "correctness", description: "Wrong output", suggestion: "Fix it" },
      ],
      needsUpdate: true,
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({ adapter, model: "test" });

    const result = await reflector.reflect("test-skill", "# Test", []);
    expect(result.bumpType).toBe("major");
  });

  it("should handle invalid reflection response gracefully", async () => {
    const adapter = mockAdapter("not json");
    const reflector = new SkillReflector({ adapter, model: "test" });

    const result = await reflector.reflect("test-skill", "# Test", []);
    expect(result.qualityScore).toBe(0.5);
    expect(result.issues).toHaveLength(0);
    expect(result.needsUpdate).toBe(false);
  });
});

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
    const content = '---\nname: test-skill\nversion: "1.0.0"\n---\n# Test Skill\n\nSome content.';
    const reflection = {
      skillName: "test-skill",
      qualityScore: 0.6,
      issues: [
        { severity: "medium" as const, category: "clarity" as const, description: "Unclear step", suggestion: "Rewrite step" },
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
});

// ── OC16: SkillFilter ──────────────────────────────────────────────────────

describe("OC16: SkillFilter", () => {
  const filter = new SkillFilter();

  it("should allow user skills to evolve", () => {
    const meta = { name: "my-skill", origin: "user" as const, evolvable: true };
    expect(filter.canEvolve(meta)).toBe(true);
  });

  it("should allow marketplace skills to evolve", () => {
    const meta = { name: "market-skill", origin: "marketplace" as const, evolvable: true };
    expect(filter.canEvolve(meta)).toBe(true);
  });

  it("should block system skills from evolving", () => {
    const meta = { name: "default-skill", origin: "system" as const, evolvable: true };
    expect(filter.canEvolve(meta)).toBe(false);
  });

  it("should block brand skills from evolving", () => {
    const meta = { name: "brand-skill", origin: "brand" as const, evolvable: true };
    expect(filter.canEvolve(meta)).toBe(false);
  });

  it("should block skills with evolvable=false", () => {
    const meta = { name: "locked-skill", origin: "user" as const, evolvable: false };
    expect(filter.canEvolve(meta)).toBe(false);
  });

  it("should detect system origin from name prefix", () => {
    expect(filter.detectOrigin("default/my-skill", "")).toBe("system");
    expect(filter.detectOrigin("brand/company-tool", "")).toBe("system");
  });

  it("should detect user origin from file path", () => {
    expect(filter.detectOrigin("my-skill", "", "/home/.claude/skills/my-skill/SKILL.md")).toBe("user");
    expect(filter.detectOrigin("my-skill", "", "/home/.vera/skills/my-skill/SKILL.md")).toBe("user");
  });

  it("should detect origin from frontmatter", () => {
    const content = '---\nname: test\norigin: marketplace\n---\n# Test';
    expect(filter.detectOrigin("test", content)).toBe("marketplace");
  });

  it("should filter to only evolvable skills", () => {
    const skills = [
      { name: "user-skill", origin: "user" as const, evolvable: true },
      { name: "system-skill", origin: "system" as const, evolvable: true },
      { name: "locked-skill", origin: "user" as const, evolvable: false },
    ];
    const result = filter.filterEvolvable(skills);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("user-skill");
  });
});

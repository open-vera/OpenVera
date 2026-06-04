import { describe, it, expect, vi } from "vitest";
import { makeMessages, mockAdapter, mockAdapterRaw } from "./skill-evolution-test-helpers.js";
import { SkillFilter } from "../skill-filter.js";

// ── OC16: SkillFilter ──────────────────────────────────────────────────────

describe("OC16: SkillFilter", () => {
  const filter = new SkillFilter();

  it("should allow user skills to evolve", () => {
    const meta = {
      name: "my-skill",
      origin: "user" as const,
      evolvable: true,
    };
    expect(filter.canEvolve(meta)).toBe(true);
  });

  it("should allow marketplace skills to evolve", () => {
    const meta = {
      name: "market-skill",
      origin: "marketplace" as const,
      evolvable: true,
    };
    expect(filter.canEvolve(meta)).toBe(true);
  });

  it("should block system skills from evolving", () => {
    const meta = {
      name: "default-skill",
      origin: "system" as const,
      evolvable: true,
    };
    expect(filter.canEvolve(meta)).toBe(false);
  });

  it("should block brand skills from evolving", () => {
    const meta = {
      name: "brand-skill",
      origin: "brand" as const,
      evolvable: true,
    };
    expect(filter.canEvolve(meta)).toBe(false);
  });

  it("should block skills with evolvable=false", () => {
    const meta = {
      name: "locked-skill",
      origin: "user" as const,
      evolvable: false,
    };
    expect(filter.canEvolve(meta)).toBe(false);
  });

  it("should detect system origin from name prefix", () => {
    expect(filter.detectOrigin("default/my-skill", "")).toBe("system");
    expect(filter.detectOrigin("brand/company-tool", "")).toBe("system");
  });

  it("should detect user origin from file path", () => {
    expect(
      filter.detectOrigin(
        "my-skill",
        "",
        "/home/.claude/skills/my-skill/SKILL.md",
      ),
    ).toBe("user");
    expect(
      filter.detectOrigin(
        "my-skill",
        "",
        "/home/.vera/skills/my-skill/SKILL.md",
      ),
    ).toBe("user");
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

  // ── custom evolvableOrigins ────────────────────────────────────────

  it("should allow custom evolvable origins via FilterOptions", () => {
    const custom = new SkillFilter({
      evolvableOrigins: ["system", "brand", "user"],
    });

    expect(
      custom.canEvolve({
        name: "s",
        origin: "system",
        evolvable: true,
      }),
    ).toBe(true);
    expect(
      custom.canEvolve({
        name: "s",
        origin: "brand",
        evolvable: true,
      }),
    ).toBe(true);
    expect(
      custom.canEvolve({
        name: "s",
        origin: "marketplace",
        evolvable: true,
      }),
    ).toBe(false);
  });

  // ── detectOrigin: system/extra path ────────────────────────────────

  it("should detect system origin from /system/ path", () => {
    expect(
      filter.detectOrigin("", "", "/opt/system/skills/default/SKILL.md"),
    ).toBe("system");
  });

  it("should detect system origin from /extra/ path", () => {
    expect(
      filter.detectOrigin("", "", "/usr/share/extra/skills/thing/SKILL.md"),
    ).toBe("system");
  });

  // ── detectOrigin: unknown frontmatter origin falls back ─────────────

  it("should fall through frontmatter with unknown origin value", () => {
    const content = '---\norigin: "unknown-type"\n---\n# Test';
    // unknown origin → not in ["system","brand","user","marketplace"] → check prefixes → check path → default "user"
    expect(filter.detectOrigin("test", content, "/some/path")).toBe("user");
  });

  // ── detectOrigin: system prefix via name ───────────────────────────

  it("should detect system origin from system/ name prefix", () => {
    expect(filter.detectOrigin("system/my-skill", "")).toBe("system");
  });

  // ── detectOrigin: default fallback ─────────────────────────────────

  it("should default to user origin when no hints found", () => {
    expect(filter.detectOrigin("plain-skill", "")).toBe("user");
    expect(
      filter.detectOrigin("plain-skill", "", "/tmp/random/SKILL.md"),
    ).toBe("user");
  });

  // ── parseMetadata ──────────────────────────────────────────────────

  it("should parse metadata with evolvable=true when no evolve flag", () => {
    const meta = filter.parseMetadata(
      "my-skill",
      "---\nname: my-skill\norigin: user\n---\n# Test",
      "/home/user/.claude/skills/my-skill/SKILL.md",
    );
    expect(meta).toEqual({
      name: "my-skill",
      origin: "user",
      evolvable: true,
    });
  });

  it("should parse metadata with evolvable=false when evolve:false present", () => {
    const meta = filter.parseMetadata(
      "locked",
      "---\nname: locked\nevolve: false\n---\n# Test",
    );
    expect(meta).toEqual({
      name: "locked",
      origin: "user",
      evolvable: false,
    });
  });

  it("should parse metadata with case-insensitive evolve:false", () => {
    const meta = filter.parseMetadata(
      "locked2",
      "---\nevolve: FALSE\n---\n# Test",
    );
    expect(meta.evolvable).toBe(false);
  });

  it("should parse metadata with evolve:true (still evolvable)", () => {
    const meta = filter.parseMetadata(
      "unlocked",
      "---\nevolve: true\n---\n# Test",
    );
    expect(meta.evolvable).toBe(true);
  });

  // ── filterEvolvable edge cases ─────────────────────────────────────

  it("should return empty array for empty input", () => {
    const result = filter.filterEvolvable([]);
    expect(result).toEqual([]);
  });

  it("should return all when all are evolvable", () => {
    const skills = [
      { name: "a", origin: "user" as const, evolvable: true },
      { name: "b", origin: "marketplace" as const, evolvable: true },
    ];
    const result = filter.filterEvolvable(skills);
    expect(result).toHaveLength(2);
  });
});

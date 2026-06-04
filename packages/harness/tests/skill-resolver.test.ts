import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSkillResolver } from "../src/skill/index.js";

const tempDirs: string[] = [];

function makeTempSkillDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vera-skill-"));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(dir: string, name: string): void {
  writeFileSync(
    join(dir, "same.md"),
    [
      "---",
      "id: same-skill",
      `name: ${name}`,
      "description: test skill",
      "triggers:",
      "  - always",
      "---",
      "",
      `System fragment from ${name}.`,
    ].join("\n"),
    "utf8",
  );
}

function writeExplicitSkill(dir: string, name: string): void {
  writeFileSync(
    join(dir, "same.md"),
    [
      "---",
      "id: same-skill",
      `name: ${name}`,
      "description: test skill",
      "---",
      "",
      `System fragment from ${name}.`,
    ].join("\n"),
    "utf8",
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createSkillResolver", () => {
  it("lets project skills override global skills with the same id", () => {
    const globalDir = makeTempSkillDir();
    const projectDir = makeTempSkillDir();
    writeSkill(globalDir, "global skill");
    writeSkill(projectDir, "project skill");

    const resolver = createSkillResolver(undefined, globalDir, projectDir);

    const listed = resolver.list().find((skill) => skill.id === "same-skill");
    expect(listed?.name).toBe("project skill");
  });

  it("loads only the skill index until a skill is activated", () => {
    const dir = makeTempSkillDir();
    writeExplicitSkill(dir, "lazy skill");
    const resolver = createSkillResolver(undefined, dir);

    // Change the body after registration. Lazy activation should read the latest body.
    writeExplicitSkill(dir, "lazy skill updated");

    const inactive = resolver.resolve(
      { domain: "chat", level: 0, needs_tools: false },
      "Base",
    );
    expect(inactive.system).toContain("# Available Skills");
    expect(inactive.system).toContain("same-skill");
    expect(inactive.system).toContain(join(dir, "same.md"));
    expect(inactive.system).not.toContain("System fragment from lazy skill updated.");

    const active = resolver.resolve(
      { domain: "chat", level: 0, needs_tools: false, explicitIds: ["same-skill"] },
      "Base",
    );
    expect(active.system).toContain("System fragment from lazy skill updated.");
  });
});

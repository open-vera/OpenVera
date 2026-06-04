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
});

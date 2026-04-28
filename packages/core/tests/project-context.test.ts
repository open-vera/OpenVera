import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadNestedProjectContext,
  loadProjectContext,
} from "../src/project-context/index.js";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "vera-project-context-"));
}

describe("Vera project context", () => {
  it("loads Vera-named context files and ignores Claude-named files", () => {
    const root = makeProject();
    mkdirSync(join(root, ".vera", "rules"), { recursive: true });

    writeFileSync(join(root, "VERA.md"), "Project rule\n\n@extra.md");
    writeFileSync(join(root, "extra.md"), "Included detail");
    writeFileSync(join(root, ".vera", "VERA.md"), "Dot Vera rule");
    writeFileSync(join(root, ".vera", "rules", "style.md"), "Style rule");
    writeFileSync(join(root, "VERA.local.md"), "Local private rule");
    writeFileSync(join(root, "CLAUDE.md"), "Claude rule should not load");

    const context = loadProjectContext({
      cwd: root,
      includeUser: false,
      includeGitStatus: false,
    });

    expect(context.system).toContain("Project rule");
    expect(context.system).toContain("Included detail");
    expect(context.system).toContain("Dot Vera rule");
    expect(context.system).toContain("Style rule");
    expect(context.system).toContain("Local private rule");
    expect(context.system).not.toContain("Claude rule should not load");
  });

  it("loads path-scoped rules only when matching files are read", () => {
    const root = makeProject();
    mkdirSync(join(root, ".vera", "rules"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });

    writeFileSync(join(root, "VERA.md"), "Project base");
    writeFileSync(
      join(root, ".vera", "rules", "typescript.md"),
      ["---", "paths: src/**/*.ts", "---", "TypeScript scoped rule"].join("\n"),
    );

    const initial = loadProjectContext({
      cwd: root,
      includeUser: false,
      includeGitStatus: false,
    });
    expect(initial.system).toContain("Project base");
    expect(initial.system).not.toContain("TypeScript scoped rule");

    const loadedPaths = new Set(initial.files.map((file) => file.path));
    const nested = loadNestedProjectContext({
      cwd: root,
      targetPath: "src/index.ts",
      loadedPaths,
    });

    expect(nested.system).toContain("TypeScript scoped rule");
  });

  it("orders rules by frontmatter priority", () => {
    const root = makeProject();
    mkdirSync(join(root, ".vera", "rules"), { recursive: true });

    writeFileSync(join(root, ".vera", "rules", "late.md"), [
      "---",
      "priority: 20",
      "---",
      "Late rule",
    ].join("\n"));
    writeFileSync(join(root, ".vera", "rules", "early.md"), [
      "---",
      "priority: -10",
      "---",
      "Early rule",
    ].join("\n"));

    const context = loadProjectContext({
      cwd: root,
      includeUser: false,
      includeGitStatus: false,
    });

    expect(context.system.indexOf("Early rule")).toBeLessThan(context.system.indexOf("Late rule"));
    expect(context.system).toContain("Priority: -10");
    expect(context.system).toContain("Priority: 20");
  });
});

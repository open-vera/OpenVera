import { mkdtempSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncExternalResources } from "../resource-sync.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vera-resource-sync-"));
  process.env.VERA_HOME = join(root, "home");
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  process.env.CODEX_HOME = join(root, "codex");
  process.env.OPENCLAW_HOME = join(root, "openclaw");
  process.env.HERMES_HOME = join(root, "hermes");
});

afterEach(() => {
  delete process.env.VERA_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.OPENCLAW_HOME;
  delete process.env.HERMES_HOME;
  rmSync(root, { recursive: true, force: true });
});

describe("syncExternalResources", () => {
  it("symlinks supported external resources into Vera standard directories", () => {
    write(join(root, "claude", "CLAUDE.md"), "Claude persona");
    write(join(root, "claude", "commands", "review.md"), "command");
    write(join(root, "claude", "skills", "review", "SKILL.md"), "---\nid: review\n---\nReview");
    write(join(root, "codex", "AGENTS.md"), "Codex rules");
    write(join(root, "codex", "rules", "style.md"), "Style rules");
    write(join(root, "codex", "memories", "project.md"), "---\ntype: project\n---\nMemory");
    write(join(root, "hermes", "SOUL.md"), "Hermes soul");
    write(join(root, "hermes", "skills", "qa", "SKILL.md"), "---\nid: qa\n---\nQA");
    write(join(root, "hermes", "memories", "user.md"), "---\ntype: user\n---\nMemory");
    mkdirSync(join(root, "openclaw"), { recursive: true });

    const entries = syncExternalResources();

    expect(entries.some((entry) => entry.status === "created")).toBe(true);
    expectTarget("rules/claude-CLAUDE.md", join(root, "claude", "CLAUDE.md"));
    expectTarget("rules/codex-AGENTS.md", join(root, "codex", "AGENTS.md"));
    expectTarget("rules/codex-style.md", join(root, "codex", "rules", "style.md"));
    expectTarget("rules/hermes-SOUL.md", join(root, "hermes", "SOUL.md"));
    expectTarget("skills/claude-review.md", join(root, "claude", "skills", "review", "SKILL.md"));
    expectTarget("skills/hermes-qa.md", join(root, "hermes", "skills", "qa", "SKILL.md"));
    expectTarget("memory/codex", join(root, "codex", "memories"));
    expectTarget("memory/hermes", join(root, "hermes", "memories"));
    expectTarget("imports/claude/commands", join(root, "claude", "commands"));
  });

  it("keeps conflicting symlinks unless force is set", () => {
    const sourceA = join(root, "claude", "CLAUDE.md");
    const sourceB = join(root, "other", "CLAUDE.md");
    const target = join(root, "home", ".vera", "rules", "claude-CLAUDE.md");
    write(sourceA, "A");
    write(sourceB, "B");
    mkdirSync(join(root, "home", ".vera", "rules"), { recursive: true });
    symlinkSync(sourceB, target);

    const first = syncExternalResources();
    expect(first.find((entry) => entry.target === target)?.status).toBe("conflict");
    expect(resolve(join(target, ".."), readlinkSync(target))).toBe(sourceB);

    const second = syncExternalResources({ force: true });
    expect(second.find((entry) => entry.target === target)?.status).toBe("created");
    expect(resolve(join(target, ".."), readlinkSync(target))).toBe(sourceA);
  });
});

function write(path: string, content: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function expectTarget(relativePath: string, expected: string): void {
  const target = join(root, "home", ".vera", relativePath);
  expect(resolve(join(target, ".."), readlinkSync(target))).toBe(expected);
}

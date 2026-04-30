import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MemoryFile } from "../src/memory/index.js";
import {
  buildDynamicContextOptions,
  buildMemoryPreamble,
  memoryInventorySignature,
  shouldRefreshMemoryInventory,
} from "../src/repl/ui/controller/turnContext.js";

function memory(overrides: Partial<MemoryFile>): MemoryFile {
  return {
    path: "/tmp/memory.md",
    filename: "memory.md",
    description: undefined,
    type: undefined,
    score: 0,
    mtimeMs: 0,
    ...overrides,
  };
}

describe("turnContext helpers", () => {
  it("builds a stable inventory signature", () => {
    const a = memory({ path: "/tmp/b.md", mtimeMs: 2.9 });
    const b = memory({ path: "/tmp/a.md", mtimeMs: 1.1 });

    expect(memoryInventorySignature([a, b])).toBe("/tmp/a.md:1|/tmp/b.md:2");
  });

  it("decides when memory inventory should refresh", () => {
    expect(shouldRefreshMemoryInventory({
      selectedCount: 0,
      currentTurn: 10,
      frozenTurn: 10,
      currentSignature: "a",
      frozenSignature: "a",
    })).toBe(true);
    expect(shouldRefreshMemoryInventory({
      selectedCount: 1,
      currentTurn: 15,
      frozenTurn: 10,
      currentSignature: "a",
      frozenSignature: "a",
    })).toBe(true);
    expect(shouldRefreshMemoryInventory({
      selectedCount: 1,
      currentTurn: 11,
      frozenTurn: 10,
      currentSignature: "b",
      frozenSignature: "a",
    })).toBe(true);
    expect(shouldRefreshMemoryInventory({
      selectedCount: 1,
      currentTurn: 11,
      frozenTurn: 10,
      currentSignature: "a",
      frozenSignature: "a",
    })).toBe(false);
  });

  it("builds memory preamble and skips missing files", () => {
    const dir = mkdtempSync(join(tmpdir(), "vera-memory-preamble-"));
    const file = join(dir, "note.md");
    writeFileSync(file, "hello memory", "utf8");

    const preamble = buildMemoryPreamble([
      memory({ path: "/missing/nope.md", filename: "nope.md" }),
      memory({ path: file, filename: "note.md", description: "Useful", type: "project" }),
    ]);

    expect(preamble).toContain("Relevant memory files selected for this turn");
    expect(preamble).toContain("### note.md");
    expect(preamble).toContain("description: Useful");
    expect(preamble).toContain("type: project");
    expect(preamble).toContain("hello memory");
    expect(preamble).not.toContain("nope.md");
  });

  it("builds dynamic context options from the model limit", () => {
    expect(buildDynamicContextOptions(1000, "model-x")).toEqual({
      contextOptions: {
        maxTokens: 1000,
        targetUtilization: 0.85,
        keepRecentTurns: 6,
      },
      compressionOptions: {
        enabled: true,
        triggerTokens: 780,
        keepRecentTurns: 6,
        model: "model-x",
      },
      microCompactOptions: {
        enabled: true,
        gapThresholdMinutes: 60,
        keepRecent: 5,
      },
    });
  });
});

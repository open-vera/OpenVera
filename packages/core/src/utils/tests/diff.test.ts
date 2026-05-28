import { describe, it, expect } from "vitest";
import { getPatchFromContents, countHunkLines, CONTEXT_LINES } from "../diff.js";
import type { StructuredPatchHunk } from "diff";

// ── getPatchFromContents ──────────────────────────────────────────────────

describe("getPatchFromContents", () => {
  const FILE = "test.txt";

  it("returns empty array for identical content", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: "hello\nworld\n",
      newContent: "hello\nworld\n",
    });
    expect(hunks).toEqual([]);
  });

  it("returns hunks with +/- lines for a simple change", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: "line1\nline2\nline3\n",
      newContent: "line1\nmodified\nline3\n",
    });
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap((h) => h.lines);
    expect(allLines).toContain("-line2");
    expect(allLines).toContain("+modified");
    expect(allLines).toContain(" line1");
    expect(allLines).toContain(" line3");
  });

  it("handles special characters (& and $) correctly", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: "price is $100 & tax\n",
      newContent: "price is $200 & fee\n",
    });
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap((h) => h.lines);
    // The & and $ should be unescaped back to original
    expect(allLines.some((l) => l.includes("$100 & tax"))).toBe(true);
    expect(allLines.some((l) => l.includes("$200 & fee"))).toBe(true);
  });

  it("respects ignoreWhitespace option", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: "hello world   \n",
      newContent: "hello world\n",
      ignoreWhitespace: true,
    });
    // With whitespace ignored, trailing whitespace differences are ignored
    expect(hunks).toEqual([]);
  });

  it("singleHunk option produces fewer hunks with large context", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
    const oldContent = lines.join("\n") + "\n";
    const newLines = [...lines];
    newLines[50] = "CHANGED";
    const newContent = newLines.join("\n") + "\n";

    const multiHunks = getPatchFromContents({
      filePath: FILE,
      oldContent,
      newContent,
      singleHunk: false,
    });
    const singleHunk = getPatchFromContents({
      filePath: FILE,
      oldContent,
      newContent,
      singleHunk: true,
    });

    // singleHunk should produce at most 1 hunk
    expect(singleHunk.length).toBeLessThanOrEqual(1);
    // The single hunk should contain all lines including context
    if (singleHunk.length === 1) {
      expect(singleHunk[0].lines.length).toBeGreaterThanOrEqual(
        multiHunks.reduce((sum, h) => sum + h.lines.length, 0),
      );
    }
  });

  it("handles empty old content (new file)", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: "",
      newContent: "new file content\n",
    });
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap((h) => h.lines);
    expect(allLines).toContain("+new file content");
  });

  it("handles empty new content (deleted file)", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: "deleted content\n",
      newContent: "",
    });
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap((h) => h.lines);
    expect(allLines).toContain("-deleted content");
  });

  it("handles both empty contents", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: "",
      newContent: "",
    });
    expect(hunks).toEqual([]);
  });

  it("returns correct hunk structure with oldStart/oldLines/newStart/newLines", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: "a\nb\nc\n",
      newContent: "a\nB\nc\n",
    });
    expect(hunks.length).toBe(1);
    const hunk = hunks[0];
    expect(hunk.oldStart).toBeGreaterThan(0);
    expect(hunk.oldLines).toBeGreaterThan(0);
    expect(hunk.newStart).toBeGreaterThan(0);
    expect(hunk.newLines).toBeGreaterThan(0);
  });

  it("uses default context lines (CONTEXT_LINES constant)", () => {
    // Create a file large enough that context lines matter
    const lines = Array.from({ length: 200 }, (_, i) => `line${i}`);
    const oldContent = lines.join("\n") + "\n";
    const newLines = [...lines];
    newLines[100] = "CHANGED";
    const newContent = newLines.join("\n") + "\n";

    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent,
      newContent,
    });

    // With default context, the context lines around the change should be CONTEXT_LINES
    for (const hunk of hunks) {
      const contextCount = hunk.lines.filter((l) => l.startsWith(" ")).length;
      // Context lines should be at most CONTEXT_LINES on each side
      // (might be less at file boundaries)
      expect(contextCount).toBeLessThanOrEqual(CONTEXT_LINES * 2 + 2);
    }
  });
});

// ── countHunkLines ────────────────────────────────────────────────────────

describe("countHunkLines", () => {
  it("returns {added:0, removed:0} for empty hunks", () => {
    const result = countHunkLines([]);
    expect(result).toEqual({ added: 0, removed: 0 });
  });

  it("counts added lines", () => {
    const hunks: StructuredPatchHunk[] = [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 2,
        lines: ["+line1", "+line2"],
      },
    ];
    const result = countHunkLines(hunks);
    expect(result).toEqual({ added: 2, removed: 0 });
  });

  it("counts removed lines", () => {
    const hunks: StructuredPatchHunk[] = [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 0,
        lines: ["-line1", "-line2"],
      },
    ];
    const result = countHunkLines(hunks);
    expect(result).toEqual({ added: 0, removed: 2 });
  });

  it("counts mixed + and - lines", () => {
    const hunks: StructuredPatchHunk[] = [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [" line1", "-old2", "+new2", " line3"],
      },
    ];
    const result = countHunkLines(hunks);
    expect(result).toEqual({ added: 1, removed: 1 });
  });

  it("does not count context lines (space prefix)", () => {
    const hunks: StructuredPatchHunk[] = [
      {
        oldStart: 1,
        oldLines: 5,
        newStart: 1,
        newLines: 5,
        lines: [" line1", " line2", "-old3", "+new3", " line4", " line5"],
      },
    ];
    const result = countHunkLines(hunks);
    expect(result).toEqual({ added: 1, removed: 1 });
  });

  it("handles multiple hunks", () => {
    const hunks: StructuredPatchHunk[] = [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: [" line1", "-old2", "+new2"],
      },
      {
        oldStart: 10,
        oldLines: 2,
        newStart: 10,
        newLines: 3,
        lines: [" line10", "-old11", "+new11a", "+new11b"],
      },
    ];
    const result = countHunkLines(hunks);
    expect(result).toEqual({ added: 3, removed: 2 });
  });

  it("handles hunk with only context lines", () => {
    const hunks: StructuredPatchHunk[] = [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [" line1", " line2", " line3"],
      },
    ];
    const result = countHunkLines(hunks);
    expect(result).toEqual({ added: 0, removed: 0 });
  });

  it("handles hunk with empty lines array", () => {
    const hunks: StructuredPatchHunk[] = [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 0,
        lines: [],
      },
    ];
    const result = countHunkLines(hunks);
    expect(result).toEqual({ added: 0, removed: 0 });
  });
});

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

  it("handles multiline addition (block insert)", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: "line1\nline2\n",
      newContent: "line1\ninsertA\ninsertB\ninsertC\nline2\n",
    });
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap((h) => h.lines);
    expect(allLines).toContain("+insertA");
    expect(allLines).toContain("+insertB");
    expect(allLines).toContain("+insertC");
  });

  it("handles multiline deletion (block remove)", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: "line1\nremoveA\nremoveB\nremoveC\nline2\n",
      newContent: "line1\nline2\n",
    });
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap((h) => h.lines);
    expect(allLines).toContain("-removeA");
    expect(allLines).toContain("-removeB");
    expect(allLines).toContain("-removeC");
  });

  it("handles addition-only change (append content)", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: "existing line\n",
      newContent: "existing line\nnew line\n",
    });
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap((h) => h.lines);
    expect(allLines).toContain("+new line");
    expect(allLines.filter((l) => l.startsWith("-")).length).toBe(0);
  });

  it("handles deletion-only change (remove block)", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: "a\ndelete me\nc\n",
      newContent: "a\nc\n",
    });
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap((h) => h.lines);
    expect(allLines).toContain("-delete me");
    expect(allLines.filter((l) => l.startsWith("+")).length).toBe(0);
  });

  it("detects change at the first line", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: "first\nsecond\nthird\n",
      newContent: "CHANGED\nsecond\nthird\n",
    });
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap((h) => h.lines);
    expect(allLines).toContain("-first");
    expect(allLines).toContain("+CHANGED");
  });

  it("detects change at the last line", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: "first\nsecond\nlast\n",
      newContent: "first\nsecond\nCHANGED\n",
    });
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap((h) => h.lines);
    expect(allLines).toContain("-last");
    expect(allLines).toContain("+CHANGED");
  });

  it("produces multiple hunks for non-contiguous changes", () => {
    const oldLines = Array.from({ length: 100 }, (_, i) => `line${i}`);
    const newLines = [...oldLines];
    newLines[20] = "CHANGED_A";
    newLines[80] = "CHANGED_B";
    const oldContent = oldLines.join("\n") + "\n";
    const newContent = newLines.join("\n") + "\n";

    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent,
      newContent,
    });
    expect(hunks.length).toBeGreaterThanOrEqual(2);
    const allLines = hunks.flatMap((h) => h.lines);
    expect(allLines).toContain("+CHANGED_A");
    expect(allLines).toContain("+CHANGED_B");
  });

  it("escapes & and $ at the beginning and end of lines", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: "&start\nmiddle\nend$\n",
      newContent: "$changed\nmiddle\n&\n",
    });
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap((h) => h.lines);
    expect(allLines.some((l) => l.includes("&start"))).toBe(true);
    expect(allLines.some((l) => l.includes("end$"))).toBe(true);
    expect(allLines.some((l) => l.includes("$changed"))).toBe(true);
  });

  it("handles many & and $ in a single line", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: "price: $100 & shipping: $5 && tax\n",
      newContent: "price: $200 & shipping: $10 && fee\n",
    });
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap((h) => h.lines);
    expect(
      allLines.some((l) => l.includes("$100 & shipping: $5 && tax")),
    ).toBe(true);
    expect(
      allLines.some((l) => l.includes("$200 & shipping: $10 && fee")),
    ).toBe(true);
  });

  it("handles content lines that look like diff markers (+, -, space prefix)", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: " normal\n+plus like\n-minus like\n",
      newContent: " normal\n+plus changed\n-minus like\n",
    });
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap((h) => h.lines);
    // Context line starting with space stays
    expect(allLines).toContain(" -minus like");
    // Changed line shows removal + addition
    expect(allLines).toContain("-+plus like");
    expect(allLines).toContain("++plus changed");
  });

  it("handles single-line content without trailing newline", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: "only",
      newContent: "changed",
    });
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap((h) => h.lines);
    expect(allLines).toContain("-only");
    expect(allLines).toContain("+changed");
  });

  it("handles single-line to multiline expansion", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: "single line\n",
      newContent: "first line\nsecond line\nthird line\n",
    });
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap((h) => h.lines);
    expect(allLines).toContain("-single line");
    expect(allLines).toContain("+first line");
    expect(allLines).toContain("+second line");
    expect(allLines).toContain("+third line");
  });

  it("handles multiline to single-line collapse", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: "first line\nsecond line\nthird line\n",
      newContent: "single line\n",
    });
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap((h) => h.lines);
    expect(allLines).toContain("-first line");
    expect(allLines).toContain("-second line");
    expect(allLines).toContain("-third line");
    expect(allLines).toContain("+single line");
  });

  it("uses CONTEXT_LINES = 3 for surrounding context in single hunk", () => {
    const oldLines = Array.from({ length: 50 }, (_, i) => `line${i}`);
    const newLines = [...oldLines];
    newLines[25] = "CHANGED";
    const oldContent = oldLines.join("\n") + "\n";
    const newContent = newLines.join("\n") + "\n";
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent,
      newContent,
    });
    expect(hunks.length).toBe(1);
    const contextLines = hunks[0].lines.filter((l) => l.startsWith(" "));
    expect(contextLines.length).toBeLessThanOrEqual(CONTEXT_LINES * 2);
  });

  it("filePath does not affect diff hunk content", () => {
    const nested = getPatchFromContents({
      filePath: "src/deep/test.txt",
      oldContent: "a\nb\nc\n",
      newContent: "a\nB\nc\n",
    });
    const root = getPatchFromContents({
      filePath: "file.txt",
      oldContent: "a\nb\nc\n",
      newContent: "a\nB\nc\n",
    });
    expect(nested[0].lines).toEqual(root[0].lines);
  });

  it("handles content with only newlines", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: "\n\n\n",
      newContent: "\nX\n\n",
    });
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap((h) => h.lines);
    expect(allLines).toContain("+X");
  });

  it("handles content with backslash characters", () => {
    const hunks = getPatchFromContents({
      filePath: FILE,
      oldContent: 'path = "C:\\\\old\\\\dir"\n',
      newContent: 'path = "C:\\\\new\\\\dir"\n',
    });
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap((h) => h.lines);
    expect(allLines.some((l) => l.includes("old"))).toBe(true);
    expect(allLines.some((l) => l.includes("new"))).toBe(true);
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

  it("handles all-addition across multiple hunks", () => {
    const hunks: StructuredPatchHunk[] = [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 3,
        lines: ["+a1", "+a2", "+a3"],
      },
      {
        oldStart: 10,
        oldLines: 0,
        newStart: 13,
        newLines: 2,
        lines: ["+b1", "+b2"],
      },
    ];
    const result = countHunkLines(hunks);
    expect(result).toEqual({ added: 5, removed: 0 });
  });

  it("handles all-deletion across multiple hunks", () => {
    const hunks: StructuredPatchHunk[] = [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 0,
        lines: ["-d1", "-d2", "-d3"],
      },
      {
        oldStart: 10,
        oldLines: 1,
        newStart: 7,
        newLines: 0,
        lines: ["-d4"],
      },
    ];
    const result = countHunkLines(hunks);
    expect(result).toEqual({ added: 0, removed: 4 });
  });

  it("ignores backslash-prefixed lines (no-newline marker)", () => {
    const hunks: StructuredPatchHunk[] = [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: ["-old", "+new", "\\ No newline at end of file"],
      },
    ];
    const result = countHunkLines(hunks);
    expect(result).toEqual({ added: 1, removed: 1 });
  });

  it("handles large line counts", () => {
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push("+added");
    }
    for (let i = 0; i < 500; i++) {
      lines.push("-removed");
    }
    const hunks: StructuredPatchHunk[] = [
      {
        oldStart: 1,
        oldLines: 500,
        newStart: 1,
        newLines: 1000,
        lines,
      },
    ];
    const result = countHunkLines(hunks);
    expect(result).toEqual({ added: 1000, removed: 500 });
  });
});

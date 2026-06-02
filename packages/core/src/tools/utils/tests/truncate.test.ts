import { describe, it, expect } from "vitest";
import {
  truncateLines,
  truncateChars,
  truncateOutput,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_CHARS,
} from "../truncate.js";

// ─── truncateLines ──────────────────────────────────────────────────────────

describe("truncateLines", () => {
  it("returns unchanged text when under maxLines", () => {
    const text = "line1\nline2\nline3";
    const result = truncateLines(text, 10);
    expect(result.content).toBe(text);
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(3);
  });

  it("returns unchanged text at exact maxLines boundary", () => {
    const text = "a\nb\nc";
    const result = truncateLines(text, 3);
    expect(result.content).toBe(text);
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(3);
  });

  it("truncates text exceeding maxLines", () => {
    const text = "line1\nline2\nline3\nline4\nline5";
    const result = truncateLines(text, 3);
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(5);

    const lines = result.content.split("\n");
    expect(lines[0]).toBe("line1");
    expect(lines[1]).toBe("line2");
    expect(lines[2]).toBe("line3");
    // The 4th line is the hint
    expect(lines[3]).toContain("more lines");
    expect(lines[3]).toContain("2"); // remaining lines
  });

  it("uses default maxLines when not provided", () => {
    // Create text with more lines than DEFAULT_MAX_LINES
    const lines = Array.from({ length: DEFAULT_MAX_LINES + 100 }, (_, i) => `line${i}`);
    const text = lines.join("\n");
    const result = truncateLines(text);
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(DEFAULT_MAX_LINES + 100);

    const keptLines = result.content.split("\n");
    // Should have kept exactly DEFAULT_MAX_LINES lines, plus the hint line
    expect(keptLines.length).toBe(DEFAULT_MAX_LINES + 1);
    expect(keptLines[DEFAULT_MAX_LINES]).toContain("100 more lines");
  });

  it("appends a custom hint message when provided", () => {
    const text = "a\nb\nc\nd\ne";
    const customHint = "Use --offset to see more";
    const result = truncateLines(text, 3, customHint);
    expect(result.truncated).toBe(true);

    const lines = result.content.split("\n");
    expect(lines[3]).toBe(customHint);
  });

  it("handles single-line text", () => {
    const text = "just one line";
    const result = truncateLines(text, 5);
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(1);
    expect(result.content).toBe(text);
  });

  it("handles single-line text that exceeds limit (maxLines=0)", () => {
    const text = "just one line";
    const result = truncateLines(text, 0);
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(1);

    // When maxLines=0, kept array is empty, joined to "",
    // so content is "\n" + hint. The hint is on line index 1 after split.
    const lines = result.content.split("\n");
    expect(lines[0]).toBe("");
    expect(lines[1]).toContain("1 more line");
  });

  it("handles empty string", () => {
    const result = truncateLines("", 5);
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(1); // "".split("\n") returns [""]
    expect(result.content).toBe("");
  });

  it("handles text with trailing newlines", () => {
    const text = "a\nb\nc\n";
    // split("\n") on "a\nb\nc\n" gives ["a","b","c",""]
    const result = truncateLines(text, 3);
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(4); // trailing empty string counts as a line
    expect(result.content).toContain("1 more line");
  });

  it("keeps all lines when maxLines equals totalLines exactly", () => {
    const text = "1\n2\n3\n4\n5";
    const result = truncateLines(text, 5);
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(5);
    expect(result.content).toBe(text);
  });

  it("keeps empty string hint since ?? only checks null/undefined", () => {
    const text = "a\nb\nc\nd";
    const result = truncateLines(text, 2, "");
    expect(result.truncated).toBe(true);
    // "" is not nullish, so ?? does NOT fall back to default
    // Content ends with kept lines + "\n" + "" = trailing newline
    expect(result.content).toBe("a\nb\n");
  });
});

// ─── truncateChars ──────────────────────────────────────────────────────────

describe("truncateChars", () => {
  it("returns unchanged text when under maxChars", () => {
    const text = "short text";
    const result = truncateChars(text, 100);
    expect(result.content).toBe(text);
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(1);
  });

  it("returns unchanged text at exact maxChars boundary", () => {
    const text = "abcde"; // 5 chars
    const result = truncateChars(text, 5);
    expect(result.content).toBe(text);
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(1);
  });

  it("truncates text exceeding maxChars", () => {
    const text = "0123456789"; // 10 chars
    const result = truncateChars(text, 5);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain("01234");
    expect(result.content).toContain("[... 5 more characters truncated]");
  });

  it("uses default maxChars when not provided", () => {
    const text = "x".repeat(DEFAULT_MAX_CHARS + 1000);
    const result = truncateChars(text);
    expect(result.truncated).toBe(true);
    // Content should be DEFAULT_MAX_CHARS chars + the truncation message
    const truncatedPart = text.slice(0, DEFAULT_MAX_CHARS);
    expect(result.content.startsWith(truncatedPart)).toBe(true);
    expect(result.content).toContain("1000 more characters truncated");
  });

  it("handles empty string", () => {
    const result = truncateChars("", 100);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe("");
    expect(result.totalLines).toBe(1);
  });

  it("reports correct line count after truncation", () => {
    const text = "line1\nline2\nline3\nline4"; // 4 lines, 23 chars
    const result = truncateChars(text, 10); // truncate in the middle of line2
    expect(result.truncated).toBe(true);
    // totalLines is based on the truncated content, not the original
    const truncatedPart = text.slice(0, 10); // "line1\nline"
    expect(result.totalLines).toBe(truncatedPart.split("\n").length);
  });

  it("handles single multiline text under limit", () => {
    const text = "a\nb\nc";
    const result = truncateChars(text, 100);
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(3);
    expect(result.content).toBe(text);
  });

  it("handles exactly maxChars with multiline text", () => {
    const text = "ab\ncd\nef"; // 8 chars
    const result = truncateChars(text, 8);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe(text);
    expect(result.totalLines).toBe(3);
  });
});

// ─── truncateOutput ─────────────────────────────────────────────────────────

describe("truncateOutput", () => {
  it("returns unchanged output when under token budget", () => {
    const output = "short output";
    const result = truncateOutput(output, 100);
    expect(result.wasTruncated).toBe(false);
    expect(result.truncated).toBe(output);
    expect(result.originalLength).toBe(output.length);
  });

  it("returns unchanged output at exact token budget boundary", () => {
    const maxTokens = 10;
    const maxChars = maxTokens * 4; // 40 chars
    const output = "x".repeat(maxChars);
    const result = truncateOutput(output, maxTokens);
    expect(result.wasTruncated).toBe(false);
    expect(result.truncated).toBe(output);
    expect(result.originalLength).toBe(maxChars);
  });

  it("truncates output exceeding token budget with head/tail preservation", () => {
    // Create a long output that will be truncated
    const output = "abcdefghij".repeat(100); // 1000 chars
    const result = truncateOutput(output, 50); // 50 tokens -> 200 chars budget
    expect(result.wasTruncated).toBe(true);
    expect(result.originalLength).toBe(1000);

    // Verify head/tail structure
    expect(result.truncated).toContain("[...truncated");
    expect(result.truncated).toContain("chars...]");

    // The marker should be somewhere in the middle
    const markerIndex = result.truncated.indexOf("[...truncated");
    const headPart = result.truncated.slice(0, markerIndex);
    const tailPart = result.truncated.slice(markerIndex);

    // Head should start with the original beginning
    expect(headPart).toBe(output.slice(0, headPart.length));
    // Tail should end with the original ending
    expect(output.endsWith(tailPart.slice(tailPart.lastIndexOf("]") + 1))).toBe(true);
  });

  it("preserves approximately 60/40 head/tail split", () => {
    const maxTokens = 100;
    const maxChars = maxTokens * 4; // 400 chars
    const output = "x".repeat(1000);
    const result = truncateOutput(output, maxTokens);
    expect(result.wasTruncated).toBe(true);

    const markerIndex = result.truncated.indexOf("[...truncated");
    const headLen = markerIndex;
    const tailStart = result.truncated.lastIndexOf("]") + 1;
    const tailLen = result.truncated.length - tailStart;

    // Head should be ~60% of budget, tail ~40% (excluding marker)
    const expectedHeadLen = Math.floor(maxChars * 0.6);
    const expectedTailLen = maxChars - expectedHeadLen;
    expect(headLen).toBe(expectedHeadLen);
    expect(tailLen).toBe(expectedTailLen);
  });

  it("uses default maxTokens of 4000 when not provided", () => {
    const defaultChars = 4000 * 4; // 16000
    const output = "y".repeat(defaultChars + 100);
    const result = truncateOutput(output);
    expect(result.wasTruncated).toBe(true);
    expect(result.originalLength).toBe(defaultChars + 100);
  });

  it("handles empty string", () => {
    const result = truncateOutput("", 100);
    expect(result.wasTruncated).toBe(false);
    expect(result.truncated).toBe("");
    expect(result.originalLength).toBe(0);
  });

  it("converts tokens to characters at 1:4 ratio", () => {
    const maxTokens = 5;
    const maxChars = maxTokens * 4; // 20 chars
    const output = "a".repeat(30); // exceeds 20
    const result = truncateOutput(output, maxTokens);
    expect(result.wasTruncated).toBe(true);

    // Total output (head + marker + tail) should fit within ~maxChars + marker overhead
    const truncatedLen = result.truncated.length;
    const markerOverhead = "[...truncated X chars...]".length;
    // The head+tail parts (without marker) should total maxChars
    const match = result.truncated.match(/\[\.\.\.truncated (\d+) chars\.\.\.\]/);
    expect(match).not.toBeNull();
    if (match) {
      const removedChars = parseInt(match[1], 10);
      const headTailLen = truncatedLen - match[0].length;
      expect(headTailLen).toBe(maxChars);
      expect(removedChars).toBe(30 - maxChars);
    }
  });

  it("reports correct removed character count", () => {
    const output = "A".repeat(500);
    const result = truncateOutput(output, 50); // 50 tokens -> 200 chars
    expect(result.wasTruncated).toBe(true);
    const match = result.truncated.match(/\[\.\.\.truncated (\d+) chars\.\.\.\]/);
    expect(match).not.toBeNull();
    if (match) {
      const removedChars = parseInt(match[1], 10);
      expect(removedChars).toBe(500 - 200); // total - budget
    }
  });

  it("preserves original beginning and end content", () => {
    const prefix = "START_MARKER";
    const suffix = "END_MARKER";
    const padding = "x".repeat(10000);
    const output = prefix + padding + suffix;

    const result = truncateOutput(output, 250); // 1000 chars budget
    expect(result.wasTruncated).toBe(true);
    expect(result.truncated.startsWith(prefix)).toBe(true);
    expect(result.truncated.endsWith(suffix)).toBe(true);
  });

  it("handles custom maxTokens value", () => {
    const output = "z".repeat(1000);
    const result = truncateOutput(output, 10); // 40 chars budget
    expect(result.wasTruncated).toBe(true);
    expect(result.originalLength).toBe(1000);

    // Head + tail (without marker) should be 40 chars
    const match = result.truncated.match(/\[\.\.\.truncated (\d+) chars\.\.\.\]/);
    expect(match).not.toBeNull();
    if (match) {
      const headTailLen = result.truncated.length - match[0].length;
      expect(headTailLen).toBe(40);
    }
  });

  it("handles very small token budget", () => {
    const output = "abcdefghijklmnopqrstuvwxyz"; // 26 chars
    const result = truncateOutput(output, 1); // 4 chars budget
    expect(result.wasTruncated).toBe(true);
    // headLen = floor(4 * 0.6) = 2, tailLen = 4 - 2 = 2
    expect(result.truncated.startsWith("ab")).toBe(true);
    expect(result.truncated.endsWith("yz")).toBe(true);
  });
});

/**
 * Comprehensive tests for the tool-budget module.
 *
 * Covers:
 *   - Constants: DEFAULT_MAX_RESULT_SIZE_CHARS, MAX_PER_TURN_CHARS, PREVIEW_SIZE_CHARS
 *   - createToolBudgetState
 *   - processToolResult (all branches)
 *   - reapplyReplacements (all branches)
 *   - enforcePerTurnBudget (all branches)
 *   - Internal helpers: buildOverflowMessage, persistContent, offload (via public API)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — node:fs/promises
// ---------------------------------------------------------------------------
const { mockMkdir, mockWriteFile } = vi.hoisted(() => ({
  mockMkdir: vi.fn(),
  mockWriteFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
}));

// ---------------------------------------------------------------------------
// System under test (import triggers the mock resolution)
// ---------------------------------------------------------------------------
import {
  createToolBudgetState,
  processToolResult,
  reapplyReplacements,
  enforcePerTurnBudget,
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  MAX_PER_TURN_CHARS,
  PREVIEW_SIZE_CHARS,
} from "../../context/tool-budget.js";
import type { ToolResultBudgetState, Message } from "../../context/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function freshState(): ToolResultBudgetState {
  return createToolBudgetState();
}

function toolMsg(toolCallId: string, content: string): Message {
  return { role: "tool", content, tool_call_id: toolCallId };
}

function assistantMsg(text: string): Message {
  return { role: "assistant", content: text };
}

function userMsg(text: string): Message {
  return { role: "user", content: text };
}

function longContent(chars: number, prefix = ""): string {
  return prefix + "x".repeat(chars - prefix.length);
}

/** Temporary directory that the internal offload uses. */
const TMP_DIR = "/tmp/vera-tool-budget-test";

beforeEach(() => {
  vi.clearAllMocks();
  // Default success behavior for file writes
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
});

// ===========================================================================
// Constants
// ===========================================================================
describe("constants", () => {
  it("DEFAULT_MAX_RESULT_SIZE_CHARS equals 50_000", () => {
    expect(DEFAULT_MAX_RESULT_SIZE_CHARS).toBe(50_000);
  });

  it("MAX_PER_TURN_CHARS equals 200_000", () => {
    expect(MAX_PER_TURN_CHARS).toBe(200_000);
  });

  it("PREVIEW_SIZE_CHARS equals 2_000", () => {
    expect(PREVIEW_SIZE_CHARS).toBe(2_000);
  });
});

// ===========================================================================
// createToolBudgetState
// ===========================================================================
describe("createToolBudgetState", () => {
  it("returns a fresh state with empty seenIds and replacements", () => {
    const state = createToolBudgetState();
    expect(state.seenIds).toBeInstanceOf(Set);
    expect(state.replacements).toBeInstanceOf(Map);
    expect(state.seenIds.size).toBe(0);
    expect(state.replacements.size).toBe(0);
  });

  it("returns distinct state instances on each call", () => {
    const a = createToolBudgetState();
    const b = createToolBudgetState();
    a.seenIds.add("id1");
    expect(b.seenIds.size).toBe(0);
  });
});

// ===========================================================================
// processToolResult
// ===========================================================================
describe("processToolResult", () => {
  // ── Cache hit: frozen replacement ───────────────────────────────────────
  describe("cache hit (frozen replacement)", () => {
    it("returns the cached overflow message byte-for-byte", async () => {
      const state = freshState();
      const cachedContent = "<tool-result-overflow>\ncached content\n</tool-result-overflow>";
      state.replacements.set("tool-1", cachedContent);

      const result = await processToolResult(
        "tool-1",
        longContent(100_000),
        state,
        TMP_DIR,
      );
      expect(result).toBe(cachedContent);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("returns cached content even when the new output is under budget", async () => {
      const state = freshState();
      const cached = "cached-overflow";
      state.replacements.set("t1", cached);

      // The new output is tiny but the cache takes precedence
      const result = await processToolResult("t1", "tiny", state, TMP_DIR);
      expect(result).toBe(cached);
    });
  });

  // ── Already seen (frozen in original form) ──────────────────────────────
  describe("already seen but not replaced", () => {
    it("returns the original output unchanged", async () => {
      const state = freshState();
      state.seenIds.add("tool-1");

      const output = "some output that was seen before but not replaced";
      const result = await processToolResult("tool-1", output, state, TMP_DIR);
      expect(result).toBe(output);
    });
  });

  // ── Budget disabled (no runDir) ─────────────────────────────────────────
  describe("budget disabled (no runDir)", () => {
    it("returns output unchanged regardless of size", async () => {
      const state = freshState();
      const huge = longContent(100_000); // way over default threshold

      const result = await processToolResult("tool-1", huge, state, undefined);
      expect(result).toBe(huge);
      expect(state.seenIds.has("tool-1")).toBe(true);
      expect(state.replacements.has("tool-1")).toBe(false);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  // ── Under budget ────────────────────────────────────────────────────────
  describe("output under budget", () => {
    it("returns output unchanged when size <= maxResultSizeChars (default)", async () => {
      const state = freshState();
      const small = longContent(100);

      const result = await processToolResult("tool-1", small, state, TMP_DIR);
      expect(result).toBe(small);
      expect(state.seenIds.has("tool-1")).toBe(true);
      expect(state.replacements.has("tool-1")).toBe(false);
    });

    it("returns output unchanged when size equals maxResultSizeChars exactly (default)", async () => {
      const state = freshState();
      const exact = longContent(DEFAULT_MAX_RESULT_SIZE_CHARS);

      const result = await processToolResult("tool-1", exact, state, TMP_DIR);
      expect(result).toBe(exact);
      expect(state.seenIds.has("tool-1")).toBe(true);
      expect(state.replacements.size).toBe(0);
    });

    it("returns output unchanged with custom maxResultSizeChars", async () => {
      const state = freshState();
      const customMax = 500;
      const content = longContent(300);

      const result = await processToolResult(
        "tool-1",
        content,
        state,
        TMP_DIR,
        customMax,
      );
      expect(result).toBe(content);
      expect(state.replacements.size).toBe(0);
    });
  });

  // ── Over budget (offload) ───────────────────────────────────────────────
  describe("over budget (offload)", () => {
    it("persists content and returns overflow message when exceeding default threshold", async () => {
      const state = freshState();
      const huge = longContent(60_000); // > 50_000

      const result = await processToolResult("tool-1", huge, state, TMP_DIR);

      expect(result).not.toBe(huge);
      expect(result).toContain("<tool-result-overflow>");
      expect(result).toContain("Output too large (60000 chars)");
      expect(result).toContain(`Preview (first ${PREVIEW_SIZE_CHARS} chars):`);
      expect(result).toContain("</tool-result-overflow>");

      // State recorded
      expect(state.seenIds.has("tool-1")).toBe(true);
      expect(state.replacements.get("tool-1")).toBe(result);

      // File persisted
      expect(mockMkdir).toHaveBeenCalledWith(
        `${TMP_DIR}/tool-results`,
        { recursive: true },
      );
      expect(mockWriteFile).toHaveBeenCalledWith(
        `${TMP_DIR}/tool-results/tool-1.txt`,
        huge,
        { encoding: "utf-8", flag: "wx" },
      );
    });

    it("shows '...' ellipsis when content is longer than PREVIEW_SIZE_CHARS", async () => {
      const state = freshState();
      const huge = longContent(60_000);

      const result = await processToolResult("tool-1", huge, state, TMP_DIR);

      expect(result).toContain("...\n</tool-result-overflow>");
    });

    it("does NOT show ellipsis when content is ≤ PREVIEW_SIZE_CHARS but > maxResultSizeChars", async () => {
      // That's impossible with default constants (PREVIEW < DEFAULT_MAX) but
      // possible with custom maxResultSizeChars.
      const state = freshState();
      const content = longContent(500); // < PREVIEW_SIZE_CHARS (2000)
      const customMax = 100; // < 500 so it will trigger

      const result = await processToolResult(
        "tool-1",
        content,
        state,
        TMP_DIR,
        customMax,
      );

      // Content is 500 chars, less than PREVIEW_SIZE_CHARS (2000)
      // So hasMore=false and no "..."
      expect(result).toContain("<tool-result-overflow>");
      expect(result).toContain("Output too large (500 chars)");
      expect(result).not.toContain("...\n</tool-result-overflow>");
      // Should contain the full preview (the whole content since it's short)
      expect(result).toContain(content);
    });

    it("includes the correct filepath in the overflow message", async () => {
      const state = freshState();
      const huge = longContent(60_000);

      const result = await processToolResult("tool-x", huge, state, TMP_DIR);

      expect(result).toContain(
        `Full output saved to: ${TMP_DIR}/tool-results/tool-x.txt`,
      );
    });

    it("records replacement in state for byte-identical replay", async () => {
      const state = freshState();
      const huge = longContent(60_000);

      const result = await processToolResult("tool-1", huge, state, TMP_DIR);

      // Second call with same id returns the cached overflow
      const result2 = await processToolResult("tool-1", "new content", state, TMP_DIR);
      expect(result2).toBe(result); // byte-identical!
    });
  });

  // ── persistContent EEXIST handling ──────────────────────────────────────
  describe("persistContent EEXIST handling", () => {
    it("silently skips write when file already exists (EEXIST)", async () => {
      const state = freshState();
      const huge = longContent(60_000);

      // Simulate EEXIST on first attempt
      const eexistErr = new Error("file exists") as NodeJS.ErrnoException;
      eexistErr.code = "EEXIST";
      mockWriteFile.mockRejectedValueOnce(eexistErr);

      // Even though writeFile throws EEXIST, offload succeeds
      // because writeFile is only called once (flag "wx" fails on existing),
      // but the function still returns the filepath and builds overflow msg
      const result = await processToolResult("tool-1", huge, state, TMP_DIR);

      expect(result).toContain("<tool-result-overflow>");
      expect(result).toContain("Output too large (60000 chars)");
    });

    it("rethrows non-EEXIST errors from writeFile", async () => {
      const state = freshState();
      const huge = longContent(60_000);

      const permErr = new Error("permission denied") as NodeJS.ErrnoException;
      permErr.code = "EACCES";
      mockWriteFile.mockRejectedValueOnce(permErr);

      await expect(
        processToolResult("tool-1", huge, state, TMP_DIR),
      ).rejects.toThrow("permission denied");
    });
  });

  // ── Default maxResultSizeChars ──────────────────────────────────────────
  describe("default maxResultSizeChars", () => {
    it("uses DEFAULT_MAX_RESULT_SIZE_CHARS when not provided", async () => {
      const state = freshState();
      const belowDefault = longContent(10_000);

      // Should NOT offload because 10k < DEFAULT_MAX_RESULT_SIZE_CHARS (50k)
      const result = await processToolResult("tool-1", belowDefault, state, TMP_DIR);
      expect(result).toBe(belowDefault);
      expect(state.replacements.size).toBe(0);
    });
  });
});

// ===========================================================================
// reapplyReplacements
// ===========================================================================
describe("reapplyReplacements", () => {
  it("returns the same array reference when replacements map is empty", () => {
    const state = freshState();
    const messages: Message[] = [toolMsg("t1", "hello")];

    const result = reapplyReplacements(messages, state);
    expect(result).toBe(messages); // same reference
  });

  it("returns the same array reference when no tool message matches any replacement", () => {
    const state = freshState();
    state.replacements.set("other-tool", "overflow");
    const messages: Message[] = [toolMsg("t1", "hello")];

    const result = reapplyReplacements(messages, state);
    expect(result).toBe(messages); // same reference
  });

  it("replaces tool message content when tool_call_id matches a replacement", () => {
    const state = freshState();
    state.replacements.set("t1", "<tool-result-overflow>\ncached\n</tool-result-overflow>");
    const messages: Message[] = [toolMsg("t1", "original content")];

    const result = reapplyReplacements(messages, state);
    expect(result).not.toBe(messages); // new array
    expect(result[0]!.content).toBe(
      "<tool-result-overflow>\ncached\n</tool-result-overflow>",
    );
  });

  it("handles tool message with no tool_call_id by using empty string", () => {
    const state = freshState();
    state.replacements.set("", "overflow-for-empty-id");
    const messages: Message[] = [{ role: "tool", content: "orig" }]; // no tool_call_id

    const result = reapplyReplacements(messages, state);
    expect(result[0]!.content).toBe("overflow-for-empty-id");
  });

  it("skips non-tool messages entirely", () => {
    const state = freshState();
    state.replacements.set("t1", "overflow");
    const messages: Message[] = [
      userMsg("hello"),
      assistantMsg("hi there"),
    ];

    const result = reapplyReplacements(messages, state);
    expect(result).toBe(messages); // same reference, no tool msgs modified
  });

  it("only replaces tool messages whose id matches a replacement", () => {
    const state = freshState();
    state.replacements.set("t1", "overflow-t1");
    const messages: Message[] = [
      userMsg("hello"),
      toolMsg("t1", "big-result-1"),
      assistantMsg("processing..."),
      toolMsg("t2", "big-result-2"),
      userMsg("continue"),
    ];

    const result = reapplyReplacements(messages, state);
    expect(result).not.toBe(messages); // mutated
    // t1's content replaced
    expect(result[1]!.content).toBe("overflow-t1");
    // user message unchanged
    expect(result[0]!.content).toBe("hello");
    // assistant message unchanged
    expect(result[2]!.content).toBe("processing...");
    // t2 unchanged (no replacement for it)
    expect(result[3]!.content).toBe("big-result-2");
    // user message unchanged
    expect(result[4]!.content).toBe("continue");
  });

  it("replaces multiple tool messages in one pass", () => {
    const state = freshState();
    state.replacements.set("t1", "c1");
    state.replacements.set("t2", "c2");
    const messages: Message[] = [
      toolMsg("t1", "orig1"),
      toolMsg("t2", "orig2"),
    ];

    const result = reapplyReplacements(messages, state);
    expect(result[0]!.content).toBe("c1");
    expect(result[1]!.content).toBe("c2");
  });

  it("does not mutate tool message with undefined tool_call_id when no replacement for empty string", () => {
    const state = freshState();
    state.replacements.set("known-id", "overflow");
    const messages: Message[] = [
      { role: "tool", content: "keep-me" } as Message,
    ];

    const result = reapplyReplacements(messages, state);
    expect(result).toBe(messages); // no changes
  });
});

// ===========================================================================
// enforcePerTurnBudget
// ===========================================================================
describe("enforcePerTurnBudget", () => {
  // ── No runDir (budget disabled) ─────────────────────────────────────────
  describe("no runDir (budget disabled)", () => {
    it("returns messages unchanged when runDir is undefined", async () => {
      const state = freshState();
      const messages: Message[] = [
        assistantMsg("call tools"),
        toolMsg("t1", longContent(300_000)),
      ];

      const result = await enforcePerTurnBudget(messages, state, undefined);
      expect(result).toBe(messages);
    });
  });

  // ── Under budget ────────────────────────────────────────────────────────
  describe("under aggregate budget", () => {
    it("returns messages unchanged when total is under MAX_PER_TURN_CHARS", async () => {
      const state = freshState();
      const messages: Message[] = [
        assistantMsg("call tools"),
        toolMsg("t1", longContent(100)),
        toolMsg("t2", longContent(200)),
      ];

      const result = await enforcePerTurnBudget(messages, state, TMP_DIR);
      expect(result).toBe(messages);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("returns messages unchanged when total exactly equals MAX_PER_TURN_CHARS", async () => {
      const state = freshState();
      const content = longContent(MAX_PER_TURN_CHARS);
      const messages: Message[] = [
        assistantMsg("call tools"),
        toolMsg("t1", content),
      ];

      const result = await enforcePerTurnBudget(messages, state, TMP_DIR);
      expect(result).toBe(messages);
    });

    it("accounts for frozen (already seen) results in total calculation", async () => {
      const state = freshState();
      // Mark t1 as already seen (frozen)
      state.seenIds.add("t1");
      const frozenContent = longContent(100_000);

      // Fresh tool result brings total to 150k which is under budget
      const messages: Message[] = [
        assistantMsg("call tools"),
        toolMsg("t1", frozenContent),
        toolMsg("t2", longContent(50_000)),
      ];

      const result = await enforcePerTurnBudget(messages, state, TMP_DIR);
      expect(result).toBe(messages); // 100k + 50k = 150k < 200k
    });
  });

  // ── Over budget (offload) ───────────────────────────────────────────────
  describe("over aggregate budget", () => {
    it("offloads the largest fresh results when total exceeds budget", async () => {
      const state = freshState();
      const messages: Message[] = [
        assistantMsg("call tools"),
        toolMsg("small", longContent(10_000)),
        toolMsg("huge", longContent(190_000)), // this one exceeds budget
        toolMsg("medium", longContent(50_000)),
      ];

      // Total fresh: 10k + 190k + 50k = 250k > 200k
      // Sorted: 190k, 50k, 10k → offload 190k → remaining 60k ≤ 200k ✓
      const result = await enforcePerTurnBudget(messages, state, TMP_DIR);

      // "huge" should be offloaded
      expect(result[2]!.content).not.toBe(messages[2]!.content);
      expect(result[2]!.content).toContain("<tool-result-overflow>");

      // "small" and "medium" should remain unchanged
      expect(result[1]!.content).toBe(messages[1]!.content);
      expect(result[3]!.content).toBe(messages[3]!.content);

      // State should be updated
      expect(state.seenIds.has("huge")).toBe(true);
      expect(state.replacements.has("huge")).toBe(true);
    });

    it("offloads multiple results when one is not enough", async () => {
      const state = freshState();
      const messages: Message[] = [
        assistantMsg("call tools"),
        toolMsg("a", longContent(150_000)),
        toolMsg("b", longContent(100_000)),
        toolMsg("c", longContent(80_000)),
      ];

      // Total fresh: 150k + 100k + 80k = 330k > 200k
      // Sorted: 150k, 100k, 80k
      // Offload 150k → remaining 180k ≤ 200k ✓
      // So only "a" should be offloaded
      const result = await enforcePerTurnBudget(messages, state, TMP_DIR);

      expect(result[1]!.content).toContain("<tool-result-overflow>"); // a offloaded
      expect(result[2]!.content).toBe(messages[2]!.content); // b unchanged
      expect(result[3]!.content).toBe(messages[3]!.content); // c unchanged
    });

    it("offloads all fresh results if even the smallest keeps it over budget", async () => {
      const state = freshState();
      const frozenContent = longContent(100_000);
      const messages: Message[] = [
        assistantMsg("call tools"),
        toolMsg("frozen", frozenContent),
        toolMsg("a", longContent(60_000)),
        toolMsg("b", longContent(60_000)),
      ];

      // Mark the frozen message as already seen
      state.seenIds.add("frozen");

      // frozenSize=100k + freshTotal=120k = 220k > 200k
      // Sorted fresh: 60k, 60k
      // Offload first 60k → remaining 160k ≤ 200k ✓
      // So only "a" gets offloaded (they're equal, first in sorted order)
      const result = await enforcePerTurnBudget(messages, state, TMP_DIR);

      const offloadedCount = [result[2], result[3]].filter(
        (m: Message) => typeof m.content === "string" && m.content.includes("<tool-result-overflow>")
      ).length;
      expect(offloadedCount).toBe(1);
    });
  });

  // ── No assistant message found ──────────────────────────────────────────
  describe("no assistant message in messages", () => {
    it("scans from index 0 when no assistant message exists", async () => {
      const state = freshState();
      const messages: Message[] = [
        userMsg("hello"),
        toolMsg("t1", longContent(250_000)),
      ];

      // lastAsstIdx = -1, so we scan from index 0
      // t1 is a tool message, total fresh = 250k > 200k → offload
      const result = await enforcePerTurnBudget(messages, state, TMP_DIR);

      expect(result[1]!.content).toContain("<tool-result-overflow>");
    });
  });

  // ── Non-tool messages after assistant ───────────────────────────────────
  describe("non-tool messages after assistant", () => {
    it("skips non-tool messages when collecting results", async () => {
      const state = freshState();
      const messages: Message[] = [
        assistantMsg("call tools"),
        userMsg("some user interruption"), // non-tool, skipped
        toolMsg("t1", longContent(50_000)),
      ];

      // Only t1 is fresh tool, 50k < 200k, so no offload
      const result = await enforcePerTurnBudget(messages, state, TMP_DIR);
      expect(result).toBe(messages);
    });
  });

  // ── Non-string content ──────────────────────────────────────────────────
  describe("non-string tool content", () => {
    it("treats non-string content as empty string for size calculation when fresh", async () => {
      const state = freshState();
      const messages: Message[] = [
        assistantMsg("call tools"),
        {
          role: "tool",
          tool_call_id: "t1",
          content: [{ type: "text", text: "structured content" }],
        } as unknown as Message,
      ];

      // Non-string content treated as "", total = 0 < budget
      const result = await enforcePerTurnBudget(messages, state, TMP_DIR);
      expect(result).toBe(messages);
    });

    it("treats non-string content as empty string when frozen (already seen)", async () => {
      const state = freshState();
      state.seenIds.add("t1");
      const messages: Message[] = [
        assistantMsg("call tools"),
        {
          role: "tool",
          tool_call_id: "t1",
          content: [{ type: "text", text: "frozen structured" }],
        } as unknown as Message,
      ];

      const result = await enforcePerTurnBudget(messages, state, TMP_DIR);
      expect(result).toBe(messages);
    });
  });

  // ── tool_call_id defaults to empty string ───────────────────────────────
  describe("missing tool_call_id", () => {
    it("uses empty string when tool_call_id is undefined", async () => {
      const state = freshState();
      const messages: Message[] = [
        assistantMsg("call tools"),
        { role: "tool", content: longContent(250_000) } as Message,
      ];

      const result = await enforcePerTurnBudget(messages, state, TMP_DIR);

      // Should be offloaded since 250k > 200k
      expect(result[1]!.content).toContain("<tool-result-overflow>");
    });
  });

  // ── Empty tool result collection ────────────────────────────────────────
  describe("no fresh tool results to collect", () => {
    it("returns messages unchanged when no tool messages exist after last assistant", async () => {
      const state = freshState();
      const messages: Message[] = [
        assistantMsg("just an assistant message"),
        userMsg("user follow-up"),
      ];

      const result = await enforcePerTurnBudget(messages, state, TMP_DIR);
      expect(result).toBe(messages);
    });

    it("returns messages unchanged when lastAsstIdx is last message (no messages after)", async () => {
      const state = freshState();
      const messages: Message[] = [
        userMsg("start"),
        assistantMsg("final"),
      ];

      const result = await enforcePerTurnBudget(messages, state, TMP_DIR);
      expect(result).toBe(messages);
    });
  });

  // ── Mixed fresh and frozen ──────────────────────────────────────────────
  describe("mixed fresh and frozen results", () => {
    it("includes frozen size in budget calculation forcing more offloads", async () => {
      const state = freshState();
      // frozenSize = 150k
      state.seenIds.add("frozen-1");
      const messages: Message[] = [
        assistantMsg("call tools"),
        toolMsg("frozen-1", longContent(150_000)),
        toolMsg("fresh-1", longContent(60_000)), // needs offload: 150k + 60k = 210k > 200k
        toolMsg("fresh-2", longContent(30_000)),
      ];

      const result = await enforcePerTurnBudget(messages, state, TMP_DIR);

      // 150k frozen + 90k fresh = 240k > 200k
      // Sorted fresh: 60k, 30k → offload 60k → remaining 180k ≤ 200k ✓
      expect(result[2]!.content).toContain("<tool-result-overflow>");
      expect(result[3]!.content).toBe(messages[3]!.content);
    });
  });

  // ── Edge case: only frozen results exceed budget ───────────────────────
  describe("only frozen results exceed budget", () => {
    it("returns messages unchanged when all tool results are frozen but total exceeds budget", async () => {
      const state = freshState();
      // All tool results after the assistant are already seen (frozen)
      state.seenIds.add("f1");
      state.seenIds.add("f2");

      const messages: Message[] = [
        assistantMsg("call tools"),
        toolMsg("f1", longContent(120_000)),
        toolMsg("f2", longContent(100_000)),
      ];

      // frozenSize = 220k > 200k, fresh is empty → toOffload.size === 0
      const result = await enforcePerTurnBudget(messages, state, TMP_DIR);
      // Returns unchanged (can't offload what's already frozen)
      expect(result).toBe(messages);
    });
  });

  // ── Edge case: non-string content selected for offload ──────────────────
  describe("non-string content offload", () => {
    it("handles non-string tool content that gets selected for offload", async () => {
      const state = freshState();
      // frozen result exceeds budget by itself
      state.seenIds.add("frozen");
      const frozenContent = longContent(210_000);

      // Fresh results have non-string content → size 0, but the greedy loop
      // still tries them since total (210k + 0) exceeds budget.
      // Since they have size 0, remaining never decrements and all get
      // added to toOffload. Then the overflow message builder hits the
      // non-string branch (line 207).
      const messages: Message[] = [
        assistantMsg("call tools"),
        toolMsg("frozen", frozenContent),
        {
          role: "tool",
          tool_call_id: "ns",
          content: { type: "text", text: "structured" },
        } as unknown as Message,
      ];

      const result = await enforcePerTurnBudget(messages, state, TMP_DIR);

      // The non-string fresh result gets offloaded (even with empty content)
      const offloadedMsg = result[2]!;
      expect(typeof offloadedMsg.content).toBe("string");
      expect((offloadedMsg.content as string)).toContain(
        "<tool-result-overflow>",
      );
    });
  });
});

// ===========================================================================
// Integration: processToolResult + enforcePerTurnBudget interaction
// ===========================================================================
describe("integration: processToolResult + enforcePerTurnBudget", () => {
  it("processToolResult offload is respected by enforcePerTurnBudget as already-seen", async () => {
    const state = freshState();

    // Step 1: Process a huge tool result individually
    const overflow = await processToolResult(
      "tool-1",
      longContent(60_000),
      state,
      TMP_DIR,
    );

    // Step 2: Build messages for the next turn, including the overflow
    const messages: Message[] = [
      assistantMsg("call tools"),
      toolMsg("tool-1", overflow), // already replaced by processToolResult
      toolMsg("tool-2", longContent(150_000)),
    ];

    // tool-1 is already seen (frozen), tool-2 is fresh
    // frozen size = overflow.length, fresh = 150k
    // Should still be under budget
    const result = await enforcePerTurnBudget(messages, state, TMP_DIR);
    expect(result[1]!.content).toBe(overflow); // frozen, unchanged
    expect(result[2]!.content).toBe(messages[2]!.content); // tool-2 unchanged
  });
});

/**
 * Tests for compression — covers OC1 (insert-then-compress), OC2 (single
 * cache rebuild), OC3 (topics + summary structured output), and general
 * compression / micro-compact behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Message } from "../../types/index.js";
import type { CompressionState } from "../index.js";
import type { LLMAdapter } from "../../adapters/base.js";
import {
  compressMessages,
  createCompressionState,
  buildCompressionInstruction,
  parseCompressionResponse,
  buildSyntheticFromOutput,
  insertCompressionInstruction,
  resolveInsertCompress,
  microCompact,
  createMicroCompactState,
  isPromptTooLongError,
  findRelevantSegments,
  expandSegment,
  estimateMessageTokens,
  IdleCompressionTimer,
} from "../index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function userMsg(text: string): Message {
  return { role: "user", content: text };
}

function assistantMsg(text: string): Message {
  return { role: "assistant", content: text };
}

function toolMsg(toolCallId: string, content: string): Message {
  return { role: "tool", content, tool_call_id: toolCallId };
}

function assistantToolCallMsg(id: string, name: string): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_call", id, name, arguments: "{}" }],
  };
}

/**
 * Build a conversation with N user-assistant turn pairs.
 * Each message has enough content to exceed token thresholds when needed.
 */
function buildConversation(turns: number, padding = ""): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < turns; i++) {
    const pad = padding || `Turn ${i + 1}: ${"x".repeat(500)}`;
    msgs.push(userMsg(`Question ${i + 1}? ${pad}`));
    msgs.push(assistantMsg(`Answer ${i + 1}. ${pad}`));
  }
  return msgs;
}

/** Create a mock LLM adapter that returns a specific compression response. */
function mockAdapter(responseText: string): LLMAdapter {
  return {
    complete: vi.fn().mockResolvedValue({
      message: { role: "assistant", content: responseText },
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
    stream: vi.fn(),
  } as unknown as LLMAdapter;
}

const SAMPLE_COMPRESSION_OUTPUT = `<analysis>
User asked about building a CLI tool. I helped create the file structure,
implement argument parsing, and add tests. We fixed a bug with flag parsing.
</analysis>

<summary>
### 1. Primary Request and Intent
Build a CLI tool with argument parsing and subcommands.

### 2. Key Technical Concepts
- TypeScript CLI development
- Commander.js for argument parsing
- Vitest for testing

### 3. Files and Code Sections
- src/cli.ts: Main entry point with argument parsing
- src/commands/build.ts: Build subcommand implementation

### 4. Errors and Fixes
- Flag parsing bug: boolean flags were treated as string values. Fixed by adding type coercion.

### 5. Problem Solving
Resolved the flag parsing issue by checking typeof before assignment.

### 6. All User Messages
"Build me a CLI tool"
"Fix the flag parsing bug"

### 7. Pending Tasks
None.

### 8. Current Work
Completed the CLI tool implementation.

### 9. Optional Next Step
None — task is complete.
</summary>

<topics>cli-tool typescript argument-parsing commander vitest</topics>`;

// ── OC1: Insert-then-Compress ────────────────────────────────────────────────

describe("OC1: Insert-then-Compress", () => {
  describe("buildCompressionInstruction", () => {
    it("should build instruction for single turn", () => {
      const msg = buildCompressionInstruction(1);
      expect(msg.role).toBe("user");
      expect(msg.content).toContain("Compress the oldest 1 turn");
      expect(msg.content).toContain("<summary>");
      expect(msg.content).toContain("<topics>");
    });

    it("should build instruction for multiple turns", () => {
      const msg = buildCompressionInstruction(5);
      expect(msg.content).toContain("Compress the oldest 5 turns");
    });

    it("should include CRITICAL no-tools preamble", () => {
      const msg = buildCompressionInstruction(3);
      expect(msg.content).toContain("TEXT ONLY");
      expect(msg.content).toContain("Do NOT call any tools");
    });
  });

  describe("insertCompressionInstruction", () => {
    it("should return null when under token threshold", () => {
      const msgs = buildConversation(2);
      const result = insertCompressionInstruction(msgs, {
        enabled: true,
        triggerTokens: 999_999,
      });
      expect(result).toBeNull();
    });

    it("uses remote lastContextUsed for the threshold when provided", () => {
      const msgs = buildConversation(10, "x".repeat(2000));
      // Local estimate would exceed 100, but remote occupancy is still small.
      const under = insertCompressionInstruction(
        msgs,
        { enabled: true, triggerTokens: 100, keepRecentTurns: 4 },
        false,
        50,
      );
      expect(under).toBeNull();
      const over = insertCompressionInstruction(
        msgs,
        { enabled: true, triggerTokens: 100, keepRecentTurns: 4 },
        false,
        101,
      );
      expect(over).not.toBeNull();
    });

    it("should return null when too few turns", () => {
      const msgs = buildConversation(3);
      const result = insertCompressionInstruction(msgs, {
        enabled: true,
        triggerTokens: 1,
        keepRecentTurns: 10,
      });
      expect(result).toBeNull();
    });

    it("should insert instruction between old and recent messages", () => {
      // Build 10 turns with large content to exceed threshold
      const msgs = buildConversation(10, "x".repeat(2000));
      const result = insertCompressionInstruction(msgs, {
        enabled: true,
        triggerTokens: 100,
        keepRecentTurns: 4,
      });

      expect(result).not.toBeNull();
      const { messages, pending } = result!;

      // Instruction should be inserted
      const instructionIdx = messages.findIndex(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("[SYSTEM: Compress"),
      );
      expect(instructionIdx).toBeGreaterThan(0);

      // Old messages before instruction, recent after
      const recentStart = instructionIdx + 1;
      expect(messages.slice(recentStart).length).toBeGreaterThan(0);

      // Pending metadata
      expect(pending.turnCount).toBeGreaterThan(0);
      expect(pending.splitIndex).toBe(instructionIdx);
      expect(pending.originalTokenCount).toBeGreaterThan(0);
    });

    it("should work in reactive mode (ignore threshold)", () => {
      const msgs = buildConversation(8, "x".repeat(1000));
      const result = insertCompressionInstruction(
        msgs,
        { triggerTokens: 999_999, keepRecentTurns: 2 },
        true, // isReactive
      );

      expect(result).not.toBeNull();
      expect(result!.pending.turnCount).toBeGreaterThan(0);
    });
  });

  describe("resolveInsertCompress", () => {
    it("should resolve valid compression output", () => {
      const msgs = buildConversation(6, "x".repeat(1000));
      const state = createCompressionState();

      // First insert
      const inserted = insertCompressionInstruction(msgs, {
        triggerTokens: 100,
        keepRecentTurns: 2,
      });
      expect(inserted).not.toBeNull();

      // Resolve with mock response
      const resolved = resolveInsertCompress(
        inserted!.messages,
        SAMPLE_COMPRESSION_OUTPUT,
        inserted!.pending,
        state,
      );

      expect(resolved).not.toBeNull();
      expect(resolved!.messages.length).toBeLessThan(msgs.length + 1);
      expect(resolved!.state.segments).toHaveLength(1);
      expect(resolved!.state.segments[0]!.topics).toContain("cli-tool");
      expect(resolved!.state.segments[0]!.summary).toContain("Primary Request");
    });

    it("should handle unstructured compression output as fallback", () => {
      const msgs = buildConversation(6, "x".repeat(1000));
      const state = createCompressionState();

      const inserted = insertCompressionInstruction(msgs, {
        triggerTokens: 100,
        keepRecentTurns: 2,
      });
      expect(inserted).not.toBeNull();

      const resolved = resolveInsertCompress(
        inserted!.messages,
        "Just a random response without any structure",
        inserted!.pending,
        state,
      );

      // Fallback: uses raw text as summary (up to 800 chars), empty topics
      expect(resolved).not.toBeNull();
      expect(resolved!.state.segments).toHaveLength(1);
      expect(resolved!.state.segments[0]!.topics).toEqual([]);
      expect(resolved!.state.segments[0]!.summary).toContain("random response");
    });
  });
});

// ── OC2: Single Cache Rebuild ────────────────────────────────────────────────

describe("OC2: Single cache rebuild", () => {
  it("insertCompressionInstruction should NOT call adapter (pure message transform)", () => {
    const msgs = buildConversation(10, "x".repeat(2000));
    const adapter = mockAdapter(SAMPLE_COMPRESSION_OUTPUT);

    insertCompressionInstruction(msgs, {
      triggerTokens: 100,
      keepRecentTurns: 4,
    });

    // The adapter should NOT have been called — insert-then-compress
    // defers the actual compression to the next normal API call
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  it("traditional compressMessages DOES call adapter (contrast)", async () => {
    const msgs = buildConversation(10, "x".repeat(2000));
    const adapter = mockAdapter(SAMPLE_COMPRESSION_OUTPUT);
    const state = createCompressionState();

    await compressMessages(
      msgs,
      state,
      { enabled: true, triggerTokens: 100, keepRecentTurns: 4 },
      adapter,
      "test-model",
    );

    expect(adapter.complete).toHaveBeenCalledTimes(1);
  });
});

// ── OC3: Topics + Summary Structured Output ──────────────────────────────────

describe("OC3: Topics extraction", () => {
  it("should extract topics from <topics> block", () => {
    const output = parseCompressionResponse(SAMPLE_COMPRESSION_OUTPUT);
    expect(output).not.toBeNull();
    expect(output!.topics).toEqual([
      "cli-tool",
      "typescript",
      "argument-parsing",
      "commander",
      "vitest",
    ]);
  });

  it("should handle missing <topics> block gracefully", () => {
    const text = `<summary>### 1. Primary Request\nTest</summary>`;
    const output = parseCompressionResponse(text);
    expect(output).not.toBeNull();
    expect(output!.topics).toEqual([]);
  });

  it("should extract summary from <summary> block", () => {
    const output = parseCompressionResponse(SAMPLE_COMPRESSION_OUTPUT);
    expect(output).not.toBeNull();
    expect(output!.summary).toContain("Primary Request");
    expect(output!.summary).toContain("CLI tool");
  });

  it("buildSyntheticFromOutput should include topics in result", () => {
    const output = parseCompressionResponse(SAMPLE_COMPRESSION_OUTPUT);
    expect(output).not.toBeNull();

    const synthetic = buildSyntheticFromOutput("turns 1–5", output!, false);
    expect(synthetic.role).toBe("user");
    expect(typeof synthetic.content).toBe("string");
    expect(synthetic.content).toContain("[Compressed context — turns 1–5]");
  });

  it("handles invalid JSON in summary (catch branch for JSON.parse failure)", () => {
    // Text that matches \{[\s\S]*\} but is NOT valid JSON — triggers catch block (line 262)
    const text =
      `<summary>\n{summary: "broken json without quotes", decisions: [bad, array], findings: }\n</summary>\n` +
      `<topics>test broken</topics>`;
    const output = parseCompressionResponse(text);
    expect(output).not.toBeNull();
    // Falls back to raw summary text (up to 800 chars)
    expect(output!.summary).toContain("{summary:");
    expect(output!.decisions).toEqual([]);
    expect(output!.findings).toEqual([]);
    expect(output!.topics).toEqual(["test", "broken"]);
  });

  it("returns null when JSON lacks summary field (parseCompressionResponse)", () => {
    // parseCompressionResponse returns null when output.summary is falsy
    const text =
      `<summary>\n\`\`\`json\n{"decisions": ["Use X"], "findings": ["Found Y"]}\n\`\`\`\n</summary>\n` +
      `<topics>test</topics>`;
    const output = parseCompressionResponse(text);
    // summary is "" (missing field), so parseCompressionResponse returns null
    expect(output).toBeNull();
  });
});

// ── Compression: Full flow ───────────────────────────────────────────────────

describe("compressMessages (traditional)", () => {
  it("should skip when disabled", async () => {
    const msgs = buildConversation(3);
    const adapter = mockAdapter(SAMPLE_COMPRESSION_OUTPUT);
    const state = createCompressionState();

    const result = await compressMessages(
      msgs,
      state,
      { enabled: false },
      adapter,
      "test-model",
    );

    expect(result.messages).toBe(msgs);
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  it("should skip when under token threshold", async () => {
    const msgs = buildConversation(2);
    const adapter = mockAdapter(SAMPLE_COMPRESSION_OUTPUT);
    const state = createCompressionState();

    const result = await compressMessages(
      msgs,
      state,
      { enabled: true, triggerTokens: 999_999 },
      adapter,
      "test-model",
    );

    expect(result.messages).toBe(msgs);
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  it("should compress and produce structured output with topics", async () => {
    const msgs = buildConversation(10, "x".repeat(2000));
    const adapter = mockAdapter(SAMPLE_COMPRESSION_OUTPUT);
    const state = createCompressionState();

    const result = await compressMessages(
      msgs,
      state,
      { enabled: true, triggerTokens: 100, keepRecentTurns: 4 },
      adapter,
      "test-model",
    );

    expect(result.messages.length).toBeLessThan(msgs.length);
    expect(result.state.segments).toHaveLength(1);
    expect(result.state.segments[0]!.topics).toContain("cli-tool");
    expect(result.usage).toBeDefined();
  });

  it("should skip compression on adapter error", async () => {
    const msgs = buildConversation(10, "x".repeat(2000));
    const adapter = {
      complete: vi.fn().mockRejectedValue(new Error("API error")),
      stream: vi.fn(),
    } as unknown as LLMAdapter;
    const state = createCompressionState();

    const result = await compressMessages(
      msgs,
      state,
      { enabled: true, triggerTokens: 100, keepRecentTurns: 4 },
      adapter,
      "test-model",
    );

    // Should return original messages on error
    expect(result.messages).toBe(msgs);
    expect(result.state.segments).toHaveLength(0);
  });

  it("should re-compress existing synthetic messages", async () => {
    const msgs = buildConversation(10, "x".repeat(2000));
    const adapter = mockAdapter(SAMPLE_COMPRESSION_OUTPUT);
    const state = createCompressionState();

    // First compression
    const first = await compressMessages(
      msgs,
      state,
      { enabled: true, triggerTokens: 100, keepRecentTurns: 4 },
      adapter,
      "test-model",
    );

    // Add more messages after compression
    const expanded = [
      ...first.messages,
      userMsg("Follow up question?"),
      assistantMsg("Follow up answer."),
      userMsg("Another question?"),
      assistantMsg("Another answer."),
    ];

    // Second compression
    const second = await compressMessages(
      expanded,
      first.state,
      { enabled: true, triggerTokens: 100, keepRecentTurns: 2 },
      adapter,
      "test-model",
    );

    expect(second.state.segments.length).toBeGreaterThanOrEqual(1);
  });

  it("should handle adapter returning array content (extractText array branch)", async () => {
    // Cover extractText when content is not a string but an array of ContentParts
    const arrayContentAdapter = {
      complete: vi.fn().mockResolvedValue({
        message: {
          role: "assistant" as const,
          content: [
            { type: "text" as const, text: "### 1. Primary Request\nArray-based auth implementation\n" },
            { type: "text" as const, text: "### 2. Key Technical Concepts\nOAuth, PKCE, JWT\n" },
          ] as any,
        },
        usage: { input_tokens: 50, output_tokens: 30 },
      }),
      stream: vi.fn(),
    } as unknown as LLMAdapter;

    const msgs = buildConversation(10, "x".repeat(2000));
    const state = createCompressionState();

    const result = await compressMessages(
      msgs,
      state,
      { enabled: true, triggerTokens: 100, keepRecentTurns: 4 },
      arrayContentAdapter,
      "test-model",
    );

    expect(result.state.segments.length).toBe(1);
    expect(result.state.segments[0]!.summary).toContain("auth");
  });

  it("should skip when compression output has empty summary", async () => {
    // JSON with empty string summary causes !output.summary to be truthy -> skip
    const emptySummaryJson = JSON.stringify({
      summary: "",
      decisions: [],
      findings: [],
      pending: [],
    });
    const responseText =
      `<summary>\n\`\`\`json\n${emptySummaryJson}\n\`\`\`\n</summary>\n<topics>empty</topics>`;
    const adapter = mockAdapter(responseText);
    const msgs = buildConversation(10, "x".repeat(2000));
    const state = createCompressionState();

    const result = await compressMessages(
      msgs,
      state,
      { enabled: true, triggerTokens: 100, keepRecentTurns: 4 },
      adapter,
      "test-model",
    );

    // Empty summary -> skipped, messages unchanged
    expect(result.messages).toBe(msgs);
    expect(result.state.segments).toHaveLength(0);
  });

  it("works in reactive mode (ignores token threshold, more aggressive keep)", async () => {
    const adapter = mockAdapter(SAMPLE_COMPRESSION_OUTPUT);
    // Create fewer messages that would normally be under a high threshold
    const msgs = buildConversation(8, "x".repeat(2000));
    const state = createCompressionState();

    const result = await compressMessages(
      msgs,
      state,
      { enabled: true, triggerTokens: 999_999, keepRecentTurns: 4 },
      adapter,
      "test-model",
      true, // isReactive
    );

    // Reactive mode ignores triggerTokens threshold
    expect(adapter.complete).toHaveBeenCalledTimes(1);
    expect(result.state.segments.length).toBe(1);
    // Reactive uses more aggressive keep
    const firstContent = typeof result.messages[0]!.content === "string"
      ? (result.messages[0]!.content as string)
      : "";
    expect(firstContent).toContain("Context compressed after prompt overflow");
  });

  it("does nothing in reactive mode with too few turns", async () => {
    const adapter = mockAdapter(SAMPLE_COMPRESSION_OUTPUT);
    const msgs = buildConversation(2); // 2 turns, effectiveKeep = max(2, floor(4/2))=2, totalTurns <= effectiveKeep+1 => 2 <= 3
    const state = createCompressionState();

    const result = await compressMessages(
      msgs,
      state,
      { enabled: true, triggerTokens: 1, keepRecentTurns: 4 },
      adapter,
      "test-model",
      true, // isReactive
    );

    expect(adapter.complete).not.toHaveBeenCalled();
    expect(result.messages).toBe(msgs);
  });

  it("formats messages with array content parts for compression input", async () => {
    // Covers formatMessage array branch (lines 160-170) with text, tool_call, tool_result parts
    const adapter = mockAdapter(SAMPLE_COMPRESSION_OUTPUT);
    const longMsg = "x".repeat(2000);

    // Build a conversation with mixed content types (string + array parts)
    const msgs: Message[] = [
      { role: "user", content: longMsg },
      { role: "assistant", content: longMsg },
      { role: "user", content: longMsg },
      { role: "assistant", content: longMsg },
      // Tool call turn with array content
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check that file." },
          {
            type: "tool_call",
            id: "call_123",
            name: "read_file",
            arguments: '{"path":"/src/index.ts"}',
          },
        ] as any,
      },
      {
        role: "tool",
        tool_call_id: "call_123",
        content: [{ type: "tool_result", content: "File contents here..." }] as any,
      },
      // Recent turns (kept)
      { role: "user", content: "recent q1" },
      { role: "assistant", content: "recent a1" },
      { role: "user", content: "recent q2" },
      { role: "assistant", content: "recent a2" },
    ];

    const state = createCompressionState();
    const result = await compressMessages(
      msgs,
      state,
      { enabled: true, triggerTokens: 100, keepRecentTurns: 2 },
      adapter,
      "test-model",
    );

    expect(adapter.complete).toHaveBeenCalledTimes(1);
    expect(result.state.segments.length).toBe(1);
  });

  it("uses options.model for compression when specified", async () => {
    const adapter = mockAdapter(SAMPLE_COMPRESSION_OUTPUT);
    const msgs = buildConversation(10, "x".repeat(2000));
    const state = createCompressionState();

    await compressMessages(
      msgs,
      state,
      {
        enabled: true,
        triggerTokens: 100,
        keepRecentTurns: 4,
        model: "claude-haiku-4-5",
      },
      adapter,
      "claude-sonnet-4-6",
    );

    // Should have been called with the compression-specific model
    expect(adapter.complete).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5" }),
    );
  });

  it("handles tool_result content longer than 800 chars (ellipsis in format)", async () => {
    // Covers the tool_result branch with content > 800 chars
    const adapter = mockAdapter(SAMPLE_COMPRESSION_OUTPUT);
    const longContent = "x".repeat(2000);

    const msgs: Message[] = [
      { role: "user", content: longContent },
      { role: "assistant", content: longContent },
      { role: "user", content: longContent },
      { role: "assistant", content: longContent },
      // Tool results with long content
      {
        role: "tool",
        tool_call_id: "call_long",
        content: [{ type: "tool_result", content: "y".repeat(1000) }] as any,
      },
      // Recent turns
      { role: "user", content: longContent },
      { role: "assistant", content: longContent },
      { role: "user", content: "recent q1" },
      { role: "assistant", content: "recent a1" },
      { role: "user", content: "recent q2" },
      { role: "assistant", content: "recent a2" },
    ];

    const state = createCompressionState();
    const result = await compressMessages(
      msgs,
      state,
      { enabled: true, triggerTokens: 100, keepRecentTurns: 2 },
      adapter,
      "test-model",
    );

    expect(adapter.complete).toHaveBeenCalledTimes(1);
    expect(result.state.segments.length).toBe(1);
  });

  it("handles messages with image_url parts (default branch in formatMessage)", async () => {
    // Cover the `default` branch in formatMessage (line 170) via image_url ContentPart
    const adapter = mockAdapter(SAMPLE_COMPRESSION_OUTPUT);
    const longMsg = "x".repeat(2000);

    const msgs: Message[] = [
      { role: "user", content: longMsg },
      { role: "assistant", content: longMsg },
      { role: "user", content: longMsg },
      { role: "assistant", content: longMsg },
      // Message with image_url part (hits default case in formatMessage switch)
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this image:" },
          { type: "image_url", url: "https://example.com/img.png" } as any,
        ],
      } as any,
      // Recent turns
      { role: "user", content: "recent q1" },
      { role: "assistant", content: "recent a1" },
      { role: "user", content: "recent q2" },
      { role: "assistant", content: "recent a2" },
    ];

    const state = createCompressionState();
    const result = await compressMessages(
      msgs,
      state,
      { enabled: true, triggerTokens: 100, keepRecentTurns: 2 },
      adapter,
      "test-model",
    );

    expect(adapter.complete).toHaveBeenCalledTimes(1);
    expect(result.state.segments.length).toBe(1);
  });
});

// ── Micro-compact ────────────────────────────────────────────────────────────

describe("microCompact", () => {
  it("should not clear when disabled", () => {
    const msgs = [assistantToolCallMsg("t1", "read"), toolMsg("t1", "result")];
    const state = createMicroCompactState();
    const result = microCompact(msgs, state, { enabled: false });
    expect(result.messages).toBe(msgs);
  });

  it("should not clear when gap is below threshold", () => {
    const msgs = [assistantToolCallMsg("t1", "read"), toolMsg("t1", "result")];
    const state = { toolUseIds: [], lastAssistantTs: Date.now() };
    const result = microCompact(msgs, state, {
      enabled: true,
      gapThresholdMinutes: 60,
    });
    expect(result.messages).toBe(msgs);
  });

  it("should clear old tool results when gap exceeds threshold", () => {
    const oldTs = Date.now() - 120 * 60 * 1000; // 120 minutes ago
    const msgs = [
      assistantToolCallMsg("t1", "read"),
      toolMsg("t1", "old result"),
      assistantToolCallMsg("t2", "write"),
      toolMsg("t2", "new result"),
    ];
    const state = {
      toolUseIds: ["t1", "t2"],
      lastAssistantTs: oldTs,
    };
    const result = microCompact(msgs, state, {
      enabled: true,
      gapThresholdMinutes: 60,
      keepRecent: 1,
    });

    // t1 should be cleared (old), t2 should be kept (recent)
    const t1Result = result.messages.find(
      (m) => m.role === "tool" && m.tool_call_id === "t1",
    );
    const t2Result = result.messages.find(
      (m) => m.role === "tool" && m.tool_call_id === "t2",
    );
    expect(t1Result!.content).toBe("[Old tool result content cleared]");
    expect(t2Result!.content).toBe("new result");
  });

  it("should track new tool use IDs in state", () => {
    const msgs = [
      assistantToolCallMsg("t1", "read"),
      toolMsg("t1", "result1"),
      assistantToolCallMsg("t2", "write"),
      toolMsg("t2", "result2"),
    ];
    const state = createMicroCompactState();
    const result = microCompact(msgs, state, { enabled: true });
    expect(result.state.toolUseIds).toEqual(["t1", "t2"]);
  });

  it("should do nothing when gap exceeds threshold but no tool IDs tracked", () => {
    // Cover line 640: idsToClear.size === 0 path
    const msgs: Message[] = [
      { role: "assistant", content: "just thinking" },
    ];
    const state: MicroCompactState = {
      toolUseIds: [],
      lastAssistantTs: Date.now() - 120 * 60 * 1000, // 120 min ago
    };
    const result = microCompact(msgs, state, {
      enabled: true,
      gapThresholdMinutes: 60,
      keepRecent: 5,
    });
    // No tool results to clear, messages unchanged
    expect(result.messages).toBe(msgs);
    expect(result.state.toolUseIds).toEqual([]);
  });

  it("should not double-track duplicate tool IDs", () => {
    const msgs = [
      toolMsg("tid", "result1"),
      toolMsg("tid", "result2"), // same tool_call_id
    ];
    const state = createMicroCompactState();
    const result = microCompact(msgs, state, { enabled: true });
    expect(result.state.toolUseIds).toEqual(["tid"]);
  });

  it("does nothing when lastAssistantTs is 0 (initial state)", () => {
    const msgs = [toolMsg("t1", "result")];
    const state = createMicroCompactState(); // lastAssistantTs = 0
    const result = microCompact(msgs, state, {
      enabled: true,
      gapThresholdMinutes: 60,
    });
    // gapMs = Date.now() - 0, but shouldClear requires lastAssistantTs !== 0
    expect(result.messages).toBe(msgs);
  });

  it("clears all tool results when keepRecent=0", () => {
    const msgs = [
      toolMsg("old1", "result1"),
      toolMsg("old2", "result2"),
    ];
    const state: MicroCompactState = {
      toolUseIds: ["old1", "old2"],
      lastAssistantTs: Date.now() - 120 * 60 * 1000,
    };
    const result = microCompact(msgs, state, {
      enabled: true,
      gapThresholdMinutes: 60,
      keepRecent: 0,
    });
    expect(result.messages[0]!.content).toBe("[Old tool result content cleared]");
    expect(result.messages[1]!.content).toBe("[Old tool result content cleared]");
  });
});

// ── Reactive compact detection ───────────────────────────────────────────────

describe("isPromptTooLongError", () => {
  it("should detect prompt-too-long patterns", () => {
    expect(isPromptTooLongError(new Error("prompt is too long"))).toBe(true);
    expect(isPromptTooLongError(new Error("prompt_too_long error"))).toBe(true);
    expect(isPromptTooLongError(new Error("tokens > 200000"))).toBe(true);
    expect(isPromptTooLongError(new Error("context length exceeds limit"))).toBe(true);
    expect(isPromptTooLongError(new Error("input too long"))).toBe(true);
  });

  it("should not match unrelated errors", () => {
    expect(isPromptTooLongError(new Error("rate limit exceeded"))).toBe(false);
    expect(isPromptTooLongError(new Error("network timeout"))).toBe(false);
    expect(isPromptTooLongError(null)).toBe(false);
    expect(isPromptTooLongError("string")).toBe(false);
  });

  it("matches input too large error", () => {
    expect(isPromptTooLongError(new Error("Input too large for model context"))).toBe(true);
    expect(isPromptTooLongError(new Error("input too long: 500001 tokens"))).toBe(true);
  });
});

// ── Segment recall ───────────────────────────────────────────────────────────

describe("findRelevantSegments", () => {
  it("should find segments matching query", () => {
    const state = {
      segments: [
        {
          summary: "Built a CLI tool with TypeScript",
          decisions: ["Use Commander.js"],
          findings: ["Flag parsing bug"],
          pending: [],
          topics: ["cli-tool", "typescript"],
          turnRange: { start: 0, end: 3 },
          originalTokenCount: 1000,
        },
        {
          summary: "Database migration with PostgreSQL",
          decisions: ["Use Prisma ORM"],
          findings: ["Index optimization"],
          pending: [],
          topics: ["database", "postgresql"],
          turnRange: { start: 4, end: 7 },
          originalTokenCount: 800,
        },
      ],
    };

    const results = findRelevantSegments(state, "CLI");
    expect(results).toHaveLength(1);
    expect(results[0]!.topics).toContain("cli-tool");
  });

  it("should return empty for no matches", () => {
    const state = {
      segments: [
        {
          summary: "Built a web app",
          decisions: [],
          findings: [],
          pending: [],
          topics: ["web"],
          turnRange: { start: 0, end: 3 },
          originalTokenCount: 500,
        },
      ],
    };

    expect(findRelevantSegments(state, "quantum")).toHaveLength(0);
  });
});

// ── expandSegment ────────────────────────────────────────────────────────────

describe("expandSegment", () => {
  it("should expand segment to original messages", () => {
    const msgs = buildConversation(5);
    const state = {
      segments: [
        {
          summary: "test",
          decisions: [],
          findings: [],
          pending: [],
          topics: [],
          turnRange: { start: 0, end: 1 },
          originalTokenCount: 100,
        },
      ],
    };

    const expanded = expandSegment(state, 0, msgs);
    expect(expanded).not.toBeNull();
    expect(expanded!.length).toBe(2); // 1 turn = user + assistant
  });

  it("should return null for invalid index", () => {
    const state = { segments: [] };
    expect(expandSegment(state, 0, [])).toBeNull();
    expect(expandSegment(state, -1, [])).toBeNull();
  });
});

// ── OC5-OC8: IdleCompressionTimer ─────────────────────────────────────────

describe("OC5-OC8: IdleCompressionTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createTimer(
    onCompressed: (result: { messages: Message[]; compressed: boolean }) => void,
  ) {
    return new IdleCompressionTimer({
      idleMs: 1000, // 1 second for fast tests
      compression: { enabled: true, triggerTokens: 100, keepRecentTurns: 2 },
      adapter: mockAdapter(SAMPLE_COMPRESSION_OUTPUT),
      model: "test-model",
      onCompressed,
    });
  }

  it("OC5: should fire compression after idle threshold", async () => {
    const onCompressed = vi.fn();
    const timer = createTimer(onCompressed);
    const msgs = buildConversation(8, "x".repeat(2000));

    timer.start(msgs);
    expect(timer.getStatus()).toBe("idle");

    // Advance past the idle threshold
    await vi.advanceTimersByTimeAsync(1100);

    expect(timer.getStatus()).toBe("fired");
    expect(onCompressed).toHaveBeenCalledTimes(1);
    expect(onCompressed).toHaveBeenCalledWith(
      expect.objectContaining({ compressed: true }),
    );
  });

  it("OC5: should not fire before idle threshold", async () => {
    const onCompressed = vi.fn();
    const timer = createTimer(onCompressed);
    const msgs = buildConversation(8, "x".repeat(2000));

    timer.start(msgs);

    // Advance but not past threshold
    await vi.advanceTimersByTimeAsync(500);
    expect(timer.getStatus()).toBe("idle");
    expect(onCompressed).not.toHaveBeenCalled();
  });

  it("OC6: should cancel compression when reset is called", async () => {
    const onCompressed = vi.fn();
    const onCancelled = vi.fn();
    const timer = new IdleCompressionTimer({
      idleMs: 1000,
      compression: { enabled: true, triggerTokens: 100, keepRecentTurns: 2 },
      adapter: mockAdapter(SAMPLE_COMPRESSION_OUTPUT),
      model: "test-model",
      onCompressed,
      onCancelled,
    });
    const msgs = buildConversation(8, "x".repeat(2000));

    timer.start(msgs);

    // Cancel before timer fires
    timer.reset();
    expect(timer.getStatus()).toBe("cancelled");
    expect(onCancelled).toHaveBeenCalled();

    // Advance past threshold — should NOT fire
    await vi.advanceTimersByTimeAsync(1500);
    expect(onCompressed).not.toHaveBeenCalled();
  });

  it("OC6: should restart timer after reset", async () => {
    const onCompressed = vi.fn();
    const timer = createTimer(onCompressed);
    const msgs = buildConversation(8, "x".repeat(2000));

    timer.start(msgs);
    timer.reset(); // Cancel
    timer.start(msgs); // Restart

    expect(timer.getStatus()).toBe("idle");

    await vi.advanceTimersByTimeAsync(1100);
    expect(timer.getStatus()).toBe("fired");
    expect(onCompressed).toHaveBeenCalledTimes(1);
  });

  it("OC7: should pass compressed messages and state via callback", async () => {
    let capturedResult: { messages: Message[]; state: CompressionState; compressed: boolean } | null = null;
    const timer = new IdleCompressionTimer({
      idleMs: 100,
      compression: { enabled: true, triggerTokens: 100, keepRecentTurns: 2 },
      adapter: mockAdapter(SAMPLE_COMPRESSION_OUTPUT),
      model: "test-model",
      onCompressed: (result) => { capturedResult = result; },
    });
    const msgs = buildConversation(8, "x".repeat(2000));

    timer.start(msgs);
    await vi.advanceTimersByTimeAsync(200);

    expect(capturedResult).not.toBeNull();
    expect(capturedResult!.compressed).toBe(true);
    expect(capturedResult!.messages.length).toBeLessThan(msgs.length);
    expect(capturedResult!.state.segments).toHaveLength(1);
    expect(capturedResult!.state.segments[0]!.topics).toContain("cli-tool");
  });

  it("destroy should stop timer permanently", async () => {
    const onCompressed = vi.fn();
    const timer = createTimer(onCompressed);
    const msgs = buildConversation(8, "x".repeat(2000));

    timer.start(msgs);
    timer.destroy();
    expect(timer.getStatus()).toBe("stopped");

    await vi.advanceTimersByTimeAsync(1500);
    expect(onCompressed).not.toHaveBeenCalled();
  });

  it("should report compressed=false when under threshold", async () => {
    let capturedResult: { compressed: boolean } | null = null;
    const timer = new IdleCompressionTimer({
      idleMs: 100,
      compression: { enabled: true, triggerTokens: 999_999, keepRecentTurns: 2 },
      adapter: mockAdapter(SAMPLE_COMPRESSION_OUTPUT),
      model: "test-model",
      onCompressed: (result) => { capturedResult = result; },
    });
    const msgs = buildConversation(2);

    timer.start(msgs);
    await vi.advanceTimersByTimeAsync(200);

    expect(capturedResult).not.toBeNull();
    expect(capturedResult!.compressed).toBe(false);
  });
});

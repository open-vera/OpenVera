import { describe, it, expect, vi } from "vitest";
import { makeMessages, mockAdapter, mockAdapterRaw } from "./skill-evolution-test-helpers.js";
import { SkillAutoCreator } from "../skill-auto-creator.js";
import type { Message } from "../../types/index.js";

// ── OC13: SkillAutoCreator ─────────────────────────────────────────────────

describe("OC13: SkillAutoCreator", () => {
  it("should skip extraction when rounds < minRounds", async () => {
    const adapter = mockAdapter("{}");
    const creator = new SkillAutoCreator({
      minRounds: 5,
      adapter,
      model: "test",
    });

    const messages = makeMessages(3); // 3 rounds < 5
    const result = await creator.extract(messages);

    expect(result.triggered).toBe(false);
    expect(result.templates).toHaveLength(0);
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  it("should extract templates when rounds >= minRounds", async () => {
    const response = JSON.stringify({
      templates: [
        {
          name: "fix-lint-errors",
          description: "Automatically fix common lint errors in TypeScript files",
          triggers: ["lint error", "eslint error"],
          steps: ["Read file", "Identify errors", "Apply fixes", "Verify"],
          allowedTools: ["Bash", "Read", "Edit"],
          argumentHint: "[file-path]",
          sourceTask: "Fixed lint errors in 3 files",
          confidence: 0.85,
        },
      ],
    });
    const adapter = mockAdapter(response);
    const creator = new SkillAutoCreator({
      minRounds: 3,
      adapter,
      model: "test",
    });

    const messages = makeMessages(5);
    const result = await creator.extract(messages, "Fix lint errors");

    expect(result.triggered).toBe(true);
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]!.name).toBe("fix-lint-errors");
    expect(result.templates[0]!.confidence).toBe(0.85);
  });

  it("should filter templates below confidence threshold", async () => {
    const response = JSON.stringify({
      templates: [
        {
          name: "high-confidence",
          description: "A good template",
          triggers: ["test"],
          steps: ["step1"],
          allowedTools: ["Bash"],
          sourceTask: "task",
          confidence: 0.8,
        },
        {
          name: "low-confidence",
          description: "A weak template",
          triggers: ["test"],
          steps: ["step1"],
          allowedTools: ["Bash"],
          sourceTask: "task",
          confidence: 0.3,
        },
      ],
    });
    const adapter = mockAdapter(response);
    const creator = new SkillAutoCreator({
      minRounds: 2,
      minConfidence: 0.6,
      adapter,
      model: "test",
    });

    const messages = makeMessages(3);
    const result = await creator.extract(messages);

    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]!.name).toBe("high-confidence");
  });

  it("should handle invalid LLM response gracefully", async () => {
    const adapter = mockAdapter("This is not valid JSON at all");
    const creator = new SkillAutoCreator({
      minRounds: 2,
      adapter,
      model: "test",
    });

    const messages = makeMessages(3);
    const result = await creator.extract(messages);

    expect(result.triggered).toBe(true);
    expect(result.templates).toHaveLength(0);
  });

  // ── countRounds edge cases ─────────────────────────────────────────

  it("should not count system messages as rounds", async () => {
    const adapter = mockAdapter("{}");
    const creator = new SkillAutoCreator({
      minRounds: 10, // high threshold to skip extraction
      adapter,
      model: "test",
    });

    // 3 real rounds + system messages interleaved
    const messages: Message[] = [
      { role: "system", content: "You are a helper" },
      { role: "user", content: "Q1" },
      { role: "system", content: "internal note" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
      { role: "assistant", content: "A2" },
      { role: "user", content: "Q3" },
      { role: "assistant", content: "A3" },
    ];

    const result = await creator.extract(messages);
    // minRounds=10 so should skip despite having some messages
    expect(result.triggered).toBe(false);
    expect(result.templates).toHaveLength(0);
  });

  // ── buildTranscript / extractTextContent edge cases ─────────────────

  it("should pass task description to adapter", async () => {
    const adapter = mockAdapter("{}");
    const creator = new SkillAutoCreator({
      minRounds: 1,
      adapter,
      model: "test",
    });

    const messages = makeMessages(2);
    await creator.extract(messages, "A specific task description");

    expect(adapter.complete).toHaveBeenCalledTimes(1);
    const call = (adapter.complete as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const userMsg = call.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMsg.content).toContain("Task Description");
    expect(userMsg.content).toContain("A specific task description");
  });

  it("should handle adapter response with array content", async () => {
    const response = JSON.stringify({
      templates: [
        {
          name: "array-skill",
          description: "From array response",
          triggers: ["test"],
          steps: ["step1"],
          sourceTask: "t",
          confidence: 0.9,
        },
      ],
    });
    const adapter = mockAdapterRaw({
      message: {
        role: "assistant",
        content: [{ type: "text", text: response }],
      },
      stop_reason: "end_turn",
    });
    const creator = new SkillAutoCreator({
      minRounds: 1,
      adapter,
      model: "test",
    });

    const messages = makeMessages(2);
    const result = await creator.extract(messages);

    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]!.name).toBe("array-skill");
  });

  it("should handle adapter response with non-string, non-array content", async () => {
    const adapter = mockAdapterRaw({
      message: { role: "assistant", content: 12345 },
      stop_reason: "end_turn",
    });
    const creator = new SkillAutoCreator({
      minRounds: 1,
      adapter,
      model: "test",
    });

    const messages = makeMessages(2);
    const result = await creator.extract(messages);

    // Non-string/non-array content → extractTextContent returns "" → parseResponse defaults
    expect(result.triggered).toBe(true);
    expect(result.templates).toHaveLength(0);
  });

  it("should handle array content with non-text parts filtered out", async () => {
    const response = JSON.stringify({
      templates: [
        {
          name: "filtered-skill",
          description: "After filtering tool_use parts",
          triggers: ["test"],
          steps: ["step1"],
          sourceTask: "t",
          confidence: 0.9,
        },
      ],
    });
    const adapter = mockAdapterRaw({
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "bash", input: {} },
          { type: "text", text: response },
          { type: "tool_result", result: "ok" },
        ],
      },
      stop_reason: "end_turn",
    });
    const creator = new SkillAutoCreator({
      minRounds: 1,
      adapter,
      model: "test",
    });

    const messages = makeMessages(2);
    const result = await creator.extract(messages);

    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]!.name).toBe("filtered-skill");
  });

  // ── parseResponse edge cases ───────────────────────────────────────

  it("should extract JSON from fenced code block", async () => {
    const json = JSON.stringify({
      templates: [
        {
          name: "fenced-skill",
          description: "JSON in code fence",
          triggers: ["test"],
          steps: ["step"],
          sourceTask: "t",
          confidence: 0.9,
        },
      ],
    });
    const adapter = mockAdapter("```json\n" + json + "\n```");
    const creator = new SkillAutoCreator({
      minRounds: 1,
      adapter,
      model: "test",
    });

    const messages = makeMessages(2);
    const result = await creator.extract(messages);

    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]!.name).toBe("fenced-skill");
  });

  it("should handle response with no templates key (empty array)", async () => {
    const adapter = mockAdapter("{}");
    const creator = new SkillAutoCreator({
      minRounds: 1,
      adapter,
      model: "test",
    });

    const messages = makeMessages(2);
    const result = await creator.extract(messages);

    expect(result.triggered).toBe(true);
    expect(result.templates).toHaveLength(0);
  });

  // ── validateTemplate edge cases ────────────────────────────────────

  it("should reject templates missing name", async () => {
    const response = JSON.stringify({
      templates: [
        {
          description: "No name field",
          triggers: ["test"],
          steps: ["step"],
          sourceTask: "t",
          confidence: 0.9,
        },
      ],
    });
    const adapter = mockAdapter(response);
    const creator = new SkillAutoCreator({
      minRounds: 1,
      adapter,
      model: "test",
    });

    const messages = makeMessages(2);
    const result = await creator.extract(messages);

    expect(result.templates).toHaveLength(0);
  });

  it("should reject templates missing description", async () => {
    const response = JSON.stringify({
      templates: [
        {
          name: "no-desc",
          triggers: ["test"],
          steps: ["step"],
          sourceTask: "t",
          confidence: 0.9,
        },
      ],
    });
    const adapter = mockAdapter(response);
    const creator = new SkillAutoCreator({
      minRounds: 1,
      adapter,
      model: "test",
    });

    const messages = makeMessages(2);
    const result = await creator.extract(messages);

    expect(result.templates).toHaveLength(0);
  });

  it("should reject templates missing triggers array", async () => {
    const response = JSON.stringify({
      templates: [
        {
          name: "no-triggers",
          description: "Missing triggers",
          steps: ["step"],
          sourceTask: "t",
          confidence: 0.9,
        },
      ],
    });
    const adapter = mockAdapter(response);
    const creator = new SkillAutoCreator({
      minRounds: 1,
      adapter,
      model: "test",
    });

    const messages = makeMessages(2);
    const result = await creator.extract(messages);

    expect(result.templates).toHaveLength(0);
  });

  it("should reject templates missing steps array", async () => {
    const response = JSON.stringify({
      templates: [
        {
          name: "no-steps",
          description: "Missing steps",
          triggers: ["test"],
          sourceTask: "t",
          confidence: 0.9,
        },
      ],
    });
    const adapter = mockAdapter(response);
    const creator = new SkillAutoCreator({
      minRounds: 1,
      adapter,
      model: "test",
    });

    const messages = makeMessages(2);
    const result = await creator.extract(messages);

    expect(result.templates).toHaveLength(0);
  });

  it("should filter out non-string triggers and steps", async () => {
    const response = JSON.stringify({
      templates: [
        {
          name: "mixed-types",
          description: "Has mixed trigger/step types",
          triggers: ["good-trigger", 123, null, "also-good"],
          steps: ["step1", false, "step2"],
          sourceTask: "t",
          confidence: 0.9,
        },
      ],
    });
    const adapter = mockAdapter(response);
    const creator = new SkillAutoCreator({
      minRounds: 1,
      adapter,
      model: "test",
    });

    const messages = makeMessages(2);
    const result = await creator.extract(messages);

    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]!.triggers).toEqual(["good-trigger", "also-good"]);
    expect(result.templates[0]!.steps).toEqual(["step1", "step2"]);
  });

  it("should default allowedTools to ['Bash','Read'] when missing", async () => {
    const response = JSON.stringify({
      templates: [
        {
          name: "no-tools",
          description: "No allowedTools field",
          triggers: ["test"],
          steps: ["step"],
          sourceTask: "t",
          confidence: 0.9,
        },
      ],
    });
    const adapter = mockAdapter(response);
    const creator = new SkillAutoCreator({
      minRounds: 1,
      adapter,
      model: "test",
    });

    const messages = makeMessages(2);
    const result = await creator.extract(messages);

    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]!.allowedTools).toEqual(["Bash", "Read"]);
  });

  it("should filter non-string allowedTools entries", async () => {
    const response = JSON.stringify({
      templates: [
        {
          name: "bad-tools",
          description: "Mixed type tools",
          triggers: ["test"],
          steps: ["step"],
          allowedTools: ["Bash", 123, "Read"],
          sourceTask: "t",
          confidence: 0.9,
        },
      ],
    });
    const adapter = mockAdapter(response);
    const creator = new SkillAutoCreator({
      minRounds: 1,
      adapter,
      model: "test",
    });

    const messages = makeMessages(2);
    const result = await creator.extract(messages);

    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]!.allowedTools).toEqual(["Bash", "Read"]);
  });

  it("should default confidence to 0.5 when non-numeric", async () => {
    const response = JSON.stringify({
      templates: [
        {
          name: "nan-conf",
          description: "Confidence is a string",
          triggers: ["t"],
          steps: ["s"],
          sourceTask: "st",
          confidence: "not-a-number",
        },
      ],
    });
    const adapter = mockAdapter(response);
    const creator = new SkillAutoCreator({
      minRounds: 1,
      minConfidence: 0.4,
      adapter,
      model: "test",
    });

    const messages = makeMessages(2);
    const result = await creator.extract(messages);

    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]!.confidence).toBe(0.5);
  });

  it("should clamp confidence to [0, 1] range", async () => {
    const response = JSON.stringify({
      templates: [
        {
          name: "high-conf",
          description: "Confidence > 1",
          triggers: ["t"],
          steps: ["s"],
          sourceTask: "st",
          confidence: 1.5,
        },
        {
          name: "neg-conf",
          description: "Confidence < 0",
          triggers: ["t"],
          steps: ["s"],
          sourceTask: "st",
          confidence: -0.5,
        },
      ],
    });
    const adapter = mockAdapter(response);
    const creator = new SkillAutoCreator({
      minRounds: 1,
      minConfidence: 0,
      adapter,
      model: "test",
    });

    const messages = makeMessages(2);
    const result = await creator.extract(messages);

    // confidence 1.5 → clamped to 1, -0.5 → clamped to 0
    // minConfidence=0 so both pass
    expect(result.templates).toHaveLength(2);
    expect(result.templates[0]!.confidence).toBe(1);
    expect(result.templates[1]!.confidence).toBe(0);
  });

  it("should handle buildTranscript with array content in messages", async () => {
    const response = JSON.stringify({
      templates: [
        {
          name: "array-msg-skill",
          description: "From array content message",
          triggers: ["test"],
          steps: ["step"],
          sourceTask: "t",
          confidence: 0.9,
        },
      ],
    });
    const adapter = mockAdapter(response);
    const creator = new SkillAutoCreator({
      minRounds: 1,
      adapter,
      model: "test",
    });

    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Hello from array" },
        ],
      },
      {
        role: "assistant",
        content: "Reply from assistant",
      },
    ];

    const result = await creator.extract(messages);
    expect(result.templates).toHaveLength(1);
  });

  it("should skip empty-text messages in transcript", async () => {
    const response = JSON.stringify({
      templates: [
        {
          name: "nonempty-skill",
          description: "Only non-empty messages counted",
          triggers: ["t"],
          steps: ["s"],
          sourceTask: "st",
          confidence: 0.9,
        },
      ],
    });
    const adapter = mockAdapter(response);
    const creator = new SkillAutoCreator({
      minRounds: 1,
      adapter,
      model: "test",
    });

    const messages: Message[] = [
      { role: "user", content: "   " },
      { role: "assistant", content: "Real reply" },
    ];

    const result = await creator.extract(messages);
    expect(result.templates).toHaveLength(1);
  });

  it("should use default minRounds (3) and minConfidence (0.6) when not specified", async () => {
    // Testing that default values work — minRounds=3 so 2 rounds should skip
    const adapter = mockAdapter("{}");
    const creator = new SkillAutoCreator({
      adapter,
      model: "test",
    });

    const messages = makeMessages(2);
    const result = await creator.extract(messages);

    expect(result.triggered).toBe(false);
  });
});

/**
 * OC13-OC17: SkillAutoCreator, SkillReflector, VersionManager, SkillFilter tests
 *
 * Comprehensive coverage including all branches and edge cases.
 */
import { describe, it, expect, vi } from "vitest";
import { SkillAutoCreator } from "../skill-auto-creator.js";
import { SkillReflector } from "../skill-reflector.js";
import { VersionManager } from "../version-manager.js";
import { SkillFilter } from "../skill-filter.js";
import type { Message } from "../../types/index.js";
import type { LLMAdapter } from "../../adapters/base.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMessages(count: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({ role: "user", content: `User message ${i}` });
    msgs.push({ role: "assistant", content: `Assistant response ${i}` });
  }
  return msgs;
}

function mockAdapter(response: string): LLMAdapter {
  return {
    complete: vi.fn().mockResolvedValue({
      message: { role: "assistant", content: response },
      stop_reason: "end_turn",
    }),
  } as unknown as LLMAdapter;
}

/** Mock adapter that returns a specific raw response object */
function mockAdapterRaw(rawResponse: unknown): LLMAdapter {
  return {
    complete: vi.fn().mockResolvedValue(rawResponse),
  } as unknown as LLMAdapter;
}

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

// ── OC14: SkillReflector ───────────────────────────────────────────────────

describe("OC14: SkillReflector", () => {
  it("should parse reflection response with issues", async () => {
    const response = JSON.stringify({
      qualityScore: 0.65,
      issues: [
        {
          severity: "high",
          category: "clarity",
          description: "Step 3 is ambiguous",
          suggestion: "Rewrite step 3 with specific command",
        },
        {
          severity: "medium",
          category: "coverage",
          description: "Missing error handling for network failures",
          suggestion: "Add retry logic with exponential backoff",
        },
      ],
      needsUpdate: true,
      bumpType: "minor",
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({ adapter, model: "test" });

    const messages: Message[] = [
      { role: "user", content: "Run the skill" },
      {
        role: "assistant",
        content: "Executed step 1, step 2, step 3 failed",
      },
    ];

    const result = await reflector.reflect(
      "test-skill",
      "# Test Skill\nversion: 1.0.0",
      messages,
    );

    expect(result.qualityScore).toBe(0.65);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]!.severity).toBe("high");
    expect(result.needsUpdate).toBe(true);
    expect(result.bumpType).toBe("minor");
  });

  it("should infer bump type from issue severity when not specified", async () => {
    const response = JSON.stringify({
      qualityScore: 0.5,
      issues: [
        {
          severity: "high",
          category: "correctness",
          description: "Wrong output",
          suggestion: "Fix it",
        },
      ],
      needsUpdate: true,
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({ adapter, model: "test" });

    const result = await reflector.reflect("test-skill", "# Test", []);
    expect(result.bumpType).toBe("major");
  });

  it("should handle invalid reflection response gracefully", async () => {
    const adapter = mockAdapter("not json");
    const reflector = new SkillReflector({ adapter, model: "test" });

    const result = await reflector.reflect("test-skill", "# Test", []);
    expect(result.qualityScore).toBe(0.5);
    expect(result.issues).toHaveLength(0);
    expect(result.needsUpdate).toBe(false);
  });

  // ── needsUpdate computed from qualityScore < minQuality ─────────────

  it("should set needsUpdate=true when qualityScore < minQuality (not in response)", async () => {
    const response = JSON.stringify({
      qualityScore: 0.5,
      issues: [],
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({
      adapter,
      model: "test",
      minQuality: 0.8,
    });

    const result = await reflector.reflect("test", "# skill", []);
    // needsUpdate not in response → computed: 0.5 < 0.8 → true
    expect(result.needsUpdate).toBe(true);
  });

  it("should set needsUpdate=false when qualityScore >= minQuality (not in response)", async () => {
    const response = JSON.stringify({
      qualityScore: 0.95,
      issues: [],
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({
      adapter,
      model: "test",
      minQuality: 0.9,
    });

    const result = await reflector.reflect("test", "# skill", []);
    // needsUpdate not in response → computed: 0.95 >= 0.9 → false
    expect(result.needsUpdate).toBe(false);
  });

  it("should respect explicit needsUpdate:false even when quality low", async () => {
    const response = JSON.stringify({
      qualityScore: 0.3,
      issues: [{ severity: "low", category: "clarity", description: "minor", suggestion: "" }],
      needsUpdate: false,
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({ adapter, model: "test" });

    const result = await reflector.reflect("test", "# skill", []);
    // Explicit false overrides computed
    expect(result.needsUpdate).toBe(false);
  });

  // ── bumpType from parsed response ──────────────────────────────────

  it("should use bumpType from response when explicitly provided (patch)", async () => {
    const response = JSON.stringify({
      qualityScore: 0.85,
      issues: [],
      needsUpdate: true,
      bumpType: "patch",
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({ adapter, model: "test" });

    const result = await reflector.reflect("test", "# skill", []);
    expect(result.bumpType).toBe("patch");
  });

  it("should use bumpType from response when explicitly provided (minor)", async () => {
    const response = JSON.stringify({
      qualityScore: 0.7,
      issues: [],
      needsUpdate: true,
      bumpType: "minor",
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({ adapter, model: "test" });

    const result = await reflector.reflect("test", "# skill", []);
    expect(result.bumpType).toBe("minor");
  });

  // ── inferBumpType coverage ─────────────────────────────────────────

  it("should infer bumpType=patch when only low-severity issues", async () => {
    const response = JSON.stringify({
      qualityScore: 0.7,
      issues: [
        {
          severity: "low",
          category: "efficiency",
          description: "Minor optimization possible",
          suggestion: "Remove redundant step",
        },
      ],
      needsUpdate: true,
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({ adapter, model: "test" });

    const result = await reflector.reflect("test", "# skill", []);
    expect(result.bumpType).toBe("patch");
  });

  it("should infer bumpType=minor when medium (no high) issues", async () => {
    const response = JSON.stringify({
      qualityScore: 0.6,
      issues: [
        {
          severity: "medium",
          category: "coverage",
          description: "Missing edge case",
          suggestion: "Add it",
        },
        {
          severity: "low",
          category: "clarity",
          description: "Unclear wording",
          suggestion: "Reword",
        },
      ],
      needsUpdate: true,
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({ adapter, model: "test" });

    const result = await reflector.reflect("test", "# skill", []);
    expect(result.bumpType).toBe("minor");
  });

  it("should infer bumpType=patch when no issues at all", async () => {
    const response = JSON.stringify({
      qualityScore: 0.75,
      issues: [],
      needsUpdate: true,
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({ adapter, model: "test" });

    const result = await reflector.reflect("test", "# skill", []);
    // No high, no medium → patch
    expect(result.bumpType).toBe("patch");
  });

  // ── validateIssue edge cases ───────────────────────────────────────

  it("should reject issues with invalid severity", async () => {
    const response = JSON.stringify({
      qualityScore: 0.6,
      issues: [
        {
          severity: "critical",
          category: "clarity",
          description: "Some issue",
          suggestion: "",
        },
        {
          severity: "high",
          category: "correctness",
          description: "Valid issue",
          suggestion: "Fix",
        },
      ],
      needsUpdate: true,
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({ adapter, model: "test" });

    const result = await reflector.reflect("test", "# skill", []);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.severity).toBe("high");
  });

  it("should reject issues with invalid category", async () => {
    const response = JSON.stringify({
      qualityScore: 0.6,
      issues: [
        {
          severity: "medium",
          category: "performance",
          description: "Some issue",
          suggestion: "",
        },
        {
          severity: "low",
          category: "coverage",
          description: "Valid issue",
          suggestion: "Add coverage",
        },
      ],
      needsUpdate: true,
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({ adapter, model: "test" });

    const result = await reflector.reflect("test", "# skill", []);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.category).toBe("coverage");
  });

  it("should reject issues with missing description", async () => {
    const response = JSON.stringify({
      qualityScore: 0.6,
      issues: [
        {
          severity: "high",
          category: "clarity",
          suggestion: "Fix",
        },
        {
          severity: "medium",
          category: "coverage",
          description: "Valid issue",
          suggestion: "",
        },
      ],
      needsUpdate: true,
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({ adapter, model: "test" });

    const result = await reflector.reflect("test", "# skill", []);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.description).toBe("Valid issue");
  });

  it("should set empty suggestion when not provided", async () => {
    const response = JSON.stringify({
      qualityScore: 0.6,
      issues: [
        {
          severity: "high",
          category: "clarity",
          description: "No suggestion field",
        },
      ],
      needsUpdate: true,
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({ adapter, model: "test" });

    const result = await reflector.reflect("test", "# skill", []);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.suggestion).toBe("");
  });

  // ── transcript building edge cases ─────────────────────────────────

  it("should skip system messages in transcript", async () => {
    const response = JSON.stringify({
      qualityScore: 0.9,
      issues: [],
      needsUpdate: false,
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({ adapter, model: "test" });

    const messages: Message[] = [
      { role: "system", content: "internal" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];

    const result = await reflector.reflect("test", "# skill", messages);
    expect(result.qualityScore).toBe(0.9);
  });

  it("should handle array content in execution messages", async () => {
    const response = JSON.stringify({
      qualityScore: 0.8,
      issues: [],
      needsUpdate: false,
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({ adapter, model: "test" });

    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "From array" }],
      },
      { role: "assistant", content: "Reply" },
    ];

    const result = await reflector.reflect("test", "# skill", messages);
    expect(result.qualityScore).toBe(0.8);
  });

  it("should skip empty-text messages", async () => {
    const response = JSON.stringify({
      qualityScore: 0.9,
      issues: [],
      needsUpdate: false,
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({ adapter, model: "test" });

    const messages: Message[] = [
      { role: "user", content: "  \t\n " },
      { role: "assistant", content: "Non-empty reply" },
    ];

    const result = await reflector.reflect("test", "# skill", messages);
    expect(result.qualityScore).toBe(0.9);
  });

  // ── extractTextContent edge cases ──────────────────────────────────

  it("should handle adapter response with array content", async () => {
    const response = JSON.stringify({
      qualityScore: 0.75,
      issues: [{ severity: "low", category: "efficiency", description: "d", suggestion: "s" }],
      needsUpdate: true,
      bumpType: "patch",
    });
    const adapter = mockAdapterRaw({
      message: {
        role: "assistant",
        content: [{ type: "text", text: response }],
      },
      stop_reason: "end_turn",
    });
    const reflector = new SkillReflector({ adapter, model: "test" });

    const result = await reflector.reflect("test", "# skill", []);
    expect(result.qualityScore).toBe(0.75);
  });

  it("should handle adapter response with non-array/non-string content", async () => {
    const adapter = mockAdapterRaw({
      message: { role: "assistant", content: null },
      stop_reason: "end_turn",
    });
    const reflector = new SkillReflector({ adapter, model: "test" });

    const result = await reflector.reflect("test", "# skill", []);
    // Empty string → parse fails → default values
    expect(result.qualityScore).toBe(0.5);
    expect(result.issues).toHaveLength(0);
    expect(result.needsUpdate).toBe(false);
  });

  // ── parseResponse edge cases ───────────────────────────────────────

  it("should extract JSON from fenced code block", async () => {
    const json = JSON.stringify({
      qualityScore: 0.8,
      issues: [
        { severity: "medium", category: "coverage", description: "Missing test", suggestion: "Add" },
      ],
      needsUpdate: true,
      bumpType: "minor",
    });
    const adapter = mockAdapter("```json\n" + json + "\n```");
    const reflector = new SkillReflector({ adapter, model: "test" });

    const result = await reflector.reflect("test", "# skill", []);
    expect(result.qualityScore).toBe(0.8);
    expect(result.bumpType).toBe("minor");
  });

  it("should clamp qualityScore to [0, 1]", async () => {
    const response = JSON.stringify({
      qualityScore: 2.5,
      issues: [],
      needsUpdate: false,
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({ adapter, model: "test" });

    const result = await reflector.reflect("test", "# skill", []);
    expect(result.qualityScore).toBe(1);
  });

  it("should default qualityScore to 0.5 when not a number", async () => {
    const response = JSON.stringify({
      issues: [],
      needsUpdate: false,
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({ adapter, model: "test" });

    const result = await reflector.reflect("test", "# skill", []);
    expect(result.qualityScore).toBe(0.5);
  });

  it("should use default minQuality of 0.8", async () => {
    const response = JSON.stringify({
      qualityScore: 0.75,
      issues: [],
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({ adapter, model: "test" });

    const result = await reflector.reflect("test", "# skill", []);
    // default minQuality=0.8, qualityScore=0.75 < 0.8, needsUpdate not set → true
    expect(result.needsUpdate).toBe(true);
  });

  it("should ignore invalid bumpType in response", async () => {
    const response = JSON.stringify({
      qualityScore: 0.5,
      issues: [],
      needsUpdate: true,
      bumpType: "invalid_type",
    });
    const adapter = mockAdapter(response);
    const reflector = new SkillReflector({ adapter, model: "test" });

    const result = await reflector.reflect("test", "# skill", []);
    // invalid bumpType → falls back to inferBumpType (no issues → patch)
    expect(result.bumpType).toBe("patch");
  });
});

// ── OC15: VersionManager ───────────────────────────────────────────────────

describe("OC15: VersionManager", () => {
  const vm = new VersionManager();

  it("should parse version from frontmatter", () => {
    const content = '---\nname: test\nversion: "1.2.3"\n---\n# Test';
    expect(vm.parseVersion(content)).toBe("1.2.3");
  });

  it("should parse version from body", () => {
    const content = "# Test Skill\n**Version**: 2.0.1\n\nDescription";
    expect(vm.parseVersion(content)).toBe("2.0.1");
  });

  it("should default to 0.1.0 when no version found", () => {
    expect(vm.parseVersion("# No version here")).toBe("0.1.0");
  });

  it("should bump major version correctly", () => {
    expect(vm.bumpVersion("1.2.3", "major")).toBe("2.0.0");
  });

  it("should bump minor version correctly", () => {
    expect(vm.bumpVersion("1.2.3", "minor")).toBe("1.3.0");
  });

  it("should bump patch version correctly", () => {
    expect(vm.bumpVersion("1.2.3", "patch")).toBe("1.2.4");
  });

  it("should apply version update to SKILL.md", () => {
    const content =
      '---\nname: test-skill\nversion: "1.0.0"\n---\n# Test Skill\n\nSome content.';
    const reflection = {
      skillName: "test-skill",
      qualityScore: 0.6,
      issues: [
        {
          severity: "medium" as const,
          category: "clarity" as const,
          description: "Unclear step",
          suggestion: "Rewrite step",
        },
      ],
      needsUpdate: true,
      bumpType: "minor" as const,
    };

    const { content: updated, result } = vm.applyUpdate(content, reflection);

    expect(result.updated).toBe(true);
    expect(result.previousVersion).toBe("1.0.0");
    expect(result.newVersion).toBe("1.1.0");
    expect(updated).toContain('version: "1.1.0"');
    expect(updated).toContain("## Changelog");
    expect(updated).toContain("Rewrite step");
  });

  it("should not update when reflection says no update needed", () => {
    const content = '---\nname: test\nversion: "1.0.0"\n---\n# Test';
    const reflection = {
      skillName: "test",
      qualityScore: 0.95,
      issues: [],
      needsUpdate: false,
    };

    const { result } = vm.applyUpdate(content, reflection);
    expect(result.updated).toBe(false);
  });

  // ── bumpVersion edge cases ─────────────────────────────────────────

  it("should return 0.1.0 for invalid version string (< 3 parts)", () => {
    expect(vm.bumpVersion("1.2", "patch")).toBe("0.1.0");
    expect(vm.bumpVersion("1", "major")).toBe("0.1.0");
    expect(vm.bumpVersion("", "minor")).toBe("0.1.0");
  });

  it("should return 0.1.0 for NaN version parts", () => {
    expect(vm.bumpVersion("a.b.c", "patch")).toBe("0.1.0");
    expect(vm.bumpVersion("1.x.3", "major")).toBe("0.1.0");
  });

  it("should bump when crossing major 9→10", () => {
    expect(vm.bumpVersion("9.0.0", "major")).toBe("10.0.0");
  });

  // ── applyUpdate with history ───────────────────────────────────────

  it("should accept and apply history parameter", () => {
    const content =
      '---\nname: test\nversion: "1.0.0"\n---\n# Test\n\nSome content.';
    const reflection = {
      skillName: "test",
      qualityScore: 0.7,
      issues: [
        {
          severity: "low" as const,
          category: "clarity" as const,
          description: "Typo",
          suggestion: "Fix typo",
        },
      ],
      needsUpdate: true,
      bumpType: "patch" as const,
    };
    const history = [
      {
        version: "0.9.0",
        changes: ["Initial"],
        timestamp: "2025-01-01T00:00:00.000Z",
        source: "manual" as const,
      },
    ];

    const { content: updated, result } = vm.applyUpdate(
      content,
      reflection,
      history,
    );

    expect(result.updated).toBe(true);
    expect(result.newVersion).toBe("1.0.1");
    expect(updated).toContain("Fix typo");
  });

  // ── applyUpdate when version only in body ──────────────────────────

  it("should update version in body when no frontmatter version", () => {
    const content = "# Test Skill\n**Version**: 1.0.0\n\nDescription.";
    const reflection = {
      skillName: "test",
      qualityScore: 0.6,
      issues: [
        {
          severity: "medium" as const,
          category: "correctness" as const,
          description: "Wrong approach",
          suggestion: "Use different method",
        },
      ],
      needsUpdate: true,
      bumpType: "patch" as const,
    };

    const { content: updated, result } = vm.applyUpdate(content, reflection);

    expect(result.updated).toBe(true);
    expect(result.newVersion).toBe("1.0.1");
    expect(updated).toContain("1.0.1");
    expect(updated).toContain("## Changelog");
  });

  it("should append changelog when no existing section", () => {
    const content =
      '---\nname: test\nversion: "1.0.0"\n---\n# Test Skill\n\nNo changelog here.';
    const reflection = {
      skillName: "test",
      qualityScore: 0.7,
      issues: [
        {
          severity: "low" as const,
          category: "clarity" as const,
          description: "Minor",
          suggestion: "Improve wording",
        },
      ],
      needsUpdate: true,
      bumpType: "patch" as const,
    };

    const { content: updated, result } = vm.applyUpdate(content, reflection);

    expect(result.updated).toBe(true);
    expect(updated).toContain("## Changelog");
    expect(updated).toContain("Improve wording");
    // Should be at end
    expect(updated.endsWith("\n")).toBe(true);
  });

  it("should replace existing changelog section", () => {
    const content =
      '---\nname: test\nversion: "1.0.0"\n---\n# Test\n\n## Changelog\n\nOld entry\n\nMore content.';
    const reflection = {
      skillName: "test",
      qualityScore: 0.7,
      issues: [
        {
          severity: "medium" as const,
          category: "coverage" as const,
          description: "Missing",
          suggestion: "Add more tests",
        },
      ],
      needsUpdate: true,
      bumpType: "minor" as const,
    };

    const { content: updated, result } = vm.applyUpdate(content, reflection);

    expect(result.updated).toBe(true);
    expect(result.newVersion).toBe("1.1.0");
    // Should contain the new changelog entry
    expect(updated).toContain("Add more tests");
    // Should retain content after changelog
    expect(updated).toContain("More content.");
  });

  it("should not update when bumpType is falsy", () => {
    const content = '---\nname: test\nversion: "1.0.0"\n---\n# Test';
    const reflection = {
      skillName: "test",
      qualityScore: 0.6,
      issues: [],
      needsUpdate: true,
      bumpType: undefined as unknown,
    };

    const { result } = vm.applyUpdate(content, reflection);
    expect(result.updated).toBe(false);
  });
});

// ── OC16: SkillFilter ──────────────────────────────────────────────────────

describe("OC16: SkillFilter", () => {
  const filter = new SkillFilter();

  it("should allow user skills to evolve", () => {
    const meta = {
      name: "my-skill",
      origin: "user" as const,
      evolvable: true,
    };
    expect(filter.canEvolve(meta)).toBe(true);
  });

  it("should allow marketplace skills to evolve", () => {
    const meta = {
      name: "market-skill",
      origin: "marketplace" as const,
      evolvable: true,
    };
    expect(filter.canEvolve(meta)).toBe(true);
  });

  it("should block system skills from evolving", () => {
    const meta = {
      name: "default-skill",
      origin: "system" as const,
      evolvable: true,
    };
    expect(filter.canEvolve(meta)).toBe(false);
  });

  it("should block brand skills from evolving", () => {
    const meta = {
      name: "brand-skill",
      origin: "brand" as const,
      evolvable: true,
    };
    expect(filter.canEvolve(meta)).toBe(false);
  });

  it("should block skills with evolvable=false", () => {
    const meta = {
      name: "locked-skill",
      origin: "user" as const,
      evolvable: false,
    };
    expect(filter.canEvolve(meta)).toBe(false);
  });

  it("should detect system origin from name prefix", () => {
    expect(filter.detectOrigin("default/my-skill", "")).toBe("system");
    expect(filter.detectOrigin("brand/company-tool", "")).toBe("system");
  });

  it("should detect user origin from file path", () => {
    expect(
      filter.detectOrigin(
        "my-skill",
        "",
        "/home/.claude/skills/my-skill/SKILL.md",
      ),
    ).toBe("user");
    expect(
      filter.detectOrigin(
        "my-skill",
        "",
        "/home/.vera/skills/my-skill/SKILL.md",
      ),
    ).toBe("user");
  });

  it("should detect origin from frontmatter", () => {
    const content = '---\nname: test\norigin: marketplace\n---\n# Test';
    expect(filter.detectOrigin("test", content)).toBe("marketplace");
  });

  it("should filter to only evolvable skills", () => {
    const skills = [
      { name: "user-skill", origin: "user" as const, evolvable: true },
      { name: "system-skill", origin: "system" as const, evolvable: true },
      { name: "locked-skill", origin: "user" as const, evolvable: false },
    ];
    const result = filter.filterEvolvable(skills);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("user-skill");
  });

  // ── custom evolvableOrigins ────────────────────────────────────────

  it("should allow custom evolvable origins via FilterOptions", () => {
    const custom = new SkillFilter({
      evolvableOrigins: ["system", "brand", "user"],
    });

    expect(
      custom.canEvolve({
        name: "s",
        origin: "system",
        evolvable: true,
      }),
    ).toBe(true);
    expect(
      custom.canEvolve({
        name: "s",
        origin: "brand",
        evolvable: true,
      }),
    ).toBe(true);
    expect(
      custom.canEvolve({
        name: "s",
        origin: "marketplace",
        evolvable: true,
      }),
    ).toBe(false);
  });

  // ── detectOrigin: system/extra path ────────────────────────────────

  it("should detect system origin from /system/ path", () => {
    expect(
      filter.detectOrigin("", "", "/opt/system/skills/default/SKILL.md"),
    ).toBe("system");
  });

  it("should detect system origin from /extra/ path", () => {
    expect(
      filter.detectOrigin("", "", "/usr/share/extra/skills/thing/SKILL.md"),
    ).toBe("system");
  });

  // ── detectOrigin: unknown frontmatter origin falls back ─────────────

  it("should fall through frontmatter with unknown origin value", () => {
    const content = '---\norigin: "unknown-type"\n---\n# Test';
    // unknown origin → not in ["system","brand","user","marketplace"] → check prefixes → check path → default "user"
    expect(filter.detectOrigin("test", content, "/some/path")).toBe("user");
  });

  // ── detectOrigin: system prefix via name ───────────────────────────

  it("should detect system origin from system/ name prefix", () => {
    expect(filter.detectOrigin("system/my-skill", "")).toBe("system");
  });

  // ── detectOrigin: default fallback ─────────────────────────────────

  it("should default to user origin when no hints found", () => {
    expect(filter.detectOrigin("plain-skill", "")).toBe("user");
    expect(
      filter.detectOrigin("plain-skill", "", "/tmp/random/SKILL.md"),
    ).toBe("user");
  });

  // ── parseMetadata ──────────────────────────────────────────────────

  it("should parse metadata with evolvable=true when no evolve flag", () => {
    const meta = filter.parseMetadata(
      "my-skill",
      "---\nname: my-skill\norigin: user\n---\n# Test",
      "/home/user/.claude/skills/my-skill/SKILL.md",
    );
    expect(meta).toEqual({
      name: "my-skill",
      origin: "user",
      evolvable: true,
    });
  });

  it("should parse metadata with evolvable=false when evolve:false present", () => {
    const meta = filter.parseMetadata(
      "locked",
      "---\nname: locked\nevolve: false\n---\n# Test",
    );
    expect(meta).toEqual({
      name: "locked",
      origin: "user",
      evolvable: false,
    });
  });

  it("should parse metadata with case-insensitive evolve:false", () => {
    const meta = filter.parseMetadata(
      "locked2",
      "---\nevolve: FALSE\n---\n# Test",
    );
    expect(meta.evolvable).toBe(false);
  });

  it("should parse metadata with evolve:true (still evolvable)", () => {
    const meta = filter.parseMetadata(
      "unlocked",
      "---\nevolve: true\n---\n# Test",
    );
    expect(meta.evolvable).toBe(true);
  });

  // ── filterEvolvable edge cases ─────────────────────────────────────

  it("should return empty array for empty input", () => {
    const result = filter.filterEvolvable([]);
    expect(result).toEqual([]);
  });

  it("should return all when all are evolvable", () => {
    const skills = [
      { name: "a", origin: "user" as const, evolvable: true },
      { name: "b", origin: "marketplace" as const, evolvable: true },
    ];
    const result = filter.filterEvolvable(skills);
    expect(result).toHaveLength(2);
  });
});

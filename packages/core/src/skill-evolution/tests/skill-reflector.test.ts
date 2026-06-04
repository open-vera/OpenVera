import { describe, it, expect, vi } from "vitest";
import { makeMessages, mockAdapter, mockAdapterRaw } from "./skill-evolution-test-helpers.js";
import { SkillReflector } from "../skill-reflector.js";
import type { Message } from "../../types/index.js";

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

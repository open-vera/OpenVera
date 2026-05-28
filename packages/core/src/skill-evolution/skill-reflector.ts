/**
 * SkillReflector — OC14
 *
 * Post-execution reflection agent. After a skill runs, analyzes the
 * execution transcript to assess instruction clarity, edge case coverage,
 * and overall quality. Outputs structured reflection with improvement suggestions.
 *
 * Flow:
 *   1. Read skill content (SKILL.md)
 *   2. Analyze execution transcript
 *   3. LLM evaluates quality and identifies issues
 *   4. Return structured reflection with suggested bump type
 */

import type { LLMAdapter } from "../adapters/base.js";
import type { Message } from "../types/index.js";
import type { SkillReflection, ReflectionIssue, ReflectorOptions } from "./types.js";

const REFLECT_SYSTEM_PROMPT = `You are a skill quality reviewer. Analyze a skill's content and its execution transcript to assess quality and find issues.

Evaluate:
1. **Clarity** — Are instructions unambiguous? Could an agent follow them without guessing?
2. **Coverage** — Are edge cases handled? Are there missing error scenarios?
3. **Correctness** — Do the steps produce the expected outcome?
4. **Efficiency** — Are there unnecessary steps or redundant checks?

Output ONLY valid JSON:
{
  "qualityScore": 0.85,
  "issues": [
    {
      "severity": "high|medium|low",
      "category": "clarity|coverage|correctness|efficiency",
      "description": "What's wrong",
      "suggestion": "How to fix it"
    }
  ],
  "needsUpdate": true,
  "bumpType": "major|minor|patch"
}`;

export class SkillReflector {
  private readonly adapter: LLMAdapter;
  private readonly model: string;
  private readonly minQuality: number;

  constructor(options: ReflectorOptions) {
    this.adapter = options.adapter;
    this.model = options.model;
    this.minQuality = options.minQuality ?? 0.8;
  }

  /**
   * Reflect on a skill's execution.
   * @param skillName — name of the skill
   * @param skillContent — SKILL.md content
   * @param executionMessages — messages from the skill execution
   */
  async reflect(
    skillName: string,
    skillContent: string,
    executionMessages: Message[],
  ): Promise<SkillReflection> {
    const transcript = this.buildTranscript(executionMessages);
    const prompt = this.buildPrompt(skillName, skillContent, transcript);

    const response = await this.adapter.complete({
      model: this.model,
      messages: [
        { role: "system", content: REFLECT_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    });

    const content = this.extractTextContent(response);
    return this.parseResponse(skillName, content);
  }

  private buildPrompt(skillName: string, skillContent: string, transcript: string): string {
    const parts: string[] = [];
    parts.push(`## Skill: ${skillName}\n`);
    parts.push(`### SKILL.md Content\n${skillContent.slice(0, 3000)}\n`);
    parts.push(`### Execution Transcript\n${transcript.slice(0, 3000)}\n`);
    parts.push("Evaluate this skill's quality based on its content and how it was executed.");
    return parts.join("\n");
  }

  private buildTranscript(messages: Message[]): string {
    const lines: string[] = [];
    for (const msg of messages) {
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const text = typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("\n");
      if (text.trim()) {
        lines.push(`[${msg.role}]: ${text.slice(0, 300)}`);
      }
    }
    return lines.join("\n");
  }

  private extractTextContent(response: { message: { content: unknown } }): string {
    const content = response.message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((p: unknown): p is { type: string; text: string } =>
          typeof p === "object" && p !== null && (p as { type: string }).type === "text")
        .map((p) => p.text)
        .join("\n");
    }
    return "";
  }

  private parseResponse(skillName: string, content: string): SkillReflection {
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, content];
    const jsonStr = jsonMatch[1]?.trim() ?? content.trim();

    try {
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

      const qualityScore = typeof parsed.qualityScore === "number"
        ? Math.max(0, Math.min(1, parsed.qualityScore))
        : 0.5;

      const issues = Array.isArray(parsed.issues)
        ? (parsed.issues as Record<string, unknown>[])
            .map((i) => this.validateIssue(i))
            .filter((i): i is ReflectionIssue => i !== null)
        : [];

      const needsUpdate = typeof parsed.needsUpdate === "boolean"
        ? parsed.needsUpdate
        : qualityScore < this.minQuality;

      const bumpType = parsed.bumpType === "major" || parsed.bumpType === "minor" || parsed.bumpType === "patch"
        ? parsed.bumpType
        : this.inferBumpType(issues);

      return { skillName, qualityScore, issues, needsUpdate, bumpType };
    } catch {
      return {
        skillName,
        qualityScore: 0.5,
        issues: [],
        needsUpdate: false,
      };
    }
  }

  private validateIssue(raw: Record<string, unknown>): ReflectionIssue | null {
    const severity = raw.severity;
    if (severity !== "high" && severity !== "medium" && severity !== "low") return null;

    const category = raw.category;
    if (category !== "clarity" && category !== "coverage" && category !== "correctness" && category !== "efficiency") return null;

    if (typeof raw.description !== "string") return null;

    return {
      severity,
      category,
      description: raw.description,
      suggestion: typeof raw.suggestion === "string" ? raw.suggestion : "",
    };
  }

  private inferBumpType(issues: ReflectionIssue[]): "major" | "minor" | "patch" {
    const hasHigh = issues.some((i) => i.severity === "high");
    const hasMedium = issues.some((i) => i.severity === "medium");
    if (hasHigh) return "major";
    if (hasMedium) return "minor";
    return "patch";
  }
}

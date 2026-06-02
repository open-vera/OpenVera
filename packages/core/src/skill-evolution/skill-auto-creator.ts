/**
 * SkillAutoCreator — OC13
 *
 * Extracts reusable skill templates from complex multi-round tasks.
 * When an agent completes a task with ≥ N rounds of iteration, analyzes
 * the transcript to identify repeatable patterns worth turning into skills.
 *
 * Flow:
 *   1. Check round count — skip if < minRounds
 *   2. Analyze transcript for repetitive patterns
 *   3. LLM extracts structured skill templates
 *   4. Filter by confidence threshold
 */

import type { LLMAdapter } from "../adapters/base.js";
import type { Message } from "../types/index.js";
import type { SkillTemplate, AutoCreatorOptions, AutoCreatorResult } from "./types.js";

const EXTRACT_SYSTEM_PROMPT = `You are a skill extraction agent. Analyze a multi-round task transcript and identify reusable patterns that could be extracted into standalone skills.

A good skill template:
- Solves a specific, repeatable problem
- Has clear trigger conditions (when to use it)
- Has well-defined steps
- Is not too generic (not just "read file and fix it")

Output ONLY valid JSON:
{
  "templates": [
    {
      "name": "kebab-case-name",
      "description": "One-line description",
      "triggers": ["condition1", "condition2"],
      "steps": ["step1", "step2"],
      "allowedTools": ["Bash", "Read"],
      "argumentHint": "[--flag value]",
      "sourceTask": "brief description of what task produced this",
      "confidence": 0.75
    }
  ]
}

If no reusable patterns found, return: {"templates": []}`;

export class SkillAutoCreator {
  private readonly minRounds: number;
  private readonly minConfidence: number;
  private readonly adapter: LLMAdapter;
  private readonly model: string;

  constructor(options: AutoCreatorOptions) {
    this.minRounds = options.minRounds ?? 3;
    this.minConfidence = options.minConfidence ?? 0.6;
    this.adapter = options.adapter;
    this.model = options.model;
  }

  /**
   * Count distinct task rounds in a message list.
   * A "round" = one user-assistant exchange pair.
   */
  countRounds(messages: Message[]): number {
    let rounds = 0;
    for (let i = 0; i < messages.length - 1; i++) {
      if (messages[i].role === "user" && messages[i + 1]?.role === "assistant") {
        rounds++;
      }
    }
    return rounds;
  }

  /**
   * Extract skill templates from a task transcript.
   */
  async extract(messages: Message[], taskDescription?: string): Promise<AutoCreatorResult> {
    const rounds = this.countRounds(messages);

    if (rounds < this.minRounds) {
      return { triggered: false, templates: [] };
    }

    const transcript = this.buildTranscript(messages, taskDescription);
    const response = await this.adapter.complete({
      model: this.model,
      messages: [
        { role: "system", content: EXTRACT_SYSTEM_PROMPT },
        { role: "user", content: transcript },
      ],
    });

    const content = this.extractTextContent(response);
    return this.parseResponse(content);
  }

  private buildTranscript(messages: Message[], taskDescription?: string): string {
    const parts: string[] = [];

    if (taskDescription) {
      parts.push(`## Task Description\n${taskDescription}\n`);
    }

    parts.push("## Conversation Transcript\n");
    for (const msg of messages) {
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const text = typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("\n");
      if (text.trim()) {
        parts.push(`[${msg.role}]: ${text.slice(0, 500)}`);
      }
    }

    return parts.join("\n");
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

  private parseResponse(content: string): AutoCreatorResult {
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, content];
    const jsonStr = jsonMatch[1]?.trim() ?? content.trim();

    try {
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      const rawTemplates = Array.isArray(parsed.templates) ? parsed.templates : [];

      const templates = (rawTemplates as Record<string, unknown>[])
        .map((t) => this.validateTemplate(t))
        .filter((t): t is SkillTemplate => t !== null && t.confidence >= this.minConfidence);

      return { triggered: true, templates };
    } catch {
      return { triggered: true, templates: [] };
    }
  }

  private validateTemplate(raw: Record<string, unknown>): SkillTemplate | null {
    if (typeof raw.name !== "string" || typeof raw.description !== "string") return null;
    if (!Array.isArray(raw.triggers) || !Array.isArray(raw.steps)) return null;

    return {
      name: raw.name,
      description: raw.description,
      triggers: raw.triggers.filter((t): t is string => typeof t === "string"),
      steps: raw.steps.filter((s): s is string => typeof s === "string"),
      allowedTools: Array.isArray(raw.allowedTools)
        ? raw.allowedTools.filter((t): t is string => typeof t === "string")
        : ["Bash", "Read"],
      argumentHint: typeof raw.argumentHint === "string" ? raw.argumentHint : undefined,
      sourceTask: typeof raw.sourceTask === "string" ? raw.sourceTask : "",
      confidence: typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
    };
  }
}

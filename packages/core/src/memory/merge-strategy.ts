/**
 * Merge Strategy — OC10
 *
 * LLM-based merge strategy for memory updates. Given a transcript and
 * existing memories, the LLM decides which topics to create, update, or discard.
 *
 * The prompt instructs the LLM to output structured JSON with merge decisions.
 */

import type { LLMAdapter } from "../adapters/base.js";
import type { SemanticEntry, EpisodicEntry } from "./store.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface MergeDecision {
  /** Action to take */
  action: "create" | "update" | "discard";
  /** Key for new or updated memory */
  key: string;
  /** Value/content for new or updated memory */
  value: string;
  /** Existing key to update or discard (required for update/discard) */
  existingKey?: string;
  /** Tags for the memory */
  tags?: string[];
  /** Importance score 0-1 */
  importance?: number;
  /** Reason for the decision */
  reason?: string;
}

export interface MergeStrategyResult {
  /** The merge decisions */
  decisions: MergeDecision[];
  /** Optional summary of the task */
  summary?: string;
}

// ── Prompt ─────────────────────────────────────────────────────────────────

const MERGE_SYSTEM_PROMPT = `You are a memory management agent. Your job is to analyze a conversation transcript and existing memories, then decide what to remember.

Rules:
1. CREATE new memories for important facts, decisions, or lessons from the conversation
2. UPDATE existing memories if the conversation contains newer or more complete information
3. DISCARD existing memories that are contradicted or superseded by the conversation
4. Do NOT create trivial or obvious memories
5. Each memory should have a concise key (title) and detailed value (content)
6. Assign importance 0-1 (0.9+ for critical decisions, 0.5-0.8 for useful context, <0.5 for minor details)
7. Use relevant tags for categorization

Output ONLY valid JSON with this structure:
{
  "summary": "Brief one-line summary of what the conversation was about",
  "decisions": [
    {
      "action": "create",
      "key": "Concise memory title",
      "value": "Detailed memory content",
      "tags": ["tag1", "tag2"],
      "importance": 0.8,
      "reason": "Why this should be remembered"
    }
  ]
}`;

function buildMergePrompt(
  transcript: string,
  existingSemantic: SemanticEntry[],
  existingEpisodic: EpisodicEntry[],
): string {
  const parts: string[] = [];

  parts.push("## Conversation Transcript\n");
  parts.push(truncateText(transcript, 4000));

  if (existingSemantic.length > 0) {
    parts.push("\n## Existing Semantic Memories\n");
    for (const entry of existingSemantic.slice(0, 20)) {
      parts.push(`- [${entry.key}] (importance: ${entry.importance.toFixed(2)}): ${truncateText(entry.value, 100)}`);
    }
  }

  if (existingEpisodic.length > 0) {
    parts.push("\n## Recent Task History\n");
    for (const entry of existingEpisodic.slice(0, 5)) {
      parts.push(`- ${entry.taskSummary} → ${entry.outcome}`);
    }
  }

  parts.push("\n## Instructions\n");
  parts.push("Analyze the conversation and existing memories. Output merge decisions as JSON.");

  return parts.join("\n");
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

// ── Run ────────────────────────────────────────────────────────────────────

/**
 * Run the merge strategy: send transcript + existing memories to LLM,
 * get back structured merge decisions.
 */
export async function runMergeStrategy(
  transcript: string,
  existingSemantic: SemanticEntry[],
  existingEpisodic: EpisodicEntry[],
  adapter: LLMAdapter,
  model: string,
): Promise<MergeStrategyResult> {
  const prompt = buildMergePrompt(transcript, existingSemantic, existingEpisodic);

  const response = await adapter.complete({
    model,
    messages: [
      { role: "system", content: MERGE_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
  });

  const content = extractTextContent(response);

  return parseMergeResponse(content);
}

/**
 * Parse the LLM response into structured merge decisions.
 * Falls back to empty decisions on parse failure.
 */
export function parseMergeResponse(content: string): MergeStrategyResult {
  // Try to extract JSON from the response (may be wrapped in markdown code block)
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, content];
  const jsonStr = jsonMatch[1]?.trim() ?? content.trim();

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    const decisions = Array.isArray(parsed.decisions)
      ? (parsed.decisions as Record<string, unknown>[]).map(validateDecision).filter(Boolean)
      : [];

    return {
      decisions: decisions as MergeDecision[],
      summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
    };
  } catch {
    // JSON parse failed — try to extract any useful info
    return { decisions: [] };
  }
}

/**
 * Validate and normalize a single merge decision from LLM output.
 * Returns null if the decision is invalid.
 */
function validateDecision(raw: Record<string, unknown>): MergeDecision | null {
  const action = raw.action;
  if (action !== "create" && action !== "update" && action !== "discard") return null;

  const key = typeof raw.key === "string" ? raw.key : null;
  const value = typeof raw.value === "string" ? raw.value : null;

  // create requires key + value
  if (action === "create" && (!key || !value)) return null;
  // update requires existingKey + value
  if (action === "update" && (!value || typeof raw.existingKey !== "string")) return null;
  // discard requires existingKey
  if (action === "discard" && typeof raw.existingKey !== "string") return null;

  const decision: MergeDecision = {
    action,
    key: key ?? raw.existingKey as string ?? "",
    value: value ?? "",
  };

  if (typeof raw.existingKey === "string") decision.existingKey = raw.existingKey;
  if (Array.isArray(raw.tags)) decision.tags = raw.tags.filter((t): t is string => typeof t === "string");
  if (typeof raw.importance === "number") decision.importance = Math.max(0, Math.min(1, raw.importance));
  if (typeof raw.reason === "string") decision.reason = raw.reason;

  return decision;
}

/**
 * Extract text content from a CompletionResponse.
 */
function extractTextContent(response: { message: { content: unknown } }): string {
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

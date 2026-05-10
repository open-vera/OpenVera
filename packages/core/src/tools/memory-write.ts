/**
 * memory_write tool — Store information into memory.
 *
 * Allows the agent to persist knowledge, task summaries, and observations.
 * Supports all three tiers: working, episodic, semantic.
 */

import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";

export interface MemoryWriteArgs {
  tier: "working" | "episodic" | "semantic";
  content: string;
  /** Tags for categorization */
  tags?: string[];
  /** Source context */
  source?: string;
  /** Importance 0-1 */
  importance?: number;
  /** For semantic tier: the key (concise knowledge claim) */
  key?: string;
  /** For semantic tier: supporting detail */
  value?: string;
  /** For episodic tier: task summary */
  taskSummary?: string;
  /** For episodic tier: what happened */
  outcome?: string;
  /** For episodic tier: lessons learned */
  lessons?: string[];
}

export function createMemoryWriteTool(): ToolDef<MemoryWriteArgs> {
  return {
    name: "memory_write",
    description:
      "Store information into memory. Use 'semantic' for knowledge facts (key/value), " +
      "'episodic' for task summaries with lessons learned, 'working' for session-scoped notes.",
    parameters: {
      type: "object" as const,
      required: ["tier", "content"],
      properties: {
        tier: {
          type: "string" as const,
          enum: ["working", "episodic", "semantic"],
          description: "Memory tier to write to",
        },
        content: {
          type: "string" as const,
          description: "The content to store",
        },
        tags: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Tags for categorization and search",
        },
        source: {
          type: "string" as const,
          description: "Source context (e.g., task ID, file path)",
        },
        importance: {
          type: "number" as const,
          description: "Importance score 0-1 (default: 0.5 for working, 0.7 for episodic, 0.8 for semantic)",
        },
        key: {
          type: "string" as const,
          description: "[semantic only] Concise knowledge claim / key",
        },
        value: {
          type: "string" as const,
          description: "[semantic only] Supporting detail / value",
        },
        taskSummary: {
          type: "string" as const,
          description: "[episodic only] What the task was about",
        },
        outcome: {
          type: "string" as const,
          description: "[episodic only] What happened / result",
        },
        lessons: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "[episodic only] Lessons learned",
        },
      },
    },
    execute: async (args: MemoryWriteArgs, ctx: ToolContext): Promise<ToolResult> => {
      const store = ctx.memoryStore;
      if (!store) {
        return errorResult("UNKNOWN", "MemoryStore not available in context", false);
      }

      try {
        switch (args.tier) {
          case "working": {
            const entry = store.addWorking(args.content, args.tags ?? [], args.source, args.importance ?? 0.5);
            return { ok: true, content: `Stored in working memory: ${entry.id}` };
          }
          case "episodic": {
            const taskSummary = args.taskSummary ?? args.content;
            const outcome = args.outcome ?? "";
            const lessons = args.lessons ?? [];
            const entry = store.addEpisodic(taskSummary, outcome, lessons, args.tags ?? [], args.source, args.importance ?? 0.7);
            return { ok: true, content: `Stored in episodic memory: ${entry.id}\nSummary: ${taskSummary}` };
          }
          case "semantic": {
            const key = args.key;
            const value = args.value ?? args.content;
            if (!key) {
              return errorResult("UNKNOWN", "'key' is required for semantic memory", false);
            }
            const entry = store.addSemantic(key, value, args.tags ?? [], args.source, args.importance ?? 0.8);
            return { ok: true, content: `Stored in semantic memory: ${entry.id}\nKey: ${key}` };
          }
          default:
            return errorResult("UNKNOWN", `Unknown tier: ${args.tier}`, false);
        }
      } catch (err) {
        return errorResult("UNKNOWN", err instanceof Error ? err.message : String(err), false);
      }
    },
  };
}

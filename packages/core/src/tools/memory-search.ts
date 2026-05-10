/**
 * memory_search tool — Search across memory tiers.
 *
 * Returns relevant entries from working, episodic, and/or semantic memory
 * based on a natural language query.
 */

import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";

export interface MemorySearchArgs {
  query: string;
  tiers?: ("working" | "episodic" | "semantic")[];
  limit?: number;
}

export function createMemorySearchTool(): ToolDef<MemorySearchArgs> {
  return {
    name: "memory_search",
    description:
      "Search memory for relevant information. Searches across all tiers by default. " +
      "Use this to recall past knowledge, task lessons, or session context.",
    parameters: {
      type: "object" as const,
      required: ["query"],
      properties: {
        query: {
          type: "string" as const,
          description: "Natural language search query",
        },
        tiers: {
          type: "array" as const,
          items: {
            type: "string" as const,
            enum: ["working", "episodic", "semantic"],
          },
          description: "Which tiers to search (default: all)",
        },
        limit: {
          type: "number" as const,
          description: "Max results to return (default: 10)",
        },
      },
    },
    execute: async (args: MemorySearchArgs, ctx: ToolContext): Promise<ToolResult> => {
      const store = ctx.memoryStore;
      if (!store) {
        return errorResult("UNKNOWN", "MemoryStore not available in context", false);
      }

      try {
        const results = store.search(args.query, {
          tiers: args.tiers,
          limit: args.limit ?? 10,
        });

        if (results.length === 0) {
          return { ok: true, content: "No matching memories found." };
        }

        const formatted = results
          .map((r, i) => {
            const entry = r.entry;
            const header = `[${i + 1}] ${entry.tier.toUpperCase()} (${(r.score * 100).toFixed(0)}%) — ${entry.id}`;
            const tags = entry.tags.length > 0 ? `  tags: [${entry.tags.join(", ")}]` : "";
            return `${header}${tags}\n${entry.content}`;
          })
          .join("\n\n");

        return { ok: true, content: `Found ${results.length} memories:\n\n${formatted}` };
      } catch (err) {
        return errorResult("UNKNOWN", err instanceof Error ? err.message : String(err), false);
      }
    },
  };
}

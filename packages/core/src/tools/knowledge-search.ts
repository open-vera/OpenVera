/**
 * knowledge_search tool — Search the RAG knowledge base.
 *
 * Converts a text query to an embedding vector, then performs
 * similarity search against the vector store to find relevant documents.
 */

import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";

export interface KnowledgeSearchArgs {
  /** Natural language search query */
  query: string;
  /** Maximum results to return (default: 5) */
  topK?: number;
  /** Minimum similarity score 0-1 (default: 0) */
  minScore?: number;
  /** Metadata filter (exact match on specified keys) */
  filter?: Record<string, unknown>;
}

export function createKnowledgeSearchTool(): ToolDef<KnowledgeSearchArgs> {
  return {
    name: "knowledge_search",
    description:
      "Search the knowledge base for relevant documents. " +
      "Use this to find information from indexed files, documentation, or any previously ingested content.",
    parameters: {
      type: "object" as const,
      required: ["query"],
      properties: {
        query: {
          type: "string" as const,
          description: "Natural language search query",
        },
        topK: {
          type: "number" as const,
          description: "Maximum results to return (default: 5)",
        },
        minScore: {
          type: "number" as const,
          description: "Minimum similarity score 0-1 (default: 0)",
        },
        filter: {
          type: "object" as const,
          description: "Metadata filter (exact match on specified keys, e.g. {fileType: 'markdown'})",
        },
      },
    },
    execute: async (args: KnowledgeSearchArgs, ctx: ToolContext): Promise<ToolResult> => {
      const store = ctx.vectorStore;
      const adapter = ctx.embeddingAdapter;

      if (!store) {
        return errorResult("UNKNOWN", "VectorStore not available in context", false);
      }
      if (!adapter) {
        return errorResult("UNKNOWN", "EmbeddingAdapter not available in context", false);
      }

      try {
        // Convert query text to embedding
        const queryEmbedding = await adapter.embed(args.query);

        // Search the vector store
        const result = await store.search({
          embedding: queryEmbedding,
          topK: args.topK ?? 5,
          minScore: args.minScore ?? 0,
          filter: args.filter,
        });

        if (result.results.length === 0) {
          return {
            ok: true,
            content: "No relevant documents found in the knowledge base.",
          };
        }

        // Format results
        const lines: string[] = [
          `Found ${result.results.length} relevant document(s) (searched ${result.total} total in ${result.durationMs.toFixed(1)}ms):\n`,
        ];

        for (let i = 0; i < result.results.length; i++) {
          const { document, score } = result.results[i];
          const source = (document.metadata?.source as string) ?? document.id;
          lines.push(`### [${i + 1}] ${source} (score: ${score.toFixed(3)})`);
          lines.push(document.content);
          lines.push("");
        }

        return {
          ok: true,
          content: lines.join("\n"),
          metadata: {
            renderHint: { type: "text" },
          },
        };
      } catch (err) {
        return errorResult(
          "EXEC_ERROR",
          `Knowledge search failed: ${err instanceof Error ? err.message : String(err)}`,
          false,
        );
      }
    },
  };
}

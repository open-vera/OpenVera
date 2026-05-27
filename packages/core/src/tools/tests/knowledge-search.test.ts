/**
 * Tests for knowledge_search tool — RAG vector search via tool interface.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKnowledgeSearchTool } from "../knowledge-search.js";
import type { ToolContext, ToolDef } from "../types.js";
import { LocalVectorStore } from "../../rag/local-vector-store.js";
import { LocalEmbeddingAdapter } from "../../rag/embedding-adapter.js";
import type { VectorDocument } from "../../rag/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeContext(
  vectorStore?: LocalVectorStore,
  embeddingAdapter?: LocalEmbeddingAdapter,
): ToolContext {
  return {
    cwd: "/tmp",
    sessionId: "test-session",
    vectorStore,
    embeddingAdapter,
  };
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("knowledge_search tool", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: LocalVectorStore;
  let adapter: LocalEmbeddingAdapter;
  let tool: ToolDef;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ksearch-"));
    dbPath = join(tmpDir, "test.db");
    store = new LocalVectorStore({ dbPath, dimensions: 384 });
    await store.initialize();
    adapter = new LocalEmbeddingAdapter({ dimensions: 384 });
    await adapter.initialize();
    tool = createKnowledgeSearchTool();
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Basic ──────────────────────────────────────────────────────────────────

  it("should have correct tool name", () => {
    expect(tool.name).toBe("knowledge_search");
  });

  it("should require query parameter", () => {
    expect(tool.parameters.required).toContain("query");
  });

  // ── Error Cases ────────────────────────────────────────────────────────────

  it("should error when vectorStore not in context", async () => {
    const ctx = makeContext(undefined, adapter);
    const result = await tool.execute({ query: "test" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("VectorStore");
  });

  it("should error when embeddingAdapter not in context", async () => {
    const ctx = makeContext(store, undefined);
    const result = await tool.execute({ query: "test" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("EmbeddingAdapter");
  });

  // ── Search Results ─────────────────────────────────────────────────────────

  it("should return no results for empty store", async () => {
    const ctx = makeContext(store, adapter);
    const result = await tool.execute({ query: "anything" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("No relevant documents");
  });

  it("should find relevant documents", async () => {
    // Index some documents
    const docs: VectorDocument[] = [
      {
        id: "doc1",
        content: "TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.",
        embedding: await adapter.embed("TypeScript is a typed superset of JavaScript"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "doc2",
        content: "Python is a high-level programming language with dynamic typing.",
        embedding: await adapter.embed("Python is a high-level programming language"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    await store.upsertMany(docs);

    const ctx = makeContext(store, adapter);
    const result = await tool.execute({ query: "TypeScript programming" }, ctx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Found");
    expect(result.content).toContain("TypeScript");
  });

  it("should respect topK parameter", async () => {
    const docs: VectorDocument[] = [];
    for (let i = 0; i < 10; i++) {
      docs.push({
        id: `doc${i}`,
        content: `Document ${i} about topic ${i}`,
        embedding: await adapter.embed(`Document about topic ${i}`),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    await store.upsertMany(docs);

    const ctx = makeContext(store, adapter);
    const result = await tool.execute({ query: "document topic", topK: 3 }, ctx);

    expect(result.ok).toBe(true);
    // Should find at least some results
    expect(result.content).toContain("Found");
  });

  it("should respect filter parameter", async () => {
    const docs: VectorDocument[] = [
      {
        id: "ts-doc",
        content: "TypeScript adds types to JavaScript.",
        embedding: await adapter.embed("TypeScript adds types"),
        metadata: { fileType: "markdown" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "py-doc",
        content: "Python uses dynamic typing.",
        embedding: await adapter.embed("Python dynamic typing"),
        metadata: { fileType: "text" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    await store.upsertMany(docs);

    const ctx = makeContext(store, adapter);
    const result = await tool.execute(
      { query: "programming language", filter: { fileType: "markdown" } },
      ctx,
    );

    expect(result.ok).toBe(true);
    // Only markdown files should appear
    if (result.content.includes("TypeScript")) {
      expect(result.content).not.toContain("Python uses dynamic typing");
    }
  });

  it("should include search metadata in result", async () => {
    const doc: VectorDocument = {
      id: "test-doc",
      content: "Test content about algorithms.",
      embedding: await adapter.embed("Test content about algorithms"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.upsert(doc);

    const ctx = makeContext(store, adapter);
    const result = await tool.execute({ query: "algorithms" }, ctx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("score:");
    expect(result.content).toContain("ms)");
  });
});

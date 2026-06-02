/**
 * Tests for knowledge_search tool — RAG vector search via tool interface.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKnowledgeSearchTool } from "../knowledge-search.js";
import type { ToolContext, ToolDef } from "../types.js";
import { LocalVectorStore } from "../../rag/local-vector-store.js";
import { LocalEmbeddingAdapter } from "../../rag/embedding-adapter.js";
import type { VectorDocument, VectorStore } from "../../rag/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeContext(
  vectorStore?: LocalVectorStore | VectorStore,
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

  // ── Schema & Metadata ──────────────────────────────────────────────────────

  it("should have correct tool name", () => {
    expect(tool.name).toBe("knowledge_search");
  });

  it("should have a non-empty description", () => {
    expect(tool.description).toBeTruthy();
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.description).toContain("knowledge base");
  });

  it("should require query parameter", () => {
    expect(tool.parameters.required).toContain("query");
  });

  it("should define all parameter properties with correct types", () => {
    const props = tool.parameters.properties as Record<string, Record<string, unknown>>;
    expect(props).toHaveProperty("query");
    expect(props.query.type).toBe("string");

    expect(props).toHaveProperty("topK");
    expect(props.topK.type).toBe("number");

    expect(props).toHaveProperty("minScore");
    expect(props.minScore.type).toBe("number");

    expect(props).toHaveProperty("filter");
    expect(props.filter.type).toBe("object");
  });

  // ── Error Cases ────────────────────────────────────────────────────────────

  it("should error when vectorStore not in context", async () => {
    const ctx = makeContext(undefined, adapter);
    const result = await tool.execute({ query: "test" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("VectorStore");
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.error?.retryable).toBe(false);
  });

  it("should error when embeddingAdapter not in context", async () => {
    const ctx = makeContext(store, undefined);
    const result = await tool.execute({ query: "test" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("EmbeddingAdapter");
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.error?.retryable).toBe(false);
  });

  it("should catch and wrap Error instance thrown during search", async () => {
    const throwingStore = {
      search: async () => {
        throw new Error("DB connection lost");
      },
    } as unknown as VectorStore;
    const ctx = makeContext(throwingStore, adapter);
    const result = await tool.execute({ query: "test" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.error?.message).toContain("Knowledge search failed");
    expect(result.error?.message).toContain("DB connection lost");
    expect(result.error?.retryable).toBe(false);
  });

  it("should catch and stringify non-Error value thrown during search", async () => {
    const throwingStore = {
      search: async () => {
        throw "raw rejection string";
      },
    } as unknown as VectorStore;
    const ctx = makeContext(throwingStore, adapter);
    const result = await tool.execute({ query: "test" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.error?.message).toContain("Knowledge search failed");
    expect(result.error?.message).toContain("raw rejection string");
    expect(result.error?.retryable).toBe(false);
  });

  it("should catch and wrap error thrown during embedding", async () => {
    const throwingAdapter = {
      embed: async () => {
        throw new Error("embedding service unavailable");
      },
    } as unknown as LocalEmbeddingAdapter;
    const ctx = makeContext(store, throwingAdapter);
    const result = await tool.execute({ query: "test" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.error?.message).toContain("Knowledge search failed");
    expect(result.error?.message).toContain("embedding service unavailable");
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

  it("should use document.metadata.source for result header when present", async () => {
    const doc: VectorDocument = {
      id: "doc1",
      content: "Rust programming language guide.",
      embedding: await adapter.embed("Rust programming language"),
      metadata: { source: "/docs/rust-guide.md", fileType: "markdown" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.upsert(doc);

    const ctx = makeContext(store, adapter);
    const result = await tool.execute({ query: "Rust" }, ctx);

    expect(result.ok).toBe(true);
    // Header should contain the metadata.source value
    expect(result.content).toContain("/docs/rust-guide.md");
  });

  it("should fallback to document.id in result header when metadata.source is absent", async () => {
    const doc: VectorDocument = {
      id: "fallback-id-42",
      content: "Go programming language guide.",
      embedding: await adapter.embed("Go programming language"),
      metadata: { fileType: "text" }, // no "source" key
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.upsert(doc);

    const ctx = makeContext(store, adapter);
    const result = await tool.execute({ query: "Go" }, ctx);

    expect(result.ok).toBe(true);
    // Header should contain the document.id as fallback
    expect(result.content).toContain("fallback-id-42");
    // Should NOT contain the literal "undefined" in place of source
    const headerLine = result.content.split("\n").find((l) => l.startsWith("###")) ?? "";
    expect(headerLine).not.toContain("undefined");
  });

  it("should fallback to document.id when metadata is entirely absent", async () => {
    const doc: VectorDocument = {
      id: "no-meta-doc",
      content: "Zig systems programming.",
      embedding: await adapter.embed("Zig systems programming"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // no metadata at all
    };
    await store.upsert(doc);

    const ctx = makeContext(store, adapter);
    const result = await tool.execute({ query: "Zig" }, ctx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("no-meta-doc");
  });

  it("should include renderHint in result metadata", async () => {
    const doc: VectorDocument = {
      id: "doc1",
      content: "Test content for render hint.",
      embedding: await adapter.embed("Test content for render hint"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.upsert(doc);

    const ctx = makeContext(store, adapter);
    const result = await tool.execute({ query: "render" }, ctx);

    expect(result.ok).toBe(true);
    expect(result.metadata?.renderHint).toEqual({ type: "text" });
  });

  it("should return no documents when minScore filters everything", async () => {
    const docs: VectorDocument[] = [
      {
        id: "doc1",
        content: "TypeScript is a typed superset of JavaScript.",
        embedding: await adapter.embed("TypeScript is a typed superset of JavaScript"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "doc2",
        content: "Python is a high-level programming language.",
        embedding: await adapter.embed("Python is a high-level programming language"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    await store.upsertMany(docs);

    const ctx = makeContext(store, adapter);
    // minScore 0.99 is extremely high and the hash-based local adapter
    // produces vectors with low pairwise similarity — everything gets filtered
    const result = await tool.execute(
      { query: "TypeScript programming", minScore: 0.99 },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("No relevant documents");
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
    expect(result.content).toContain("Found");
  });

  it("should default topK to 5 when not specified", async () => {
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
    const result = await tool.execute({ query: "document topic" }, ctx);

    expect(result.ok).toBe(true);
    // With default topK=5, should show at most 5 results
    const match = /Found (\d+) relevant/.exec(result.content);
    expect(match).not.toBeNull();
    const count = parseInt(match![1], 10);
    expect(count).toBeLessThanOrEqual(5);
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

  it("should include total document count and duration in result", async () => {
    const doc: VectorDocument = {
      id: "count-test",
      content: "Document for counting.",
      embedding: await adapter.embed("Document for counting"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.upsert(doc);

    const ctx = makeContext(store, adapter);
    const result = await tool.execute({ query: "counting" }, ctx);

    expect(result.ok).toBe(true);
    // Verifies the format line: "Found 1 relevant document(s) (searched 1 total in X.Xms):"
    expect(result.content).toMatch(/Found \d+ relevant document\(s\) \(searched \d+ total in [\d.]+ms\):/);
  });
});

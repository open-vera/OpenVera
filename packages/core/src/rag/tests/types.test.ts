/**
 * Tests for RAG types — verify type contracts, error constructors, and
 * interface compatibility through structural typing checks.
 */
import { describe, it, expect } from "vitest";
import type {
  VectorDocument,
  VectorDocumentInput,
  VectorQuery,
  VectorSearchResult,
  VectorQueryResult,
  VectorIndexStats,
  VectorStore,
  EmbeddingAdapter,
  RetrievalOptions,
  RetrievedChunk,
} from "../types.js";
import {
  RAGError,
  VectorStoreError,
  VectorDimensionError,
  EmbeddingError,
  DocumentNotFoundError,
  RAGNotInitializedError,
} from "../types.js";

// ── Error Classes ────────────────────────────────────────────────────────────

describe("RAG Error Classes", () => {
  describe("RAGError", () => {
    it("should create with code and message", () => {
      const err = new RAGError("TEST_CODE", "test message");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(RAGError);
      expect(err.code).toBe("TEST_CODE");
      expect(err.message).toBe("test message");
      expect(err.name).toBe("RAGError");
    });

    it("should support cause chaining", () => {
      const cause = new Error("root cause");
      const err = new RAGError("CHAIN", "wrapped", { cause });
      expect(err.cause).toBe(cause);
    });
  });

  describe("VectorStoreError", () => {
    it("should use VECTOR_STORE_ERROR code", () => {
      const err = new VectorStoreError("store failed");
      expect(err.code).toBe("VECTOR_STORE_ERROR");
      expect(err.name).toBe("VectorStoreError");
      expect(err.message).toBe("store failed");
    });
  });

  describe("VectorDimensionError", () => {
    it("should report expected and actual dimensions", () => {
      const err = new VectorDimensionError(1536, 768);
      expect(err.code).toBe("VECTOR_DIMENSION_ERROR");
      expect(err.message).toContain("1536");
      expect(err.message).toContain("768");
      expect(err.name).toBe("VectorDimensionError");
    });
  });

  describe("EmbeddingError", () => {
    it("should use EMBEDDING_ERROR code", () => {
      const err = new EmbeddingError("embedding failed");
      expect(err.code).toBe("EMBEDDING_ERROR");
      expect(err.name).toBe("EmbeddingError");
    });
  });

  describe("DocumentNotFoundError", () => {
    it("should include document ID in message", () => {
      const err = new DocumentNotFoundError("doc-123");
      expect(err.code).toBe("DOCUMENT_NOT_FOUND");
      expect(err.message).toContain("doc-123");
      expect(err.name).toBe("DocumentNotFoundError");
    });
  });

  describe("RAGNotInitializedError", () => {
    it("should include component name in message", () => {
      const err = new RAGNotInitializedError("VectorStore");
      expect(err.code).toBe("RAG_NOT_INITIALIZED");
      expect(err.message).toContain("VectorStore");
      expect(err.name).toBe("RAGNotInitializedError");
    });
  });

  describe("error hierarchy", () => {
    it("all RAG errors should extend RAGError", () => {
      const errors = [
        new VectorStoreError("test"),
        new VectorDimensionError(10, 20),
        new EmbeddingError("test"),
        new DocumentNotFoundError("id"),
        new RAGNotInitializedError("comp"),
      ];
      for (const err of errors) {
        expect(err).toBeInstanceOf(RAGError);
        expect(err).toBeInstanceOf(Error);
      }
    });
  });
});

// ── Type Structural Checks ───────────────────────────────────────────────────
// These verify that objects conform to the interface contracts at runtime.

describe("VectorDocument structure", () => {
  it("should accept a valid document", () => {
    const doc: VectorDocument = {
      id: "doc-1",
      content: "hello world",
      embedding: [0.1, 0.2, 0.3],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(doc.id).toBe("doc-1");
    expect(doc.embedding).toHaveLength(3);
  });

  it("should allow optional metadata", () => {
    const doc: VectorDocument = {
      id: "doc-2",
      content: "test",
      embedding: [0.5],
      metadata: { source: "test.md", tags: ["a", "b"] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(doc.metadata?.source).toBe("test.md");
  });
});

describe("VectorDocumentInput structure", () => {
  it("should accept minimal input", () => {
    const input: VectorDocumentInput = { content: "hello" };
    expect(input.content).toBe("hello");
    expect(input.id).toBeUndefined();
    expect(input.metadata).toBeUndefined();
  });

  it("should accept full input", () => {
    const input: VectorDocumentInput = {
      id: "custom-id",
      content: "hello",
      metadata: { key: "value" },
    };
    expect(input.id).toBe("custom-id");
  });
});

describe("VectorQuery structure", () => {
  it("should accept text query", () => {
    const query: VectorQuery = { text: "search term", topK: 5 };
    expect(query.text).toBe("search term");
    expect(query.topK).toBe(5);
  });

  it("should accept embedding query", () => {
    const query: VectorQuery = { embedding: [0.1, 0.2], minScore: 0.8 };
    expect(query.embedding).toHaveLength(2);
    expect(query.minScore).toBe(0.8);
  });

  it("should accept filter", () => {
    const query: VectorQuery = {
      text: "test",
      filter: { category: "docs", active: true },
    };
    expect(query.filter?.category).toBe("docs");
  });
});

describe("RetrievalOptions structure", () => {
  it("should accept all optional fields", () => {
    const opts: RetrievalOptions = {
      topK: 10,
      minScore: 0.7,
      filter: { tag: "important" },
      rerank: true,
    };
    expect(opts.topK).toBe(10);
    expect(opts.rerank).toBe(true);
  });
});

describe("RetrievedChunk structure", () => {
  it("should accept valid chunk", () => {
    const chunk: RetrievedChunk = {
      id: "c1",
      content: "retrieved text",
      score: 0.95,
      metadata: { source: "doc.md" },
    };
    expect(chunk.score).toBe(0.95);
  });
});

// ── VectorStore Interface Compliance ─────────────────────────────────────────

describe("VectorStore interface compliance", () => {
  it("should accept a mock implementation", () => {
    const mockStore: VectorStore = {
      name: "test-store",
      initialize: async () => {},
      close: async () => {},
      isHealthy: () => true,
      upsert: async () => {},
      upsertMany: async () => {},
      get: async () => undefined,
      getMany: async () => [],
      delete: async () => false,
      deleteMany: async () => 0,
      has: async () => false,
      listIds: async () => [],
      count: async () => 0,
      clear: async () => {},
      search: async () => ({ results: [], total: 0, durationMs: 0 }),
      getStats: async () => ({ documentCount: 0, dimensions: 0 }),
    };
    expect(mockStore.name).toBe("test-store");
    expect(mockStore.isHealthy()).toBe(true);
  });
});

describe("EmbeddingAdapter interface compliance", () => {
  it("should accept a mock implementation", () => {
    const mockAdapter: EmbeddingAdapter = {
      name: "test-adapter",
      dimensions: 3,
      initialize: async () => {},
      close: async () => {},
      embed: async (text: string) => {
        // Simple hash-based deterministic mock
        return [text.length / 100, text.length / 200, text.length / 300];
      },
      embedBatch: async (texts: string[]) => texts.map((t) => [t.length / 100, t.length / 200, t.length / 300]),
    };
    expect(mockAdapter.name).toBe("test-adapter");
    expect(mockAdapter.dimensions).toBe(3);
  });
});

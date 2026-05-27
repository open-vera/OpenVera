/**
 * RAG (Retrieval-Augmented Generation) — Vector storage and embedding abstractions.
 *
 * Provides a VectorStore interface for similarity search and an EmbeddingAdapter
 * interface for converting text into vector representations.  Concrete backends
 * (local SQLite, remote API) implement these interfaces so that the RAG pipeline
 * is backend-agnostic.
 */

// ── Vector Document Types ────────────────────────────────────────────────────

/** A document stored in the vector store with its embedding. */
export interface VectorDocument {
  /** Unique document ID */
  id: string;
  /** Original text content */
  content: string;
  /** Pre-computed embedding vector */
  embedding: number[];
  /** Optional metadata (source file, tags, etc.) */
  metadata?: Record<string, unknown>;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
}

/** Minimal input required to add a document (embedding is computed by the adapter). */
export interface VectorDocumentInput {
  /** Unique document ID (auto-generated if omitted) */
  id?: string;
  /** Text content to embed and store */
  content: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

// ── Query Types ──────────────────────────────────────────────────────────────

/** Options for a similarity search query. */
export interface VectorQuery {
  /** The query text (will be embedded by the adapter) or a pre-computed vector */
  text?: string;
  /** Pre-computed query vector (mutually exclusive with text) */
  embedding?: number[];
  /** Maximum number of results to return */
  topK?: number;
  /** Minimum similarity threshold (0-1). Results below this are filtered out. */
  minScore?: number;
  /** Optional metadata filter (exact-match on specified keys) */
  filter?: Record<string, unknown>;
  /** Whether to include the embedding vectors in results (default: false) */
  includeEmbeddings?: boolean;
}

/** A single search result with its similarity score. */
export interface VectorSearchResult {
  /** The matched document */
  document: VectorDocument;
  /** Cosine similarity score (0-1) */
  score: number;
}

/** The full result set from a vector search. */
export interface VectorQueryResult {
  /** Matching documents, sorted by score descending */
  results: VectorSearchResult[];
  /** Total number of documents considered */
  total: number;
  /** Time taken for the search in milliseconds */
  durationMs: number;
}

// ── Index Statistics ─────────────────────────────────────────────────────────

/** Statistics about the vector store index. */
export interface VectorIndexStats {
  /** Total number of documents in the index */
  documentCount: number;
  /** Dimensionality of the embedding vectors */
  dimensions: number;
  /** Approximate memory usage in bytes */
  memoryBytes?: number;
}

// ── VectorStore Interface ────────────────────────────────────────────────────

/**
 * Core vector store interface.  All backends (local SQLite, in-memory, remote)
 * implement this interface for storing and searching vector embeddings.
 */
export interface VectorStore {
  /** Unique name of this store (e.g., "local-sqlite", "in-memory") */
  readonly name: string;

  /** Initialize the store (create tables, load indices, etc.) */
  initialize(): Promise<void>;

  /** Close the store and release resources */
  close(): Promise<void>;

  /** Check if the store is healthy */
  isHealthy(): boolean;

  // ── Document Operations ──────────────────────────────────────────────────

  /** Add or update a document with its pre-computed embedding */
  upsert(doc: VectorDocument): Promise<void>;

  /** Add or update multiple documents in a batch */
  upsertMany(docs: VectorDocument[]): Promise<void>;

  /** Retrieve a document by ID. Returns undefined if not found. */
  get(id: string): Promise<VectorDocument | undefined>;

  /** Retrieve multiple documents by IDs */
  getMany(ids: string[]): Promise<VectorDocument[]>;

  /** Delete a document by ID. Returns true if it existed. */
  delete(id: string): Promise<boolean>;

  /** Delete multiple documents by IDs */
  deleteMany(ids: string[]): Promise<number>;

  /** Check if a document exists */
  has(id: string): Promise<boolean>;

  /** List all document IDs */
  listIds(): Promise<string[]>;

  /** Get the total number of documents */
  count(): Promise<number>;

  /** Clear all documents from the store */
  clear(): Promise<void>;

  // ── Similarity Search ────────────────────────────────────────────────────

  /** Search for documents similar to the query */
  search(query: VectorQuery): Promise<VectorQueryResult>;

  // ── Index Management ─────────────────────────────────────────────────────

  /** Get statistics about the vector index */
  getStats(): Promise<VectorIndexStats>;
}

// ── Embedding Adapter Interface ──────────────────────────────────────────────

/**
 * Unified interface for generating text embeddings.
 * Supports both local (ONNX/GGML) and remote (OpenAI/Anthropic) backends.
 */
export interface EmbeddingAdapter {
  /** Unique name of this adapter (e.g., "openai", "local-onnx") */
  readonly name: string;

  /** The dimensionality of vectors produced by this adapter */
  readonly dimensions: number;

  /** Initialize the adapter (load model, verify API key, etc.) */
  initialize(): Promise<void>;

  /** Close the adapter and release resources */
  close(): Promise<void>;

  /** Embed a single text string */
  embed(text: string): Promise<number[]>;

  /** Embed multiple text strings in a batch */
  embedBatch(texts: string[]): Promise<number[][]>;
}

// ── RAG Pipeline Types ───────────────────────────────────────────────────────

/** Options for the RAG retrieval pipeline. */
export interface RetrievalOptions {
  /** Number of documents to retrieve */
  topK?: number;
  /** Minimum similarity score (0-1) */
  minScore?: number;
  /** Metadata filter */
  filter?: Record<string, unknown>;
  /** Whether to re-rank results after initial retrieval */
  rerank?: boolean;
}

/** A retrieved chunk ready for context injection. */
export interface RetrievedChunk {
  /** Document ID */
  id: string;
  /** Text content of the chunk */
  content: string;
  /** Similarity score */
  score: number;
  /** Source metadata */
  metadata?: Record<string, unknown>;
}

// ── Error Types ──────────────────────────────────────────────────────────────

export class RAGError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RAGError";
    this.code = code;
  }
}

export class VectorStoreError extends RAGError {
  constructor(message: string, options?: ErrorOptions) {
    super("VECTOR_STORE_ERROR", message, options);
    this.name = "VectorStoreError";
  }
}

export class VectorDimensionError extends RAGError {
  constructor(expected: number, actual: number) {
    super(
      "VECTOR_DIMENSION_ERROR",
      `Vector dimension mismatch: expected ${expected}, got ${actual}`
    );
    this.name = "VectorDimensionError";
  }
}

export class EmbeddingError extends RAGError {
  constructor(message: string, options?: ErrorOptions) {
    super("EMBEDDING_ERROR", message, options);
    this.name = "EmbeddingError";
  }
}

export class DocumentNotFoundError extends RAGError {
  constructor(id: string) {
    super("DOCUMENT_NOT_FOUND", `Vector document not found: ${id}`);
    this.name = "DocumentNotFoundError";
  }
}

export class RAGNotInitializedError extends RAGError {
  constructor(component: string) {
    super("RAG_NOT_INITIALIZED", `${component} is not initialized — call initialize() first`);
    this.name = "RAGNotInitializedError";
  }
}

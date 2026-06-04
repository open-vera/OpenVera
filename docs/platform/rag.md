# RAG -- Retrieval-Augmented Generation

## Overview

The RAG system provides Vera with **corpus-based knowledge retrieval**, enabling agents to search project documentation, codebases, historical decisions, and other local knowledge during task execution. Relevant context is injected into the LLM prompt, improving answer accuracy and task completion quality.

RAG is not part of Vera's runtime core (the agent loop works without it). It exists as a **capability enhancement layer**: agents trigger retrieval via the `knowledge_search` tool, and the RAG pipeline handles embedding and similarity search in the background.

---

## Architecture

```
+-----------------------------------------------------------+
| Agent Loop                                                |
|   |                                                       |
|   +-- tool_call: knowledge_search("how to add a tool")    |
|   v                                                       |
+-----------------------------------------------------------+
| RAG Pipeline (packages/core/src/rag/)                     |
|                                                           |
|  DocumentLoader          EmbeddingAdapter                 |
|  +----------------+     +--------------------+            |
|  | scanDir()      |     | embed(text)        |            |
|  | chunkText()    |     | embedBatch(texts)  |            |
|  | load()         |     | dimensions         |            |
|  +-------+--------+     +---------+----------+            |
|          |                        |                       |
|          v                        v                       |
|  IncrementalIndexer       LocalVectorStore                |
|  +--------------------+   +------------------------+      |
|  | fullIndex()        |   | upsert() / search()    |      |
|  | incrementalIndex() |   | cosineSimilarity       |      |
|  | manifest (mtime)   |   | SQLite BLOB storage    |      |
|  +--------------------+   +------------------------+      |
+-----------------------------------------------------------+
```

Four-layer structure:

1. **DocumentLoader**: Reads documents from the filesystem, chunks them, extracts metadata.
2. **EmbeddingAdapter**: Converts text to vectors (OpenAI / Voyage / local).
3. **VectorStore**: Stores vectors and supports similarity search (SQLite local implementation).
4. **IncrementalIndexer**: Incrementally updates the index by file mtime.

---

## VectorStore Interface

### Interface Definition

All vector storage backends implement the `VectorStore` interface (`packages/core/src/rag/types.ts`):

```ts
interface VectorStore {
  readonly name: string;

  initialize(): Promise<void>;
  close(): Promise<void>;
  isHealthy(): boolean;

  // Document operations
  upsert(doc: VectorDocument): Promise<void>;
  upsertMany(docs: VectorDocument[]): Promise<void>;
  get(id: string): Promise<VectorDocument | undefined>;
  getMany(ids: string[]): Promise<VectorDocument[]>;
  delete(id: string): Promise<boolean>;
  deleteMany(ids: string[]): Promise<number>;
  has(id: string): Promise<boolean>;
  listIds(): Promise<string[]>;
  count(): Promise<number>;
  clear(): Promise<void>;

  // Similarity search
  search(query: VectorQuery): Promise<VectorQueryResult>;

  // Index statistics
  getStats(): Promise<VectorIndexStats>;
}
```

### Document Type

```ts
interface VectorDocument {
  id: string;           // Unique document ID, e.g. "docs/readme.md:0"
  content: string;      // Original text or chunked fragment
  embedding: number[];  // Precomputed embedding vector
  metadata?: Record<string, unknown>;  // Source file, type, chunk index, etc.
  createdAt: string;
  updatedAt: string;
}
```

### Query Type

```ts
interface VectorQuery {
  text?: string;         // Query text (converted to vector by adapter)
  embedding?: number[];  // Or provide precomputed vector directly
  topK?: number;         // Number of results (default 10)
  minScore?: number;     // Minimum similarity threshold (0-1)
  filter?: Record<string, unknown>;  // Exact metadata filter
  includeEmbeddings?: boolean;       // Include vectors in results
}
```

### Search Results

```ts
interface VectorQueryResult {
  results: VectorSearchResult[];  // Sorted by descending score
  total: number;                   // Total documents participating
  durationMs: number;              // Search duration
}

interface VectorSearchResult {
  document: VectorDocument;
  score: number;  // Cosine similarity (0-1)
}
```

### Current Implementation: LocalVectorStore

`LocalVectorStore` (`packages/core/src/rag/local-vector-store.ts`) is the sole VectorStore implementation:

- **Storage engine**: SQLite (`better-sqlite3`)
- **Vector storage**: Float64Array binary BLOB
- **Similarity calculation**: Cosine similarity (brute-force full scan)
- **Precomputed L2 norm**: Calculated and stored at insert time to avoid repeated computation during search
- **WAL mode**: Enabled by default, supports concurrent reads
- **Metadata filtering**: In-memory filtering (no JSON index), suitable for small metadata sets
- **Capacity**: Suitable for under 100K documents; consider migrating to a dedicated vector database (Pinecone, Milvus) beyond that

Key implementation detail:

```ts
function cosineSimilarity(a: number[], b: number[], normA: number, normB: number): number {
  if (normA === 0 || normB === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (normA * normB);
}
```

Notes:
- `search()` requires `embedding` (precomputed vector); it does not accept raw text queries. Callers must convert text to vectors via `EmbeddingAdapter` first.
- The database path is specified by the `dbPath` constructor parameter; directory creation is handled by `mkdirSync` within `initialize()`.

---

## Embedding Adapter Design

### Interface

```ts
interface EmbeddingAdapter {
  readonly name: string;       // "openai" | "voyage" | "local-hash"
  readonly dimensions: number; // Vector dimensions

  initialize(): Promise<void>;
  close(): Promise<void>;
  embed(text: string): Promise<number[]>;         // Single text embedding
  embedBatch(texts: string[]): Promise<number[][]>;  // Batch embedding
}
```

### Current Implementations

Three adapters in `packages/core/src/rag/embedding-adapter.ts`:

| Adapter | Model | Dimensions | Max Batch | Notes |
|---------|-------|------------|-----------|-------|
| `OpenAIEmbeddingAdapter` | text-embedding-3-small / large / ada-002 | 1536 / 3072 | 100 | Calls OpenAI Embeddings API |
| `VoyageEmbeddingAdapter` | voyage-3 / voyage-3-lite / voyage-code-3 | 1024 / 512 | 128 | Calls Voyage AI API |
| `LocalEmbeddingAdapter` | None (hash simulation) | 384 | Unlimited | Deterministic hash vectors, testing only |

### Factory Function

```ts
import { createEmbeddingAdapter } from "@vera/core";

const adapter = createEmbeddingAdapter({
  provider: "openai",
  apiKey: process.env.OPENAI_API_KEY,
  model: "text-embedding-3-small",
});
```

`provider` supports `"openai"` | `"voyage"` | `"local"`.

### Implementation Details

- **Batch processing**: `embedBatch` automatically splits text batches by `maxBatchSize` to avoid oversized requests.
- **Timeout control**: Each HTTP request uses `AbortController` with a timeout (default 30s).
- **Error propagation**: HTTP errors and network exceptions are wrapped as `EmbeddingError`, never leaking implementation details.
- **Local adapter**: `LocalEmbeddingAdapter` uses deterministic hashing to generate vectors; hash values are L2-normalized so identical input always produces identical vectors. Test/dev use only.

---

## DocumentLoader: Loading and Chunking

### Features

`DocumentLoader` (`packages/core/src/rag/document-loader.ts`) handles:

1. **Directory scanning**: Recursive scan of specified directories, filtered by extension
2. **Content reading**: Both synchronous and asynchronous reading modes
3. **Text chunking**: Splits long documents into overlapping semantic chunks
4. **Metadata extraction**: Records source file, file type, and chunk index

### Supported File Types

| Type | Extensions |
|------|-----------|
| Markdown | `.md`, `.mdx` |
| JSON | `.json`, `.jsonl` |
| TypeScript | `.ts`, `.tsx` |
| Text | `.js`, `.jsx`, `.mjs`, `.txt`, `.yaml`, `.yml`, `.toml`, `.py`, `.go`, `.rs`, `.java`, `.sh`, `.css`, `.html`, `.sql`, etc. |

Default excluded directories: `node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`.

### Chunking Strategy

```ts
const loader = new DocumentLoader({
  rootDir: "./docs",
  chunkSize: 1500,        // Characters (default 1500)
  chunkOverlap: 200,      // Overlap between chunks (default 200)
  maxFileSize: 1_000_000, // Max bytes per file (default 1MB)
});
```

The chunking algorithm prioritizes splitting at paragraph boundaries (`\n\n`) and sentence boundaries (`. `) to avoid cutting semantic units. When no natural boundary is found, it falls back to hard splits at `chunkSize`.

### Document ID Format

Each chunk ID follows the format `{relPath}:{chunkIndex}`, e.g. `docs/readme.md:0`, `src/index.ts:3`. An `idPrefix` option can be used to differentiate index sources.

---

## IncrementalIndexer

`IncrementalIndexer` (`packages/core/src/rag/incremental-indexer.ts`) implements mtime-based incremental indexing:

### Two Indexing Modes

1. **Full index `fullIndex()`**: Clears the existing index, scans all files, re-embeds and upserts.
2. **Incremental index `incrementalIndex()`**: Compares current file mtimes against the manifest, only indexes new and modified files, and removes old vectors for deleted files.

### Manifest

```ts
interface IndexManifestEntry {
  filePath: string;   // Path relative to rootDir
  mtimeMs: number;    // Last modified time
  docIds: string[];   // Vector document IDs for this file
}
```

The manifest is held in memory and can be exported to JSON via `exportManifest()` for persistence and restored via `loadManifest()` on restart.

### Usage

```ts
import {
  LocalVectorStore,
  createEmbeddingAdapter,
  DocumentLoader,
  IncrementalIndexer,
} from "@vera/core";

// 1. Initialize components
const store = new LocalVectorStore({
  dbPath: ".vera/vectors.db",
  dimensions: 1536,
});
await store.initialize();

const adapter = createEmbeddingAdapter({
  provider: "openai",
  apiKey: process.env.OPENAI_API_KEY,
});

const loader = new DocumentLoader({ rootDir: "./docs" });

// 2. Create incremental indexer
const indexer = new IncrementalIndexer({
  vectorStore: store,
  embeddingAdapter: adapter,
  documentLoader: loader,
  rootDir: process.cwd(),
});

// 3. First full index
const result = await indexer.fullIndex();
console.log(`Indexed ${result.documentsUpserted} documents`);

// 4. Subsequent incremental index
const incResult = await indexer.incrementalIndex();
console.log(`Updated ${incResult.filesIndexed}, deleted ${incResult.filesDeleted}`);
```

---

## Retrieval Flow

```
User query "how to configure a model"
  |
  v
1. Query embedding: queryEmbedding = await adapter.embed("how to configure a model")
  |
  v
2. Vector search: results = await store.search({
     embedding: queryEmbedding,
     topK: 5,
     minScore: 0.6,
     filter: { fileType: "markdown" },  // optional
   })
  |
  v
3. Sort results: descending by score, truncate to topK
  |
  v
4. Context injection: format retrieved results as prompt fragments
  |
  v
5. Inject into LLM prompt -> generate augmented answer
```

The current retrieval strategy is **pure semantic search** (cosine similarity). Hybrid search (keyword + semantic) and re-ranking are not yet implemented (on the P3 roadmap).

---

## Context Injection Format

Retrieved document chunks are assembled into the LLM context as:

```
## Relevant Documents

### Document 1: docs/config.md (similarity: 0.92)
Model configuration is managed through the VeraConfig object...

### Document 2: docs/core/adapters.md (similarity: 0.85)
Each adapter implements the unified LlmAdapter interface...
```

The injection format is the responsibility of the caller (tool implementation). The RAG module itself is format-agnostic and returns only structured `RetrievedChunk[]`.

---

## Configuration

### Full RAG Config

```json
{
  "rag": {
    "enabled": true,
    "embedding": {
      "provider": "openai",
      "model": "text-embedding-3-small",
      "apiKey": "$OPENAI_API_KEY"
    },
    "vectorStore": {
      "type": "local-sqlite",
      "dbPath": ".vera/vectors.db"
    },
    "indexing": {
      "directories": ["./docs", "./src"],
      "exclude": ["node_modules", ".git", "dist", "*.test.ts"],
      "chunkSize": 1500,
      "chunkOverlap": 200,
      "maxFileSize": 1048576
    },
    "retrieval": {
      "topK": 5,
      "minScore": 0.6,
      "rerank": false
    }
  }
}
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | OpenAI Embedding API key |
| `VOYAGE_API_KEY` | Voyage AI API key |

---

## Error Types

The RAG module defines a hierarchical error type system (`packages/core/src/rag/types.ts`):

| Error Class | Code | Trigger |
|-------------|------|---------|
| `RAGError` | Custom | Base class |
| `VectorStoreError` | `VECTOR_STORE_ERROR` | Storage operation failed |
| `VectorDimensionError` | `VECTOR_DIMENSION_ERROR` | Vector dimension mismatch |
| `EmbeddingError` | `EMBEDDING_ERROR` | API call failed |
| `DocumentNotFoundError` | `DOCUMENT_NOT_FOUND` | Document ID does not exist |
| `RAGNotInitializedError` | `RAG_NOT_INITIALIZED` | Called before initialization |

---

## Current Status and Roadmap

### Implemented (P1)

- `VectorStore` interface and `LocalVectorStore` (SQLite) implementation
- `EmbeddingAdapter` interface with OpenAI / Voyage / Local backends
- `DocumentLoader`: directory scanning, text chunking, metadata extraction
- `IncrementalIndexer`: mtime-based full and incremental indexing
- `knowledge_search` tool (`packages/core/src/tools/knowledge-search.ts`): retrieval entry point for the agent loop
- Error type system

### Planned (P2-P3)

| Feature | Priority | Notes |
|---------|----------|-------|
| Hybrid search | P2 | Combine BM25 keyword + semantic vector for better recall on exact matches |
| Re-ranking | P2 | Cross-Encoder secondary ranking of initial search results |
| Cloud VectorStore | P3 | Integrate Pinecone / Milvus / pgvector |
| Multimodal embeddings | P3 | Image embedding (CLIP) for text-image hybrid search |
| Auto-index scheduling | P3 | Watch mode: trigger incremental indexing on file changes |
| Retrieval cache | P3 | Cache high-frequency query results to reduce embedding API calls |
| Enhanced chunking | P3 | Semantic chunking (sentence-transformers), recursive chunking, code AST chunking |

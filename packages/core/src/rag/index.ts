export type {
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
} from "./types.js";

export {
  RAGError,
  VectorStoreError,
  VectorDimensionError,
  EmbeddingError,
  DocumentNotFoundError,
  RAGNotInitializedError,
} from "./types.js";

export { LocalVectorStore } from "./local-vector-store.js";
export type { LocalVectorStoreOptions } from "./local-vector-store.js";

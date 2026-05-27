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

export {
  OpenAIEmbeddingAdapter,
  VoyageEmbeddingAdapter,
  LocalEmbeddingAdapter,
  createEmbeddingAdapter,
} from "./embedding-adapter.js";
export type {
  OpenAIEmbeddingOptions,
  VoyageEmbeddingOptions,
  LocalEmbeddingOptions,
  EmbeddingProvider,
  CreateEmbeddingAdapterOptions,
} from "./embedding-adapter.js";

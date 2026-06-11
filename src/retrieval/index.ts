/**
 * `@infinityi/engine-lib/retrieval` — opt-in RAG primitives for document
 * loading, chunking, embeddings, vector stores, retrievers, and context
 * provider integration.
 *
 * The core run loop remains retrieval-agnostic. This module provides contracts
 * and helpers that hosts can wire into existing `ContextProvider`s.
 *
 * @module
 */

export { createTextChunker, recursiveTextChunker } from "./chunking";
export { retrieverContext } from "./context";
export { createDocumentLoader, loadDocuments, staticDocumentLoader } from "./loaders";
export { InMemoryVectorStore } from "./memory";
export type { InMemoryVectorStoreOptions } from "./memory";
export { createVectorRetriever, indexDocuments, mergeHybridResults } from "./retriever";
export {
  assertVector,
  cosineSimilarity,
  dotProduct,
  euclideanSimilarity,
  scoreVectors,
} from "./vector-store";
export type { VectorSimilarity } from "./vector-store";

export type {
  Chunker,
  ChunkerContext,
  DocumentLoader,
  DocumentLoaderOutput,
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResult,
  EmbeddingUsage,
  EmbeddingVector,
  HybridRetrievalOptions,
  IndexDocumentsOptions,
  IndexDocumentsResult,
  KeywordRetrievalResult,
  KeywordRetriever,
  LoadDocumentsResult,
  LoadedDocument,
  RetrievalChunk,
  RetrievalQuery,
  RetrievalResult,
  RetrievalScores,
  Retriever,
  RetrieverContextBudgetOptions,
  RetrieverContextOptions,
  RetrieverContextProvider,
  SourceAttribution,
  SourceLocation,
  TextChunkerOptions,
  VectorQuery,
  VectorRecord,
  VectorRecordFilter,
  VectorRetrieverOptions,
  VectorSearchResult,
  VectorStore,
  VectorStoreStats,
} from "./types";

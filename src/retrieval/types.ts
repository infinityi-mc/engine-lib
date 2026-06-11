/**
 * Public contracts for document loading, chunking, embeddings, vector storage,
 * retrievers, and context-provider integration.
 *
 * @module
 */

import type { ContextResolveContext, ContextProvider, TokenCounter } from "../context/types";
import type { EngineContext } from "../runtime/types";

/** Location of a document or chunk inside its source. */
export interface SourceLocation {
  readonly startOffset?: number;
  readonly endOffset?: number;
  readonly startLine?: number;
  readonly endLine?: number;
}

/** Source metadata carried through chunks, vector records, and retrieval hits. */
export interface SourceAttribution {
  readonly id?: string;
  readonly uri?: string;
  readonly title?: string;
  readonly mimeType?: string;
  readonly location?: SourceLocation;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A source document before chunking. */
export interface LoadedDocument {
  readonly id?: string;
  readonly content: string;
  readonly source?: SourceAttribution;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** The values a document loader may return. */
export type DocumentLoaderOutput = Iterable<LoadedDocument> | AsyncIterable<LoadedDocument>;

/** Loads source documents from a host-owned corpus. */
export interface DocumentLoader {
  readonly name: string;
  load(ctx?: EngineContext): DocumentLoaderOutput | Promise<DocumentLoaderOutput>;
}

/** Result summary for loading documents from one or more loaders. */
export interface LoadDocumentsResult {
  readonly documents: readonly LoadedDocument[];
  readonly loaders: number;
}

/** A source document unit after chunking. */
export interface RetrievalChunk {
  readonly id: string;
  readonly text: string;
  readonly source?: SourceAttribution;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Context passed to chunkers while indexing documents. */
export interface ChunkerContext {
  readonly documentIndex: number;
  readonly engine?: EngineContext;
}

/** Splits a loaded document into retrieval chunks. */
export interface Chunker {
  readonly name: string;
  chunk(
    document: LoadedDocument,
    ctx?: ChunkerContext,
  ): readonly RetrievalChunk[] | Promise<readonly RetrievalChunk[]>;
}

/** Options for the built-in plain-text chunker. */
export interface TextChunkerOptions {
  readonly maxChars: number;
  readonly overlapChars?: number;
  readonly separators?: readonly string[];
}

/** Embedding vector. */
export type EmbeddingVector = readonly number[];

/**
 * Request to an embedding provider.
 *
 * Providers should validate their own maximum batch size and throw a clear
 * provider-specific error when `input.length` exceeds what the backing service
 * can accept. `indexDocuments` batches calls with `batchSize` to help callers
 * stay within those limits.
 */
export interface EmbeddingRequest {
  readonly input: readonly string[];
  readonly model?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Optional embedding token accounting. */
export interface EmbeddingUsage {
  readonly inputTokens?: number;
  readonly totalTokens?: number;
}

/** Embedding provider response. */
export interface EmbeddingResult {
  readonly model: string;
  readonly vectors: readonly EmbeddingVector[];
  readonly dimensions?: number;
  readonly usage?: EmbeddingUsage;
  readonly raw?: unknown;
}

/**
 * Host-supplied embedding provider contract.
 *
 * Implementations should document their maximum `input` batch size. Callers can
 * tune `IndexDocumentsOptions.batchSize` for indexing, while query retrieval
 * sends one input per embedding call.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly defaultModel?: string;
  readonly dimensions?: number;
  embed(req: EmbeddingRequest, ctx?: EngineContext): Promise<EmbeddingResult>;
}

/** A vector-store record. */
export interface VectorRecord {
  readonly id: string;
  readonly vector: EmbeddingVector;
  readonly text: string;
  readonly source?: SourceAttribution;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Host-supplied vector record filter. */
export type VectorRecordFilter = (record: VectorRecord) => boolean;

/** Query against a vector store. */
export interface VectorQuery {
  readonly vector: EmbeddingVector;
  readonly topK?: number;
  readonly filter?: VectorRecordFilter;
  readonly minScore?: number;
  readonly includeVectors?: boolean;
}

/** A vector-store search hit. */
export interface VectorSearchResult {
  readonly id: string;
  readonly score: number;
  readonly text: string;
  readonly source?: SourceAttribution;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly vector?: EmbeddingVector;
}

/** Vector-store statistics. */
export interface VectorStoreStats {
  readonly records: number;
  readonly dimensions?: number;
}

/** Minimal vector-store contract. */
export interface VectorStore {
  readonly name: string;
  readonly dimensions?: number;
  upsert(records: readonly VectorRecord[], ctx?: EngineContext): Promise<void>;
  query(query: VectorQuery, ctx?: EngineContext): Promise<readonly VectorSearchResult[]>;
  delete?(ids: readonly string[], ctx?: EngineContext): Promise<void>;
  clear?(ctx?: EngineContext): Promise<void>;
  stats?(ctx?: EngineContext): Promise<VectorStoreStats>;
}

/** Query passed to retrievers. */
export interface RetrievalQuery {
  readonly query: string;
  readonly topK?: number;
  readonly filter?: VectorRecordFilter;
  readonly minScore?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Per-channel retrieval scores. */
export interface RetrievalScores {
  readonly vector?: number;
  readonly keyword?: number;
  readonly combined?: number;
}

/** A retriever result ready for context rendering. */
export interface RetrievalResult {
  readonly id: string;
  readonly rank: number;
  readonly score: number;
  readonly scores?: RetrievalScores;
  readonly text: string;
  readonly source?: SourceAttribution;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Main retrieval contract. */
export interface Retriever {
  readonly name: string;
  retrieve(query: RetrievalQuery, ctx?: EngineContext): Promise<readonly RetrievalResult[]>;
}

/** Keyword retrieval hit used for hybrid merging. */
export interface KeywordRetrievalResult {
  readonly id: string;
  readonly score: number;
  readonly text: string;
  readonly source?: SourceAttribution;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Optional keyword retriever hook. */
export interface KeywordRetriever {
  readonly name?: string;
  retrieve(query: RetrievalQuery, ctx?: EngineContext): Promise<readonly KeywordRetrievalResult[]>;
}

/** Hybrid merge settings for vector and keyword retrieval results. */
export interface HybridRetrievalOptions {
  readonly topK?: number;
  readonly minScore?: number;
  readonly vectorWeight?: number;
  readonly keywordWeight?: number;
}

/** Options for constructing a vector retriever. */
export interface VectorRetrieverOptions {
  readonly name?: string;
  readonly embeddings: EmbeddingProvider;
  readonly store: VectorStore;
  readonly model?: string;
  readonly topK?: number;
  readonly minScore?: number;
  readonly filter?: VectorRecordFilter;
  readonly keyword?: KeywordRetriever;
  readonly hybrid?: HybridRetrievalOptions;
}

/** Options for indexing loaded documents into a vector store. */
export interface IndexDocumentsOptions {
  readonly loaders: readonly DocumentLoader[];
  readonly chunker: Chunker;
  readonly embeddings: EmbeddingProvider;
  readonly store: VectorStore;
  /** Number of chunks to embed per provider call. Defaults to 64; tune to provider limits. */
  readonly batchSize?: number;
  readonly embeddingModel?: string;
}

/** Summary returned by document indexing. */
export interface IndexDocumentsResult {
  readonly documents: number;
  readonly chunks: number;
  readonly records: number;
  readonly model?: string;
  readonly dimensions?: number;
}

/** Options that control retriever context budget selection. */
export interface RetrieverContextBudgetOptions {
  readonly maxContextTokens?: number;
  readonly reserveTokens?: number;
  /**
   * Counts rendered context tokens for budget checks. Keep this local and
   * synchronous; truncating an oversized retrieval result may call it multiple
   * times to find the largest exact fit.
   */
  readonly countTokens?: TokenCounter;
}

/** Options for converting a retriever into a context provider. */
export interface RetrieverContextOptions extends RetrieverContextBudgetOptions {
  readonly retriever: Retriever;
  readonly name?: string;
  readonly title?: string;
  readonly query?: string | ((ctx: EngineContext, run?: ContextResolveContext) => string | undefined | Promise<string | undefined>);
  readonly topK?: number;
  readonly minScore?: number;
  /** Include numeric retrieval scores in rendered context. Defaults to false. */
  readonly includeScores?: boolean;
  readonly onResults?: (
    results: readonly RetrievalResult[],
    query: string,
    ctx: EngineContext,
    run?: ContextResolveContext,
  ) => void | Promise<void>;
}

/** Semantic marker for the `ContextProvider` returned by {@link retrieverContext}. */
export type RetrieverContextProvider = ContextProvider;

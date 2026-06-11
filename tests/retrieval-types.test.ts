import { describe, expect, it } from "bun:test";

import type {
  Chunker,
  DocumentLoader,
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResult,
  EmbeddingVector,
  HybridRetrievalOptions,
  KeywordRetriever,
  LoadedDocument,
  RetrievalQuery,
  RetrievalResult,
  Retriever,
  RetrieverContextOptions,
  SourceAttribution,
  SourceLocation,
  VectorQuery,
  VectorRecord,
  VectorStore,
} from "../src/retrieval/index";
import {
  InMemoryVectorStore,
  createDocumentLoader,
  createTextChunker,
  createVectorRetriever,
  retrieverContext,
  staticDocumentLoader,
} from "../src/retrieval/index";

function assertRetrievalTypes(): void {
  const location: SourceLocation = { startLine: 1, endLine: 2, startOffset: 0, endOffset: 42 };
  const source: SourceAttribution = { uri: "doc.md", title: "Doc", location, metadata: { kind: "runbook" } };
  const doc: LoadedDocument = { id: "doc", content: "hello", source, metadata: { tenant: "t1" } };
  const loader: DocumentLoader = staticDocumentLoader([doc]);
  const customLoader: DocumentLoader = createDocumentLoader("custom", () => [doc]);
  const chunker: Chunker = createTextChunker({ maxChars: 100, overlapChars: 10 });

  const request: EmbeddingRequest = { input: ["hello"], model: "m", metadata: { tenant: "t1" } };
  const result: EmbeddingResult = { model: "m", vectors: [[1, 0]], dimensions: 2, usage: { inputTokens: 1 } };
  void [request, result];

  const embeddings: EmbeddingProvider = {
    name: "typed-embeddings",
    defaultModel: "m",
    dimensions: 2,
    async embed(req) {
      return { model: req.model ?? "m", vectors: req.input.map(() => [1, 0]), dimensions: 2 };
    },
  };

  const vector: EmbeddingVector = [1, 0];
  const record: VectorRecord = { id: "r1", vector, text: "hello", source, metadata: { tag: "x" } };
  const query: VectorQuery = { vector, topK: 5, filter: (candidate) => candidate.id === record.id, minScore: 0 };
  const store: VectorStore = new InMemoryVectorStore({ dimensions: 2 });
  void [query, store.upsert([record])];

  const keyword: KeywordRetriever = {
    async retrieve(q: RetrievalQuery) {
      return [{ id: q.query, score: 1, text: q.query, source }];
    },
  };
  const hybrid: HybridRetrievalOptions = { vectorWeight: 0.5, keywordWeight: 0.5, topK: 3 };
  const retriever: Retriever = createVectorRetriever({ embeddings, store, keyword, hybrid });
  const retrievalResult: RetrievalResult = {
    id: "r1",
    rank: 1,
    score: 1,
    scores: { vector: 1, keyword: 0.5, combined: 0.8 },
    text: "hello",
    source,
  };
  void retrievalResult;

  const contextOptions: RetrieverContextOptions = {
    retriever,
    query: (_ctx, run) => run?.agentName,
    maxContextTokens: 100,
    onResults: (results, q) => { void [results, q]; },
  };
  void retrieverContext(contextOptions);
  void [loader, customLoader, chunker];

  // @ts-expect-error LoadedDocument requires content.
  const badDocument: LoadedDocument = { id: "missing-content" };
  // @ts-expect-error EmbeddingVector entries must be numbers.
  const badVector: EmbeddingVector = ["not-a-number"];
  // @ts-expect-error VectorRecord requires text.
  const badRecord: VectorRecord = { id: "bad", vector };
  // @ts-expect-error RetrieverContextOptions requires a retriever.
  const badContext: RetrieverContextOptions = { maxContextTokens: 100 };
  void [badDocument, badVector, badRecord, badContext];
}

describe("retrieval type contract", () => {
  it("keeps retrieval interfaces and helpers stable", () => {
    void assertRetrievalTypes;
    expect(true).toBe(true);
  });
});

import type { EngineContext } from "../runtime/types";
import { loadDocuments } from "./loaders";
import type {
  EmbeddingProvider,
  EmbeddingVector,
  HybridRetrievalOptions,
  IndexDocumentsOptions,
  IndexDocumentsResult,
  KeywordRetrievalResult,
  RetrievalChunk,
  RetrievalQuery,
  RetrievalResult,
  Retriever,
  VectorRecord,
  VectorRetrieverOptions,
  VectorSearchResult,
} from "./types";
import { assertPositiveInteger, throwIfAborted } from "./utils";
import { assertVector } from "./vector-store";

function defaultModel(
  provider: EmbeddingProvider,
  model?: string,
): string | undefined {
  return model ?? provider.defaultModel;
}

function assertEmbeddingCount(
  expected: number,
  actual: readonly EmbeddingVector[],
): void {
  if (actual.length !== expected) {
    throw new Error(
      `embedding provider returned ${actual.length} vectors for ${expected} inputs`,
    );
  }
}

function fromVectorHit(
  hit: VectorSearchResult,
  index: number,
): RetrievalResult {
  return {
    id: hit.id,
    rank: index + 1,
    score: hit.score,
    scores: { vector: hit.score },
    text: hit.text,
    ...(hit.source !== undefined ? { source: hit.source } : {}),
    ...(hit.metadata !== undefined ? { metadata: hit.metadata } : {}),
  };
}

function normalizeScore(score: number, min: number, max: number): number {
  if (max === min) return score > 0 ? 1 : 0;
  return (score - min) / (max - min);
}

function scoreBounds(results: readonly { readonly score: number }[]): {
  readonly min: number;
  readonly max: number;
} {
  if (results.length === 0) return { min: 0, max: 0 };
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const result of results) {
    min = Math.min(min, result.score);
    max = Math.max(max, result.score);
  }
  return { min, max };
}

interface HybridEntry {
  readonly id: string;
  readonly text: string;
  readonly source?: RetrievalResult["source"];
  readonly metadata?: RetrievalResult["metadata"];
  readonly vectorRaw?: number;
  readonly keywordRaw?: number;
  readonly vectorNormalized?: number;
  readonly keywordNormalized?: number;
}

/** Merge vector and keyword retrieval hits with score normalization and de-duplication. */
export function mergeHybridResults(
  vectorResults: readonly RetrievalResult[],
  keywordResults: readonly KeywordRetrievalResult[],
  options: HybridRetrievalOptions = {},
): RetrievalResult[] {
  const inferredTopK = Math.max(vectorResults.length, keywordResults.length);
  if (options.topK === undefined && inferredTopK === 0) return [];
  const topK = options.topK ?? inferredTopK;
  assertPositiveInteger("topK", topK);
  const vectorWeight = options.vectorWeight ?? 0.7;
  const keywordWeight = options.keywordWeight ?? 0.3;
  const vectorBounds = scoreBounds(vectorResults);
  const keywordBounds = scoreBounds(keywordResults);
  const entries = new Map<string, HybridEntry>();

  for (const result of vectorResults) {
    const previous = entries.get(result.id);
    entries.set(result.id, {
      id: result.id,
      text: previous?.text ?? result.text,
      ...(previous?.source !== undefined || result.source !== undefined
        ? { source: previous?.source ?? result.source }
        : {}),
      ...(previous?.metadata !== undefined || result.metadata !== undefined
        ? { metadata: previous?.metadata ?? result.metadata }
        : {}),
      ...(previous?.keywordRaw !== undefined
        ? { keywordRaw: previous.keywordRaw }
        : {}),
      ...(previous?.keywordNormalized !== undefined
        ? { keywordNormalized: previous.keywordNormalized }
        : {}),
      vectorRaw: result.score,
      vectorNormalized: normalizeScore(
        result.score,
        vectorBounds.min,
        vectorBounds.max,
      ),
    });
  }

  for (const result of keywordResults) {
    const previous = entries.get(result.id);
    const text =
      previous?.text === undefined || previous.text === ""
        ? result.text
        : previous.text;
    entries.set(result.id, {
      id: result.id,
      text,
      ...(previous?.source !== undefined || result.source !== undefined
        ? { source: previous?.source ?? result.source }
        : {}),
      ...(previous?.metadata !== undefined || result.metadata !== undefined
        ? { metadata: previous?.metadata ?? result.metadata }
        : {}),
      ...(previous?.vectorRaw !== undefined
        ? { vectorRaw: previous.vectorRaw }
        : {}),
      ...(previous?.vectorNormalized !== undefined
        ? { vectorNormalized: previous.vectorNormalized }
        : {}),
      keywordRaw: result.score,
      keywordNormalized: normalizeScore(
        result.score,
        keywordBounds.min,
        keywordBounds.max,
      ),
    });
  }

  const merged = [...entries.values()]
    .map((entry) => {
      const combined =
        (entry.vectorNormalized ?? 0) * vectorWeight +
        (entry.keywordNormalized ?? 0) * keywordWeight;
      return {
        id: entry.id,
        rank: 0,
        score: combined,
        scores: {
          ...(entry.vectorRaw !== undefined ? { vector: entry.vectorRaw } : {}),
          ...(entry.keywordRaw !== undefined
            ? { keyword: entry.keywordRaw }
            : {}),
          combined,
        },
        text: entry.text,
        ...(entry.source !== undefined ? { source: entry.source } : {}),
        ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
      } satisfies RetrievalResult;
    })
    .filter(
      (result) =>
        options.minScore === undefined || result.score >= options.minScore,
    )
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, topK);

  return merged.map((result, index) => ({ ...result, rank: index + 1 }));
}

/** Load, chunk, embed, and upsert documents into a vector store. */
export async function indexDocuments(
  options: IndexDocumentsOptions,
  ctx?: EngineContext,
): Promise<IndexDocumentsResult> {
  const batchSize = options.batchSize ?? 64;
  assertPositiveInteger("batchSize", batchSize);
  const loaded = await loadDocuments(options.loaders, ctx);
  const chunks: RetrievalChunk[] = [];
  for (
    let documentIndex = 0;
    documentIndex < loaded.documents.length;
    documentIndex += 1
  ) {
    throwIfAborted(ctx);
    const document = loaded.documents[documentIndex];
    if (document === undefined) continue;
    const documentChunks = await options.chunker.chunk(document, {
      documentIndex,
      ...(ctx !== undefined ? { engine: ctx } : {}),
    });
    chunks.push(...documentChunks);
  }

  let records = 0;
  let model: string | undefined;
  let dimensions: number | undefined;
  for (let start = 0; start < chunks.length; start += batchSize) {
    throwIfAborted(ctx);
    const batch = chunks.slice(start, start + batchSize);
    const result = await options.embeddings.embed(
      {
        input: batch.map((chunk) => chunk.text),
        ...(defaultModel(options.embeddings, options.embeddingModel) !==
        undefined
          ? { model: defaultModel(options.embeddings, options.embeddingModel) }
          : {}),
      },
      ctx,
    );
    assertEmbeddingCount(batch.length, result.vectors);
    model = result.model;
    if (result.dimensions !== undefined) dimensions = result.dimensions;

    const vectorRecords: VectorRecord[] = [];
    for (let index = 0; index < batch.length; index += 1) {
      const chunk = batch[index];
      const vector = result.vectors[index];
      if (chunk === undefined || vector === undefined) continue;
      assertVector(vector, `embedding ${chunk.id}`);
      if (dimensions === undefined) dimensions = vector.length;
      vectorRecords.push({
        id: chunk.id,
        vector,
        text: chunk.text,
        ...(chunk.source !== undefined ? { source: chunk.source } : {}),
        ...(chunk.metadata !== undefined ? { metadata: chunk.metadata } : {}),
      });
    }
    await options.store.upsert(vectorRecords, ctx);
    records += vectorRecords.length;
  }

  return {
    documents: loaded.documents.length,
    chunks: chunks.length,
    records,
    ...(model !== undefined ? { model } : {}),
    ...(dimensions !== undefined ? { dimensions } : {}),
  };
}

/** Create a retriever that embeds the query and searches a vector store. */
export function createVectorRetriever(
  options: VectorRetrieverOptions,
): Retriever {
  assertPositiveInteger("topK", options.topK);
  return {
    name: options.name ?? `vector:${options.store.name}`,
    async retrieve(
      query: RetrievalQuery,
      ctx?: EngineContext,
    ): Promise<readonly RetrievalResult[]> {
      throwIfAborted(ctx);
      const topK = query.topK ?? options.hybrid?.topK ?? options.topK ?? 5;
      assertPositiveInteger("topK", topK);
      const embed = await options.embeddings.embed(
        {
          input: [query.query],
          ...(defaultModel(options.embeddings, options.model) !== undefined
            ? { model: defaultModel(options.embeddings, options.model) }
            : {}),
        },
        ctx,
      );
      assertEmbeddingCount(1, embed.vectors);
      const vector = embed.vectors[0];
      if (vector === undefined)
        throw new Error("embedding provider returned no query vector");
      assertVector(vector, "query embedding");
      const vectorHits = await options.store.query(
        {
          vector,
          topK,
          ...(query.filter !== undefined || options.filter !== undefined
            ? { filter: query.filter ?? options.filter }
            : {}),
          ...(query.minScore !== undefined || options.minScore !== undefined
            ? { minScore: query.minScore ?? options.minScore }
            : {}),
        },
        ctx,
      );
      const vectorResults = vectorHits.map(fromVectorHit);
      if (options.keyword === undefined)
        return vectorResults.map((result, index) => ({
          ...result,
          rank: index + 1,
        }));

      const keywordResults = await options.keyword.retrieve(
        { ...query, topK },
        ctx,
      );
      return mergeHybridResults(vectorResults, keywordResults, {
        ...options.hybrid,
        topK,
        ...(query.minScore !== undefined ||
        options.hybrid?.minScore !== undefined
          ? { minScore: query.minScore ?? options.hybrid?.minScore }
          : {}),
      });
    },
  };
}

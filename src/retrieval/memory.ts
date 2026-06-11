import { CancelledError } from "../errors";
import type { EngineContext } from "../runtime/types";
import type {
  EmbeddingVector,
  VectorQuery,
  VectorRecord,
  VectorSearchResult,
  VectorStore,
  VectorStoreStats,
} from "./types";
import { assertVector, scoreVectors, type VectorSimilarity } from "./vector-store";

/** Options for {@link InMemoryVectorStore}. */
export interface InMemoryVectorStoreOptions {
  readonly name?: string;
  readonly dimensions?: number;
  readonly similarity?: VectorSimilarity;
}

function throwIfAborted(ctx?: EngineContext): void {
  if (ctx?.signal?.aborted) throw new CancelledError("retrieval cancelled");
}

function cloneVector(vector: EmbeddingVector): number[] {
  return vector.map((value) => value);
}

function cloneRecord(record: VectorRecord): VectorRecord {
  return {
    id: record.id,
    vector: cloneVector(record.vector),
    text: record.text,
    ...(record.source !== undefined ? { source: record.source } : {}),
    ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
  };
}

function assertPositiveInteger(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

/** Network-free vector store for tests, examples, and small in-memory corpora. */
export class InMemoryVectorStore implements VectorStore {
  readonly name: string;

  private readonly records = new Map<string, VectorRecord>();
  private readonly similarity: VectorSimilarity;
  private recordDimensions: number | undefined;

  constructor(options: InMemoryVectorStoreOptions = {}) {
    assertPositiveInteger("dimensions", options.dimensions);
    this.name = options.name ?? "memory-vector-store";
    this.recordDimensions = options.dimensions;
    this.similarity = options.similarity ?? "cosine";
  }

  get dimensions(): number | undefined {
    return this.recordDimensions;
  }

  private ensureDimensions(vector: EmbeddingVector, label: string): void {
    assertVector(vector, label);
    if (this.recordDimensions === undefined) {
      this.recordDimensions = vector.length;
      return;
    }
    if (vector.length !== this.recordDimensions) {
      throw new TypeError(`${label} has ${vector.length} dimensions; expected ${this.recordDimensions}`);
    }
  }

  private ensureQueryDimensions(vector: EmbeddingVector): void {
    assertVector(vector, "query vector");
    if (this.recordDimensions !== undefined && vector.length !== this.recordDimensions) {
      throw new TypeError(`query vector has ${vector.length} dimensions; expected ${this.recordDimensions}`);
    }
  }

  async upsert(records: readonly VectorRecord[], ctx?: EngineContext): Promise<void> {
    for (const record of records) {
      throwIfAborted(ctx);
      if (record.id === "") throw new TypeError("record id must not be empty");
      this.ensureDimensions(record.vector, `record ${record.id} vector`);
      this.records.set(record.id, cloneRecord(record));
    }
  }

  async query(query: VectorQuery, ctx?: EngineContext): Promise<readonly VectorSearchResult[]> {
    throwIfAborted(ctx);
    this.ensureQueryDimensions(query.vector);
    const topK = query.topK ?? 10;
    assertPositiveInteger("topK", topK);
    const hits: VectorSearchResult[] = [];
    for (const record of this.records.values()) {
      throwIfAborted(ctx);
      if (query.filter !== undefined && !query.filter(record)) continue;
      const score = scoreVectors(query.vector, record.vector, this.similarity);
      if (query.minScore !== undefined && score < query.minScore) continue;
      hits.push({
        id: record.id,
        score,
        text: record.text,
        ...(record.source !== undefined ? { source: record.source } : {}),
        ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
        ...(query.includeVectors === true ? { vector: cloneVector(record.vector) } : {}),
      });
    }
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return hits.slice(0, topK);
  }

  async delete(ids: readonly string[], ctx?: EngineContext): Promise<void> {
    for (const id of ids) {
      throwIfAborted(ctx);
      this.records.delete(id);
    }
  }

  async clear(ctx?: EngineContext): Promise<void> {
    throwIfAborted(ctx);
    this.records.clear();
  }

  async stats(ctx?: EngineContext): Promise<VectorStoreStats> {
    throwIfAborted(ctx);
    return {
      records: this.records.size,
      ...(this.recordDimensions !== undefined ? { dimensions: this.recordDimensions } : {}),
    };
  }
}

import type { EmbeddingVector } from "./types";

/** Similarity modes supported by the in-memory vector store. */
export type VectorSimilarity = "cosine" | "dot" | "euclidean";

/** Validate that a value is a finite, non-empty vector. */
export function assertVector(vector: EmbeddingVector, label = "vector"): void {
  if (vector.length === 0) throw new TypeError(`${label} must not be empty`);
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(
        `${label} contains a non-finite value at index ${index}`,
      );
    }
  }
}

/** Dot product for equal-length vectors. */
export function dotProduct(a: EmbeddingVector, b: EmbeddingVector): number {
  let score = 0;
  for (let index = 0; index < a.length; index += 1)
    score += (a[index] ?? 0) * (b[index] ?? 0);
  return score;
}

/** Cosine similarity for equal-length vectors. */
export function cosineSimilarity(
  a: EmbeddingVector,
  b: EmbeddingVector,
): number {
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < a.length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dotProduct(a, b) / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

/** Convert Euclidean distance to a descending similarity score. */
export function euclideanSimilarity(
  a: EmbeddingVector,
  b: EmbeddingVector,
): number {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    sum += delta * delta;
  }
  return 1 / (1 + Math.sqrt(sum));
}

/** Score two vectors with the requested similarity mode. */
export function scoreVectors(
  a: EmbeddingVector,
  b: EmbeddingVector,
  similarity: VectorSimilarity,
): number {
  switch (similarity) {
    case "cosine":
      return cosineSimilarity(a, b);
    case "dot":
      return dotProduct(a, b);
    case "euclidean":
      return euclideanSimilarity(a, b);
  }
}

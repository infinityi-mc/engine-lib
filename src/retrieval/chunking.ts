import { CancelledError } from "../errors";
import type {
  Chunker,
  ChunkerContext,
  LoadedDocument,
  RetrievalChunk,
  SourceAttribution,
  SourceLocation,
  TextChunkerOptions,
} from "./types";

const DEFAULT_SEPARATORS = ["\n\n", "\n", ". ", " "] as const;

function throwIfAborted(ctx?: ChunkerContext): void {
  if (ctx?.engine?.signal?.aborted) throw new CancelledError("retrieval cancelled");
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineNumberAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = starts[mid] ?? 0;
    const next = starts[mid + 1] ?? Number.POSITIVE_INFINITY;
    if (offset >= start && offset < next) return mid + 1;
    if (offset < start) high = mid - 1;
    else low = mid + 1;
  }
  return Math.max(1, starts.length);
}

function trimRange(text: string, start: number, end: number): { readonly start: number; readonly end: number } {
  let trimmedStart = start;
  let trimmedEnd = end;
  while (trimmedStart < trimmedEnd && /\s/.test(text[trimmedStart] ?? "")) trimmedStart += 1;
  while (trimmedEnd > trimmedStart && /\s/.test(text[trimmedEnd - 1] ?? "")) trimmedEnd -= 1;
  return { start: trimmedStart, end: trimmedEnd };
}

function findChunkEnd(text: string, start: number, maxChars: number, separators: readonly string[]): number {
  const maxEnd = Math.min(text.length, start + maxChars);
  if (maxEnd >= text.length) return text.length;

  const minBreak = start + Math.floor(maxChars / 2);
  for (const separator of separators) {
    if (separator === "") continue;
    const index = text.lastIndexOf(separator, maxEnd);
    if (index > minBreak) return Math.min(text.length, index + separator.length);
  }
  return maxEnd;
}

function sourceForChunk(
  document: LoadedDocument,
  location: SourceLocation,
): SourceAttribution {
  return {
    ...(document.source ?? {}),
    ...(document.id !== undefined && document.source?.id === undefined ? { id: document.id } : {}),
    location,
  };
}

function chunkId(document: LoadedDocument, documentIndex: number, chunkIndex: number): string {
  const sourceId = document.id ?? document.source?.id ?? document.source?.uri ?? `document-${documentIndex + 1}`;
  return `${sourceId}#chunk-${chunkIndex + 1}`;
}

/**
 * Create a deterministic plain-text chunker that splits by character budget,
 * optional overlap, and separator preference while preserving source locations.
 */
export function createTextChunker(options: TextChunkerOptions): Chunker {
  const maxChars = options.maxChars;
  const overlapChars = options.overlapChars ?? 0;
  assertPositiveInteger("maxChars", maxChars);
  assertNonNegativeInteger("overlapChars", overlapChars);
  if (overlapChars >= maxChars) throw new TypeError("overlapChars must be smaller than maxChars");
  const separators = options.separators ?? DEFAULT_SEPARATORS;

  return {
    name: "text-chunker",
    chunk(document, ctx) {
      throwIfAborted(ctx);
      const text = document.content;
      if (text.trim() === "") return [];

      const starts = lineStarts(text);
      const chunks: RetrievalChunk[] = [];
      let start = 0;
      while (start < text.length) {
        throwIfAborted(ctx);
        const end = findChunkEnd(text, start, maxChars, separators);
        const trimmed = trimRange(text, start, end);
        if (trimmed.end > trimmed.start) {
          const location: SourceLocation = {
            startOffset: trimmed.start,
            endOffset: trimmed.end,
            startLine: lineNumberAt(starts, trimmed.start),
            endLine: lineNumberAt(starts, Math.max(trimmed.start, trimmed.end - 1)),
          };
          chunks.push({
            id: chunkId(document, ctx?.documentIndex ?? 0, chunks.length),
            text: text.slice(trimmed.start, trimmed.end),
            source: sourceForChunk(document, location),
            ...(document.metadata !== undefined ? { metadata: document.metadata } : {}),
          });
        }
        if (end >= text.length) break;
        start = Math.max(start + 1, end - overlapChars);
      }
      return chunks;
    },
  };
}

/** Alias for the built-in text chunker. */
export const recursiveTextChunker = createTextChunker;

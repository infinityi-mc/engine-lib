import type {
  Chunker,
  ChunkerContext,
  LoadedDocument,
  RetrievalChunk,
  SourceAttribution,
  SourceLocation,
  TextChunkerOptions,
} from "./types";
import {
  assertNonNegativeInteger,
  assertPositiveInteger,
  throwIfAborted,
} from "./utils";

const DEFAULT_SEPARATORS = ["\n\n", "\n", ". ", " "] as const;

interface Range {
  readonly start: number;
  readonly end: number;
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

function trimRange(
  text: string,
  start: number,
  end: number,
): { readonly start: number; readonly end: number } {
  let trimmedStart = start;
  let trimmedEnd = end;
  while (trimmedStart < trimmedEnd && /\s/.test(text[trimmedStart] ?? ""))
    trimmedStart += 1;
  while (trimmedEnd > trimmedStart && /\s/.test(text[trimmedEnd - 1] ?? ""))
    trimmedEnd -= 1;
  return { start: trimmedStart, end: trimmedEnd };
}

function findChunkEnd(
  text: string,
  start: number,
  maxChars: number,
  separators: readonly string[],
): number {
  const maxEnd = Math.min(text.length, start + maxChars);
  if (maxEnd >= text.length) return text.length;

  const minBreak = start + Math.floor(maxChars / 2);
  for (const separator of separators) {
    if (separator === "") continue;
    const index = text.lastIndexOf(separator, maxEnd);
    if (index > minBreak)
      return Math.min(text.length, index + separator.length);
  }
  return maxEnd;
}

function fixedRanges(text: string, offset: number, maxChars: number): Range[] {
  const ranges: Range[] = [];
  for (let start = 0; start < text.length; start += maxChars) {
    ranges.push({
      start: offset + start,
      end: offset + Math.min(text.length, start + maxChars),
    });
  }
  return ranges;
}

function splitBySeparator(
  text: string,
  offset: number,
  separator: string,
): Range[] {
  const ranges: Range[] = [];
  let start = 0;
  while (start < text.length) {
    const index = text.indexOf(separator, start);
    const end = index === -1 ? text.length : index + separator.length;
    ranges.push({ start: offset + start, end: offset + end });
    start = end;
  }
  return ranges;
}

function recursiveUnits(
  text: string,
  offset: number,
  maxChars: number,
  separators: readonly string[],
  separatorIndex: number,
): Range[] {
  if (text.length <= maxChars)
    return [{ start: offset, end: offset + text.length }];
  const separator = separators[separatorIndex];
  if (separator === undefined || separator === "")
    return fixedRanges(text, offset, maxChars);

  const split = splitBySeparator(text, offset, separator);
  if (split.length <= 1)
    return recursiveUnits(
      text,
      offset,
      maxChars,
      separators,
      separatorIndex + 1,
    );

  const out: Range[] = [];
  for (const range of split) {
    const length = range.end - range.start;
    if (length <= maxChars) out.push(range);
    else
      out.push(
        ...recursiveUnits(
          text.slice(range.start - offset, range.end - offset),
          range.start,
          maxChars,
          separators,
          separatorIndex + 1,
        ),
      );
  }
  return out;
}

function mergeRanges(ranges: readonly Range[], maxChars: number): Range[] {
  const merged: Range[] = [];
  let current: Range | undefined;
  for (const range of ranges) {
    if (current === undefined) {
      current = range;
      continue;
    }
    if (range.end - current.start <= maxChars) {
      current = { start: current.start, end: range.end };
      continue;
    }
    merged.push(current);
    current = range;
  }
  if (current !== undefined) merged.push(current);
  return merged;
}

function sourceForChunk(
  document: LoadedDocument,
  location: SourceLocation,
): SourceAttribution {
  return {
    ...(document.source ?? {}),
    ...(document.id !== undefined && document.source?.id === undefined
      ? { id: document.id }
      : {}),
    location,
  };
}

function chunkId(
  document: LoadedDocument,
  documentIndex: number,
  chunkIndex: number,
): string {
  const sourceId =
    document.id ??
    document.source?.id ??
    document.source?.uri ??
    `document-${documentIndex + 1}`;
  return `${sourceId}#chunk-${chunkIndex + 1}`;
}

function chunkFromRange(
  document: LoadedDocument,
  documentIndex: number,
  chunkIndex: number,
  starts: readonly number[],
  range: Range,
): RetrievalChunk | undefined {
  const trimmed = trimRange(document.content, range.start, range.end);
  if (trimmed.end <= trimmed.start) return undefined;
  const location: SourceLocation = {
    startOffset: trimmed.start,
    endOffset: trimmed.end,
    startLine: lineNumberAt(starts, trimmed.start),
    endLine: lineNumberAt(starts, Math.max(trimmed.start, trimmed.end - 1)),
  };
  return {
    id: chunkId(document, documentIndex, chunkIndex),
    text: document.content.slice(trimmed.start, trimmed.end),
    source: sourceForChunk(document, location),
    ...(document.metadata !== undefined ? { metadata: document.metadata } : {}),
  };
}

function createChunker(
  name: string,
  options: TextChunkerOptions,
  recursive: boolean,
): Chunker {
  const maxChars = options.maxChars;
  const overlapChars = options.overlapChars ?? 0;
  assertPositiveInteger("maxChars", maxChars);
  assertNonNegativeInteger("overlapChars", overlapChars);
  if (overlapChars >= maxChars)
    throw new TypeError("overlapChars must be smaller than maxChars");
  const separators = options.separators ?? DEFAULT_SEPARATORS;

  return {
    name,
    chunk(document, ctx) {
      throwIfAborted(ctx);
      const text = document.content;
      if (text.trim() === "") return [];

      const starts = lineStarts(text);
      const baseRanges = recursive
        ? mergeRanges(
            recursiveUnits(text, 0, maxChars, separators, 0),
            maxChars,
          )
        : (() => {
            const ranges: Range[] = [];
            let start = 0;
            while (start < text.length) {
              const end = findChunkEnd(text, start, maxChars, separators);
              ranges.push({ start, end });
              if (end >= text.length) break;
              start = Math.max(start + 1, end - overlapChars);
            }
            return ranges;
          })();
      const ranges = recursive
        ? baseRanges.map((range, index) => ({
            start:
              index === 0
                ? range.start
                : Math.max(0, range.end - maxChars, range.start - overlapChars),
            end: range.end,
          }))
        : baseRanges;

      const chunks: RetrievalChunk[] = [];
      for (const range of ranges) {
        throwIfAborted(ctx);
        const chunk = chunkFromRange(
          document,
          ctx?.documentIndex ?? 0,
          chunks.length,
          starts,
          range,
        );
        if (chunk !== undefined) chunks.push(chunk);
      }
      return chunks;
    },
  };
}

/**
 * Create a deterministic plain-text chunker that splits by character budget,
 * optional overlap, and separator preference while preserving source locations.
 */
export function createTextChunker(options: TextChunkerOptions): Chunker {
  return createChunker("text-chunker", options, false);
}

/** Create a text chunker that recursively splits oversized spans by separator priority. */
export function recursiveTextChunker(options: TextChunkerOptions): Chunker {
  return createChunker("recursive-text-chunker", options, true);
}

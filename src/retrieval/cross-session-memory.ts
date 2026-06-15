/**
 * Cross-session memory (Pillar E / Gap 17).
 *
 * A layer that *accumulates* knowledge across sessions — preferences,
 * corrections, salient facts — so an agent recalls them automatically rather
 * than re-learning each session. It is built entirely on the existing retrieval
 * contracts ({@link EmbeddingProvider} + {@link VectorStore}); there is no new
 * vector engine.
 *
 * Three pieces compose:
 * - {@link vectorMemoryStore} — store/recall over the existing vector stack.
 * - {@link memoryContextProvider} — a {@link ContextProvider} that recalls
 *   relevant memories and injects them as run-time system context (never
 *   persisted into session history).
 * - {@link memoryExtractor} — an `onFinish` hook that derives memories from a
 *   completed run and persists them (redacted, when filters are supplied).
 *
 * Every failure degrades gracefully: a recall failure injects no memories and
 * the run proceeds; a store failure in the extractor never fails the run.
 *
 * @module
 */

import type { ContextProvider, ContextResolveContext } from "../context/types";
import { redactTextForPersistence } from "../governance/redacting-codec";
import type { ContentFilter } from "../governance/filters";
import type { Message, TextPart } from "../messages/types";
import type { EngineContext } from "../runtime/types";
import type {
  EmbeddingProvider,
  VectorRecord,
  VectorRecordFilter,
  VectorStore,
} from "./types";

/** Provenance of a stored memory. */
export interface MemorySource {
  readonly sessionId: string;
  readonly runId?: string;
  /** ISO 8601 timestamp. */
  readonly timestamp: string;
}

/** One unit of cross-session memory. */
export interface MemoryEntry {
  readonly content: string;
  readonly source: MemorySource;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Options for {@link MemoryStore.recall}. */
export interface RecallOptions {
  readonly topK?: number;
  readonly minScore?: number;
  readonly filter?: VectorRecordFilter;
}

/** Store and recall cross-session memories. */
export interface MemoryStore {
  store(memory: MemoryEntry): Promise<void>;
  recall(
    query: string,
    options?: RecallOptions,
  ): Promise<readonly MemoryEntry[]>;
}

/** Options for {@link vectorMemoryStore}. */
export interface VectorMemoryStoreOptions {
  readonly embeddings: EmbeddingProvider;
  readonly store: VectorStore;
  readonly model?: string;
}

function model(
  embeddings: EmbeddingProvider,
  override?: string,
): string | undefined {
  return override ?? embeddings.defaultModel;
}

async function embedOne(
  embeddings: EmbeddingProvider,
  text: string,
  override: string | undefined,
  ctx?: EngineContext,
): Promise<readonly number[]> {
  const chosen = model(embeddings, override);
  const result = await embeddings.embed(
    { input: [text], ...(chosen !== undefined ? { model: chosen } : {}) },
    ctx,
  );
  const vector = result.vectors[0];
  if (vector === undefined)
    throw new Error("embedding provider returned no vector");
  return vector;
}

/** A stable id for a memory, derived from its provenance + content. */
function memoryId(entry: MemoryEntry): string {
  const basis = `${entry.source.sessionId}|${entry.source.runId ?? ""}|${entry.source.timestamp}|${entry.content}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < basis.length; index += 1) {
    hash ^= basis.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `mem_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function recordToEntry(record: {
  readonly text: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}): MemoryEntry | undefined {
  const meta = record.metadata ?? {};
  const source = meta.source as MemorySource | undefined;
  if (
    source === undefined ||
    typeof source.sessionId !== "string" ||
    typeof source.timestamp !== "string"
  )
    return undefined;
  // Strip the internal `source` key from the surfaced metadata.
  const { source: _omit, ...rest } = meta as Record<string, unknown>;
  return {
    content: record.text,
    source,
    ...(Object.keys(rest).length > 0 ? { metadata: rest } : {}),
  };
}

/**
 * A {@link MemoryStore} backed by an {@link EmbeddingProvider} + a
 * {@link VectorStore}. `store` embeds the memory content and upserts a vector
 * record (carrying `source` and any `metadata`); `recall` embeds the query and
 * returns the most similar memories.
 */
export function vectorMemoryStore(
  options: VectorMemoryStoreOptions,
): MemoryStore {
  return {
    async store(memory: MemoryEntry): Promise<void> {
      const vector = await embedOne(
        options.embeddings,
        memory.content,
        options.model,
      );
      const record: VectorRecord = {
        id: memoryId(memory),
        vector,
        text: memory.content,
        metadata: { ...(memory.metadata ?? {}), source: memory.source },
      };
      await options.store.upsert([record]);
    },
    async recall(
      query: string,
      recallOptions?: RecallOptions,
    ): Promise<readonly MemoryEntry[]> {
      const vector = await embedOne(options.embeddings, query, options.model);
      const hits = await options.store.query({
        vector,
        topK: recallOptions?.topK ?? 5,
        ...(recallOptions?.minScore !== undefined
          ? { minScore: recallOptions.minScore }
          : {}),
        ...(recallOptions?.filter !== undefined
          ? { filter: recallOptions.filter }
          : {}),
      });
      const entries: MemoryEntry[] = [];
      for (const hit of hits) {
        const entry = recordToEntry(hit);
        if (entry !== undefined) entries.push(entry);
      }
      return entries;
    },
  };
}

function textOf(message: Message): string {
  return message.content
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function latestUserText(
  messages: readonly Message[] | undefined,
): string | undefined {
  if (messages === undefined) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = textOf(message).trim();
    if (text !== "") return text;
  }
  return undefined;
}

/** Build a {@link VectorRecordFilter} that matches a memory's tenant. */
export function tenantMemoryFilter(tenantId: string): VectorRecordFilter {
  return (record) => record.metadata?.tenantId === tenantId;
}

/** Options for {@link memoryContextProvider}. */
export interface MemoryContextProviderOptions {
  readonly memory: MemoryStore;
  /** Query to recall on. String, resolver, or (default) the latest user input. */
  readonly query?:
    | string
    | ((
        ctx: EngineContext,
        run?: ContextResolveContext,
      ) => string | undefined | Promise<string | undefined>);
  readonly topK?: number;
  readonly minScore?: number;
  readonly filter?: VectorRecordFilter;
  /** Heading for the injected context block. Defaults to "Relevant Memory". */
  readonly title?: string;
  /** Invoked after a successful recall so the host can emit `memory.recalled`. */
  readonly onRecalled?: (
    entries: readonly MemoryEntry[],
    ctx: EngineContext,
    run?: ContextResolveContext,
  ) => void | Promise<void>;
}

async function resolveMemoryQuery(
  options: MemoryContextProviderOptions,
  ctx: EngineContext,
  run?: ContextResolveContext,
): Promise<string | undefined> {
  if (typeof options.query === "string")
    return options.query.trim() === "" ? undefined : options.query;
  if (typeof options.query === "function") {
    const value = await options.query(ctx, run);
    return value === undefined || value.trim() === "" ? undefined : value;
  }
  return latestUserText(run?.input) ?? latestUserText(run?.messages);
}

/**
 * A {@link ContextProvider} that recalls relevant memories and injects them as
 * run-time system context. Recalled memories are NOT written to session history
 * (consistent with {@link ContextProvider} semantics). A recall failure
 * degrades to injecting nothing — the run proceeds.
 */
export function memoryContextProvider(
  options: MemoryContextProviderOptions,
): ContextProvider {
  return {
    name: "memory",
    async resolve(ctx, run) {
      const query = await resolveMemoryQuery(options, ctx, run);
      if (query === undefined) return [];
      let entries: readonly MemoryEntry[];
      try {
        entries = await options.memory.recall(query, {
          ...(options.topK !== undefined ? { topK: options.topK } : {}),
          ...(options.minScore !== undefined
            ? { minScore: options.minScore }
            : {}),
          ...(options.filter !== undefined ? { filter: options.filter } : {}),
        });
      } catch (error) {
        ctx.logger?.warn?.("memory recall failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
      await options.onRecalled?.(entries, ctx, run);
      if (entries.length === 0) return [];
      const content = entries.map((entry) => `- ${entry.content}`).join("\n");
      return [{ title: options.title ?? "Relevant Memory", content }];
    },
  };
}

/** The completed-run facts handed to a {@link MemoryExtractOptions.extract}. */
export interface MemoryExtractInput {
  readonly output: string;
  readonly usage?: unknown;
}

/** Options for {@link memoryExtractor}. */
export interface MemoryExtractOptions {
  readonly memory: MemoryStore;
  /** Derive the salient memory strings from a completed run. */
  readonly extract: (
    input: MemoryExtractInput,
  ) => readonly string[] | Promise<readonly string[]>;
  /** Stamped onto each stored memory's `source.sessionId`. */
  readonly sessionId?: string;
  /** Stamped onto each stored memory's `source.runId` (Gap 14). */
  readonly runId?: string;
  /** Extra metadata merged into each entry (e.g. `{ tenantId }`). */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Filters applied to each memory before storage (NFR-6 redaction). */
  readonly filters?: readonly ContentFilter[];
  /** Timestamp source. Defaults to `() => new Date().toISOString()`. */
  readonly now?: () => string;
}

/**
 * An `AgentHooks["onFinish"]`-shaped function that derives memories from a
 * completed run and stores them, stamping `source.runId`/`sessionId` and
 * redacting via `filters` first. A store failure is swallowed (`onFinish` is
 * already isolated) so memory extraction never fails the run.
 */
export function memoryExtractor(
  options: MemoryExtractOptions,
): (
  event: { output: string; usage?: unknown },
  ctx: EngineContext,
) => Promise<void> {
  const now = options.now ?? (() => new Date().toISOString());
  return async (event, ctx) => {
    try {
      const strings = await options.extract({
        output: event.output,
        usage: event.usage,
      });
      for (const raw of strings) {
        const content =
          options.filters !== undefined && options.filters.length > 0
            ? await redactTextForPersistence(raw, options.filters)
            : raw;
        await options.memory.store({
          content,
          source: {
            ...(options.sessionId !== undefined
              ? { sessionId: options.sessionId }
              : { sessionId: "" }),
            ...(options.runId !== undefined ? { runId: options.runId } : {}),
            timestamp: now(),
          },
          ...(options.metadata !== undefined
            ? { metadata: options.metadata }
            : {}),
        });
      }
    } catch (error) {
      ctx.logger?.warn?.("memory extraction failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

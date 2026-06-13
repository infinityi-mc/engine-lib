/**
 * {@link createSession} — the synchronous factory for a {@link Session} handle.
 *
 * Construction never performs I/O: the underlying {@link SessionStore} is consulted
 * lazily on the first {@link Session.messages} / {@link Session.append} call. When a
 * store already holds history for the id, that history is resumed; otherwise any
 * `messages` seed is written through on first access.
 *
 * `runAgent` appends to a session only after a successful run. Instructions and
 * injected context are request-time system messages and are never persisted.
 *
 * @module
 */

import type { Message } from "../messages/types";
import { InMemorySessionStore } from "./store";
import type { AppendResult, Session, SessionStore } from "./types";

/** Options for {@link createSession}. */
export interface CreateSessionOptions {
  /** Stable id; when omitted a random id is generated. */
  readonly id?: string;
  /** Backing store; defaults to a fresh {@link InMemorySessionStore}. */
  readonly store?: SessionStore;
  /** Seed history, written through only once and only if the store has no history for this id. */
  readonly messages?: readonly Message[];
  /** Free-form metadata attached to the session handle. */
  readonly metadata?: Record<string, unknown>;
  /** Expected model used as the compatibility baseline when this session is resumed. */
  readonly expectedModel?: string;
  /** Expected provider used as the compatibility baseline when this session is resumed. */
  readonly expectedProvider?: string;
}

function generateId(): string {
  return `session_${crypto.randomUUID()}`;
}

/**
 * Create a {@link Session} handle. Synchronous: the store is read on first use,
 * so an existing conversation is resumed by passing its `id`.
 */
export function createSession(opts: CreateSessionOptions = {}): Session {
  const id = opts.id ?? generateId();
  const store = opts.store ?? new InMemorySessionStore();
  const seed = opts.messages;
  const metadata = opts.metadata;

  let seedPromise: Promise<void> | undefined;
  /**
   * Write the seed history through to the store once, if the store is empty.
   * Memoizes the in-flight promise so concurrent callers block on the same
   * seeding operation rather than racing past a half-set flag.
   */
  const ensureSeeded = (): Promise<void> => {
    if (seedPromise !== undefined) return seedPromise;
    seedPromise = (async () => {
      const existing = await store.load(id);
      const shouldSeedMessages = seed !== undefined && seed.length > 0 && (existing === undefined || existing.messages.length === 0);
      const shouldSeedMetadata = metadata !== undefined && existing === undefined;
      if (shouldSeedMessages || shouldSeedMetadata) {
        await store.save({
          id,
          messages: shouldSeedMessages ? seed ?? [] : existing?.messages ?? [],
          ...(shouldSeedMetadata ? { metadata } : existing?.metadata !== undefined ? { metadata: existing.metadata } : {}),
        });
      }
    })();
    return seedPromise;
  };

  return {
    id,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(opts.expectedModel !== undefined ? { expectedModel: opts.expectedModel } : {}),
    ...(opts.expectedProvider !== undefined ? { expectedProvider: opts.expectedProvider } : {}),
    async messages(): Promise<Message[]> {
      await ensureSeeded();
      const state = await store.load(id);
      return state === undefined ? [] : [...state.messages];
    },
    async append(messages: readonly Message[]): Promise<AppendResult> {
      await ensureSeeded();
      if (messages.length === 0) return {};
      return store.append(id, messages);
    },
    async setMetadata(nextMetadata: Record<string, unknown>): Promise<void> {
      await ensureSeeded();
      await store.setMetadata(id, nextMetadata);
    },
    async getMetadata(): Promise<Record<string, unknown> | undefined> {
      await ensureSeeded();
      const state = await store.load(id);
      return state?.metadata === undefined ? undefined : { ...state.metadata };
    },
    async clear(): Promise<void> {
      // Let an in-flight seed write finish first so it can't `append` *after* we
      // delete (leaving stale seed data), then mark seeding done so it never
      // runs again — a cleared session must not be re-seeded.
      const inflight = seedPromise;
      seedPromise = Promise.resolve();
      if (inflight !== undefined) {
        await inflight.catch(() => {}); // ignore a seed failure during clear
      }
      await store.delete(id);
    },
  };
}

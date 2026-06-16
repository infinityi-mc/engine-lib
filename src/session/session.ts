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
import { forkSession } from "./fork";
import { readResumeInfo, RESUME_METADATA_KEY } from "./resume";
import { InMemorySessionStore } from "./store";
import type { AppendResult, ForkOptions, Session, SessionStore } from "./types";

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
  /** Optional tenant owner persisted with newly-created sessions. */
  readonly tenantId?: string;
  /** Expected model used as the compatibility baseline when this session is resumed. */
  readonly expectedModel?: string;
  /** Expected provider used as the compatibility baseline when this session is resumed. */
  readonly expectedProvider?: string;
}

function generateId(): string {
  return `session_${crypto.randomUUID()}`;
}

const sessionQueues = new WeakMap<SessionStore, Map<string, Promise<void>>>();

async function enqueueSession<T>(
  store: SessionStore,
  id: string,
  task: () => Promise<T>,
): Promise<T> {
  let queues = sessionQueues.get(store);
  if (queues === undefined) {
    queues = new Map();
    sessionQueues.set(store, queues);
  }
  const previous = queues.get(id) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const next = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(id, next);
  try {
    return await run;
  } finally {
    if (queues.get(id) === next) queues.delete(id);
  }
}

function mergeUserMetadata(
  existing: Readonly<Record<string, unknown>> | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const existingMetadata = existing ?? {};
  const incomingResume = readResumeInfo(next);
  const preservedEngine = Object.fromEntries(
    Object.entries(existingMetadata).filter(([key]) =>
      key.startsWith("engine:"),
    ),
  );
  const userMetadata = Object.fromEntries(
    Object.entries(next).filter(([key]) => !key.startsWith("engine:")),
  );
  return {
    ...existingMetadata,
    ...userMetadata,
    ...preservedEngine,
    ...(incomingResume !== undefined
      ? { [RESUME_METADATA_KEY]: incomingResume }
      : {}),
  };
}

function seedState(
  id: string,
  seed: readonly Message[] | undefined,
  metadata: Record<string, unknown> | undefined,
  tenantId: string | undefined,
  existing: Awaited<ReturnType<SessionStore["load"]>>,
) {
  const shouldSeedMessages =
    seed !== undefined &&
    seed.length > 0 &&
    (existing === undefined || existing.messages.length === 0);
  const shouldSeedMetadata = metadata !== undefined && existing === undefined;
  if (!shouldSeedMessages && !shouldSeedMetadata) return undefined;
  return {
    id,
    messages: shouldSeedMessages ? (seed ?? []) : (existing?.messages ?? []),
    ...(shouldSeedMetadata
      ? { metadata }
      : existing?.metadata !== undefined
        ? { metadata: existing.metadata }
        : {}),
    version: existing?.version ?? 1,
    ...(tenantId !== undefined ? { tenantId } : {}),
  };
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
  const tenantId = opts.tenantId;

  // Forward declaration so the handle's `fork` can reference the live handle.
  let handle: Session;

  let seedPromise: Promise<void> | undefined;
  /**
   * Write the seed history through to the store once, if the store is empty.
   * Memoizes the in-flight promise so concurrent callers block on the same
   * seeding operation rather than racing past a half-set flag.
   */
  const ensureSeeded = (): Promise<void> => {
    if (seedPromise !== undefined) return seedPromise;
    seedPromise = (async () => {
      if (tenantId !== undefined) {
        await store.claimTenant({
          id,
          tenantId,
          ...(seed !== undefined && seed.length > 0 ? { messages: seed } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
        });
        return;
      }

      await enqueueSession(store, id, async () => {
        const existing = await store.load(id);
        const state = seedState(id, seed, metadata, tenantId, existing);
        if (state !== undefined) await store.save(state);
      });
    })();
    return seedPromise;
  };

  handle = {
    id,
    store,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(opts.expectedModel !== undefined
      ? { expectedModel: opts.expectedModel }
      : {}),
    ...(opts.expectedProvider !== undefined
      ? { expectedProvider: opts.expectedProvider }
      : {}),
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
      await enqueueSession(store, id, async () => {
        const existing = await store.load(id);
        await store.setMetadata(
          id,
          mergeUserMetadata(existing?.metadata, nextMetadata),
        );
      });
    },
    async getMetadata(): Promise<Record<string, unknown> | undefined> {
      await ensureSeeded();
      const state = await store.load(id);
      return state?.metadata === undefined ? undefined : { ...state.metadata };
    },
    async fork(options?: ForkOptions): Promise<Session> {
      await ensureSeeded();
      return forkSession(handle, options);
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
  return handle;
}

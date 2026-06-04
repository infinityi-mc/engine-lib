/**
 * {@link createSession} — the synchronous factory for a {@link Session} handle.
 *
 * Construction never performs I/O: the underlying {@link SessionStore} is consulted
 * lazily on the first {@link Session.messages} / {@link Session.append} call. When a
 * store already holds history for the id, that history is resumed; otherwise any
 * `messages` seed is written through on first access.
 *
 * @module
 */

import type { Message } from "../messages/types";
import { InMemorySessionStore } from "./store";
import type { Session, SessionStore } from "./types";

/** Options for {@link createSession}. */
export interface CreateSessionOptions {
  /** Stable id; when omitted a random id is generated. */
  readonly id?: string;
  /** Backing store; defaults to a fresh {@link InMemorySessionStore}. */
  readonly store?: SessionStore;
  /** Seed history, written through only if the store has none for this id. */
  readonly messages?: readonly Message[];
  /** Free-form metadata attached to the session handle. */
  readonly metadata?: Record<string, unknown>;
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

  let seeded = false;
  /** Write the seed history through to the store once, if the store is empty. */
  const ensureSeeded = async (): Promise<void> => {
    if (seeded) return;
    seeded = true;
    if (seed === undefined || seed.length === 0) return;
    const existing = await store.load(id);
    if (existing === undefined || existing.messages.length === 0) {
      await store.append(id, seed);
    }
  };

  return {
    id,
    ...(metadata !== undefined ? { metadata } : {}),
    async messages(): Promise<Message[]> {
      await ensureSeeded();
      const state = await store.load(id);
      return state === undefined ? [] : [...state.messages];
    },
    async append(messages: readonly Message[]): Promise<void> {
      await ensureSeeded();
      if (messages.length === 0) return;
      await store.append(id, messages);
    },
    async clear(): Promise<void> {
      seeded = true; // a cleared session must not be re-seeded
      await store.delete(id);
    },
  };
}

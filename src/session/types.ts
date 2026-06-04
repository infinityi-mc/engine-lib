/**
 * Durable conversation state.
 *
 * A {@link SessionStore} is the pluggable persistence seam (an in-memory double
 * ships built-in); a {@link Session} is the per-conversation handle threaded into
 * a run. History is read before a run and appended after it. Only the *conversation*
 * (user input + produced assistant/tool messages) is persisted — the run-time
 * system/instruction and injected-context messages are rebuilt fresh every run and
 * are never stored.
 *
 * @module
 */

import type { Message } from "../messages/types";

/** Ordered, durable conversation state keyed by id. */
export interface SessionState {
  readonly id: string;
  readonly messages: readonly Message[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Pluggable persistence for session history.
 *
 * Implementations must preserve message order and treat {@link append} as an
 * atomic add to the tail. The built-in {@link InMemorySessionStore} is the
 * reference double; a `forge/data`-backed store can be layered on later behind
 * this same contract.
 */
export interface SessionStore {
  /** Load the full state for `id`, or `undefined` if none exists yet. */
  load(id: string): Promise<SessionState | undefined>;
  /** Append `messages` to the tail of `id`'s history (creating it if absent). */
  append(id: string, messages: readonly Message[]): Promise<void>;
  /** Replace the full state for `state.id`. */
  save(state: SessionState): Promise<void>;
  /** Remove all history for `id` (no-op if absent). */
  delete(id: string): Promise<void>;
}

/**
 * A per-conversation handle passed to `runAgent`.
 *
 * Created synchronously by {@link createSession}; history is resolved lazily
 * (on the first {@link Session.messages} call) so construction never blocks on I/O.
 */
export interface Session {
  readonly id: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Snapshot of the current ordered history. */
  messages(): Promise<Message[]>;
  /** Append messages to the conversation and persist them. */
  append(messages: readonly Message[]): Promise<void>;
  /** Drop all history for this session. */
  clear(): Promise<void>;
}

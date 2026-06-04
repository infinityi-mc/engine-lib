/**
 * In-memory {@link SessionStore} — the default, deterministic persistence double.
 *
 * Holds each session's history in a `Map`, copying message arrays on the way in
 * and out so callers cannot mutate stored state by reference. Suitable for tests
 * and ephemeral (single-process) runs; swap in a durable store for persistence
 * across restarts.
 *
 * @module
 */

import type { Message } from "../messages/types";
import type { SessionState, SessionStore } from "./types";

interface Entry {
  messages: Message[];
  metadata?: Record<string, unknown>;
}

/** A process-local {@link SessionStore} backed by a `Map`. */
export class InMemorySessionStore implements SessionStore {
  private readonly entries = new Map<string, Entry>();

  load(id: string): Promise<SessionState | undefined> {
    const entry = this.entries.get(id);
    if (entry === undefined) return Promise.resolve(undefined);
    const state: SessionState = {
      id,
      messages: [...entry.messages],
      ...(entry.metadata !== undefined ? { metadata: { ...entry.metadata } } : {}),
    };
    return Promise.resolve(state);
  }

  append(id: string, messages: readonly Message[]): Promise<void> {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      this.entries.set(id, { messages: [...messages] });
    } else {
      entry.messages.push(...messages);
    }
    return Promise.resolve();
  }

  save(state: SessionState): Promise<void> {
    this.entries.set(state.id, {
      messages: [...state.messages],
      ...(state.metadata !== undefined ? { metadata: { ...state.metadata } } : {}),
    });
    return Promise.resolve();
  }

  delete(id: string): Promise<void> {
    this.entries.delete(id);
    return Promise.resolve();
  }
}

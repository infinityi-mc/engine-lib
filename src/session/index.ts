/**
 * `@infinityi/engine-lib/session` — durable conversation state: the {@link SessionStore}
 * persistence contract, the built-in {@link InMemorySessionStore}, and the
 * {@link createSession} handle threaded into a run.
 *
 * @module
 */

export { createSession } from "./session";
export type { CreateSessionOptions } from "./session";

export { InMemorySessionStore } from "./store";

export type { Session, SessionState, SessionStore } from "./types";

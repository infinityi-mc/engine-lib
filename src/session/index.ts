/**
 * `@infinityi/engine-lib/session` — durable conversation state: the {@link SessionStore}
 * persistence contract, the built-in {@link InMemorySessionStore}, and the
 * {@link createSession} handle threaded into a run.
 *
 * @module
 */

export { createSession } from "./session";
export type { CreateSessionOptions } from "./session";

export {
  RESUME_METADATA_KEY,
  RESUME_SCHEMA_VERSION,
  readResumeInfo,
  withResumeInfo,
} from "./resume";
export { InMemorySessionStore } from "./store";

export type {
  AppendResult,
  Session,
  SessionListItem,
  SessionListOptions,
  SessionListOrder,
  SessionListPage,
  SessionModelIdentity,
  SessionResumeInfo,
  SessionRunStatus,
  SessionState,
  SessionStore,
  SessionUsage,
} from "./types";

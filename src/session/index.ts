/**
 * `@infinityi/engine-lib/session` — durable conversation state: the {@link SessionStore}
 * persistence contract, the built-in {@link InMemorySessionStore}, and the
 * {@link createSession} handle threaded into a run.
 *
 * @module
 */

export { createSession } from "./session";
export type { CreateSessionOptions } from "./session";

export { forkSession, snapForkIndex } from "./fork";

export {
  RESUME_METADATA_KEY,
  RESUME_SCHEMA_VERSION,
  readResumeInfo,
  withResumeInfo,
} from "./resume";
export {
  activeToolNames,
  assertAgentResumeCompatible,
  compareAgentResume,
} from "./agent-compat";
export { InMemorySessionStore } from "./store";

export type {
  AppendResult,
  ForkOptions,
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
  SessionTenantClaim,
  SessionUsage,
} from "./types";

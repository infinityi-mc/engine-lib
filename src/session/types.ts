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
import type { Usage } from "../providers/types";
import type { SessionResumeInfo } from "./resume";

/** Outcome returned by {@link SessionStore.append}. */
export interface AppendResult {
  /** True when the append triggered persisted session compaction. */
  readonly compacted?: boolean;
  /** Number of messages removed from the live history by compaction. */
  readonly removed?: number;
  /** True when compaction added or replaced a persisted summary message. */
  readonly summaryAdded?: boolean;
}

/** Ordered, durable conversation state keyed by id. */
export interface SessionState {
  readonly id: string;
  readonly messages: readonly Message[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Optimistic concurrency stamp reserved for CAS-capable stores. Absent rows read as 0. */
  readonly version?: number;
  /** Optional tenant owner. Absent means a global/unscoped session. */
  readonly tenantId?: string;
}

/** First-use ownership claim for a tenant-bound session. */
export interface SessionTenantClaim {
  readonly id: string;
  readonly tenantId: string;
  readonly messages?: readonly Message[];
  readonly metadata?: Record<string, unknown>;
}

/** Ordering supported by {@link SessionStore.list}. */
export type SessionListOrder = "recent" | "id";

/** Page through stored sessions. Cursors are opaque store-owned strings. */
export interface SessionListOptions {
  /** Return only session ids beginning with this prefix. */
  readonly prefix?: string;
  /** Maximum number of sessions to return. Defaults to a store-defined page size. */
  readonly limit?: number;
  /** Opaque cursor returned by a previous list call. */
  readonly cursor?: string;
  /** Sort order. Defaults to "recent" when the store tracks timestamps, else "id". */
  readonly order?: SessionListOrder;
  /** Return only sessions owned by this tenant. Omitted lists global and tenant-bound sessions. */
  readonly tenantId?: string;
}

/** A lightweight listing entry for a stored session. */
export interface SessionListItem {
  readonly id: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly messageCount?: number;
  readonly resume?: SessionResumeInfo;
  readonly version?: number;
  readonly tenantId?: string;
}

/** One page of session listings. */
export interface SessionListPage {
  readonly sessions: readonly SessionListItem[];
  readonly cursor?: string;
}

/** Durable resume metadata written under the reserved metadata key. */
export type { SessionResumeInfo } from "./resume";

/**
 * Pluggable persistence for session history.
 *
 * Implementations must preserve message order, treat {@link append} as an
 * atomic add to the tail, and return snapshots that callers cannot mutate to
 * alter stored history by reference. The built-in {@link InMemorySessionStore}
 * is the reference double; a `forge/data`-backed store can be layered on later
 * behind this same contract.
 */
export interface SessionStore {
  /** Load the full state for `id`, or `undefined` if none exists yet. */
  load(id: string): Promise<SessionState | undefined>;
  /** Append `messages` to the tail of `id`'s history (creating it if absent). */
  append(id: string, messages: readonly Message[]): Promise<AppendResult>;
  /** Replace the metadata object for `id` (creating an empty session if absent). */
  setMetadata(id: string, metadata: Record<string, unknown>): Promise<void>;
  /** Enumerate stored sessions. */
  list(options?: SessionListOptions): Promise<SessionListPage>;
  /** Replace the full state for `state.id`. */
  save(state: SessionState): Promise<void>;
  /**
   * Atomically bind a session id to `tenantId`, optionally applying first-use
   * seed messages and metadata. Returns true when persisted state changed and
   * rejects when an existing tenant owner differs.
   */
  claimTenant(claim: SessionTenantClaim): Promise<boolean>;
  /** Remove all history for `id` (no-op if absent). */
  delete(id: string): Promise<void>;
}

/**
 * A per-conversation handle passed to `runAgent`.
 *
 * Created synchronously by {@link createSession}; history is resolved lazily
 * (on the first {@link Session.messages}, {@link Session.append}, or
 * {@link Session.clear} call) so construction never blocks on I/O.
 */
export interface Session {
  readonly id: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Optional tenant owner. Absent means global/unscoped. */
  readonly tenantId?: string;
  /** Expected model used as the model-compatibility baseline for resumes. */
  readonly expectedModel?: string;
  /** Expected provider used as the provider-compatibility baseline for resumes. */
  readonly expectedProvider?: string;
  /** Snapshot of the current ordered history. */
  messages(): Promise<Message[]>;
  /** Append messages to the conversation and persist them. */
  append(messages: readonly Message[]): Promise<AppendResult>;
  /** Replace the stored metadata object for this session. */
  setMetadata(metadata: Record<string, unknown>): Promise<void>;
  /** Read the stored metadata object for this session, if any. */
  getMetadata(): Promise<Record<string, unknown> | undefined>;
  /** Drop all history for this session. */
  clear(): Promise<void>;
}

/** Current status stored in {@link SessionResumeInfo}. */
export type SessionRunStatus = "completed" | "failed" | "interrupted";

/** Utility shape for model compatibility diagnostics. */
export interface SessionModelIdentity {
  readonly model?: string;
  readonly provider?: string;
}

/** Cumulative token usage stored in resume metadata. */
export type SessionUsage = Usage;

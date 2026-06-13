# Session Resume Hardening — Specification

| Field | Value |
| --- | --- |
| Status | Accepted |
| Author(s) | (engine-lib maintainers) |
| Reviewers | infinityi-mc (us.cuong26092@gmail.com) |
| Last updated | 2026-06-14 |
| Spec type | Module / subsystem |
| Related | `.claude/reports/session-hardening.md` (source analysis); Phase 5 (sessions/context), Phase 6 (events/telemetry); `@infinityi/forge` |

## 1. Summary

This spec hardens engine-lib's **resume-a-session** use case by closing the nine
gaps identified in the session-hardening report. It introduces a **SessionStore
v2 contract** (session listing/discovery, metadata mutation, append outcomes),
**well-known resume metadata**, **mid-run checkpointing with safe re-entry** so
an interrupted run is not lost or dangerously replayed, a **conversation-aware
context-window strategy**, **session expiry/TTL**, a **persisting summarizing
compactor**, **model-compatibility checks on resume**, and **session-lifecycle
events** on the existing run event stream. SessionStore v2 is a deliberate
breaking change shipped as a major version (`2.0.0`); existing custom stores
must implement the new methods.

## 2. Background & Motivation

The most common consumer scenario for engine-lib is resuming a conversation by
id: `createSession({ id, store })` re-reads history lazily on first access and
`runAgent` continues it (see `src/session/session.ts`, `src/execution/run.ts`).
The analysis in `.claude/reports/session-hardening.md` found that this path is
ergonomic but missing operational primitives that every consumer ends up
rebuilding:

1. **No session listing/discovery** — `SessionStore` (`src/session/types.ts`)
   has `load/append/save/delete` only; a resume UI cannot enumerate sessions.
2. **No structured resume metadata** — `SessionState.metadata` is free-form;
   there is no convention for agent name, model, last status, or timestamps.
3. **No mid-run crash recovery** — `runAgent` appends to the session only on
   success (`src/execution/run.ts:365`); a crash mid-loop loses all progress.
4. **No run resumption** — even with persisted partial state, the loop always
   starts fresh and may re-execute side-effectful tools.
5. **Context trimming is structure-blind** — `truncateOldest`
   (`src/context/window.ts:74`) drops from the front and can split a
   `tool_call` from its `tool_result`, producing an invalid request.
6. **No expiry/TTL** — stores keep history forever; Redis TTL is unused, SQL has
   no idle cleanup.
7. **Summaries are ephemeral** — `summarizeOldest` builds a request-view summary
   that is never persisted, so every resume re-summarizes.
8. **No model-compatibility check** — resuming under a different provider/model
   is silent.
9. **No session-lifecycle observability** — the event stream
   (`src/execution/types.ts`) has no `session.resumed` / `compacted` /
   `expired` signals.

These are addressed together because they share contracts (the store interface,
session metadata, the run loop, the event union) and a single coordinated major
release is cleaner than nine incremental ones.

## 3. Goals

- Let consumers **enumerate and triage** persisted sessions through the store
  abstraction (no backend-specific queries).
- Provide a **standard, typed resume record** (agent, model, status, timestamps,
  cumulative usage) written automatically by `runAgent`.
- **Never silently lose work**: a run interrupted mid-loop must be recoverable,
  and resuming it must not re-execute already-completed, side-effectful tools.
- Keep every provider request **conversationally valid** under trimming
  (tool-call/result pairs intact; pinned messages retained).
- Bound storage growth via **TTL/idle expiry** and **persisted compaction**.
- Surface **resume/compaction/expiry** on the existing observability stream.
- Warn (or fail, by policy) when a session resumes under an **incompatible
  model/provider**.

## 4. Non-goals

- Building a RAG/memory engine or changing the provider-neutral message model
  (`src/messages/types.ts`).
- Cross-process run coordination / distributed locking (only single-writer
  correctness is in scope; see Open Question 1).
- Automatic background expiry daemons/schedulers — engine-lib exposes
  `purgeExpired()` and native-TTL hooks; *scheduling* is the host's job.
- Encrypting metadata differently from messages — the existing
  `SessionStoreCodec` (`src/session-stores/types.ts`) already covers metadata.
- A new event-delivery channel — lifecycle events reuse the `RunEvent` union and
  the existing `EventHub` (per design decision).

## 5. Requirements

RFC 2119 keywords (MUST / MUST NOT / SHOULD / SHOULD NOT / MAY) are normative.

### 5.1 Functional requirements

#### Session listing & discovery (report §1)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-1.1 | The `SessionStore` contract MUST define a required `list(options?: SessionListOptions): Promise<SessionListPage>` method that enumerates session ids the store holds. | Must |
| FR-1.2 | `list()` MUST support `prefix` filtering, a `limit` (page size), and an opaque `cursor` for pagination; when `limit` is omitted a store-defined default (RECOMMENDED 100) MUST be applied. | Must |
| FR-1.3 | `list()` MUST return, per session, at least `{ id }`, and SHOULD include `createdAt`, `updatedAt`, `messageCount`, and decoded `resume` info when the backend can supply them cheaply. Absent fields MUST be omitted, not faked. | Must |
| FR-1.4 | `list()` MUST support ordering by `"recent"` (most-recent `updatedAt` first) and `"id"` (lexicographic); default MUST be `"recent"` where `updatedAt` is tracked, else `"id"`. | Should |
| FR-1.5 | All five built-in stores (InMemory, Redis, Forge SQL/SQLite/Postgres, Filesystem JSONL) MUST implement `list()`. A store whose backend cannot enumerate keys efficiently MUST still implement it correctly (e.g. Redis via `SCAN`), and MUST NOT use `KEYS` in production paths. | Must |

#### Structured resume metadata (report §2)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-2.1 | The library MUST define a typed `SessionResumeInfo` record and a reserved metadata key `RESUME_METADATA_KEY = "engine:resume"` under which it is stored inside `SessionState.metadata`. | Must |
| FR-2.2 | `runAgent`, when given a `session`, MUST write/update the resume record after each run: on success with `lastRunStatus: "completed"`, on failure with `"failed"`, and (when checkpointing is on) `"interrupted"` while in flight. | Must |
| FR-2.3 | The resume record MUST capture `agentName`, the resolved `model`, the `provider` name, `lastActiveAt` (ISO-8601), `lastRunStatus`, cumulative `totalUsage`, and a `schemaVersion`. | Must |
| FR-2.4 | The library MUST export pure helpers `readResumeInfo(state | metadata): SessionResumeInfo \| undefined` and `withResumeInfo(metadata, info): Record<string, unknown>` so hosts read/merge it without string-keying. | Must |
| FR-2.5 | Writing the resume record MUST NOT clobber unrelated host metadata keys (merge, not replace). | Must |

#### Mid-run crash recovery / checkpointing (report §3)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-3.1 | `RunOptions` MUST accept an optional `checkpoint?: CheckpointPolicy`. When `checkpoint.mode === "step"` and a `session` is set, `runAgent` MUST persist the messages produced by each completed step (assistant turn + that step's tool results) incrementally, before the next provider call. | Must |
| FR-3.2 | In `"step"` mode `runAgent` MUST mark the session resume record `lastRunStatus: "interrupted"` once the first step is persisted and flip it to `"completed"`/`"failed"` at terminal state, so a crash leaves a detectable `"interrupted"` marker. | Must |
| FR-3.3 | In `"step"` mode `runAgent` MUST NOT append the same messages twice (incremental appends replace the single final append; the returned `RunResult.messages` is unaffected). | Must |
| FR-3.4 | `CheckpointPolicy` MUST support an `onCheckpoint(checkpoint: RunCheckpoint)` callback invoked after each step regardless of whether a `session` is set, enabling host-owned persistence. A throwing/rejecting `onCheckpoint` MUST fail the run with the original error wrapped as `ExecutionError` (checkpoint loss is not silently swallowed). | Must |
| FR-3.5 | Default behavior (no `checkpoint`) MUST remain identical to today: a single append on successful completion only. | Must |

#### Run resumption / safe re-entry (report §4)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-4.1 | On a run whose loaded `session` history ends with an assistant message containing `tool_call` parts that have **no** matching `tool_result` (a "dangling" interrupted turn), and where `opts.resume !== false`, `runAgent` MUST reconcile those dangling calls before issuing the next provider call so the request is conversationally valid. | Must |
| FR-4.2 | Reconciliation strategy MUST be selectable via `ResumeOptions.danglingToolCalls`: `"synthesize-error"` (default — inject an error `tool_result` per dangling call noting the prior run was interrupted), `"reexecute"` (re-dispatch the tool), or `"drop"` (remove the dangling assistant turn). The default MUST NOT re-execute tools. | Must |
| FR-4.3 | When resuming, `runAgent` MUST continue the existing loop (the model decides next action) rather than requiring the consumer to re-submit the original input; new `input`, when provided, MUST be appended after reconciliation. | Must |
| FR-4.4 | A reconciled resume MUST emit exactly one `session.resumed` event (FR-9.1) reporting the reconciled-call count. | Must |
| FR-4.5 | If `opts.resume === false`, `runAgent` MUST ignore any interrupted marker and behave as a fresh run over the loaded history. | Should |

#### Structure-aware context trimming (report §5)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-5.1 | The library MUST provide a `truncateToolAware(opts?)` `ContextStrategy` that drops whole oldest **turns** and never separates a `tool_call` from its corresponding `tool_result`(s). | Must |
| FR-5.2 | `truncateToolAware` MUST always retain `system` messages and MUST retain any message for which a supplied `pin(message, index)` predicate returns `true` (or whose `metadata.pinned === true`). | Must |
| FR-5.3 | `summarizeOldest` MUST be made structure-aware: it MUST split older/recent at a **turn boundary** (never mid tool-call/result pair) and its summarization prompt MUST instruct preservation of decisions, open questions, and any in-flight tool intent. | Must |
| FR-5.4 | When the irreducible set (system + pinned + the minimum valid trailing turn) still exceeds `maxTokens`, both strategies MUST throw `ContextWindowError` with `{ tokens, limit }` (unchanged contract). | Must |
| FR-5.5 | All strategies MUST continue to operate on a request view only and MUST NOT mutate the canonical/persisted history (unchanged invariant from `src/context/window.ts`). | Must |

#### Session expiry / TTL (report §6)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-6.1 | The library MUST define an optional capability interface `ExpiringSessionStore extends SessionStore` with `setExpiry(id, ttlMs)` and `purgeExpired(options?): Promise<string[]>` (returns purged ids), plus a `isExpiringSessionStore(store)` type guard mirroring `isVersionedSessionStore`. | Must |
| FR-6.2 | `RedisSessionStore` MUST implement `ExpiringSessionStore`: `setExpiry` MUST apply native `PEXPIRE` to all keys for the id; `purgeExpired` MAY be a no-op (Redis auto-evicts) and MUST document that. | Must |
| FR-6.3 | `ForgeDataSessionStore` MUST implement `ExpiringSessionStore` using the existing `updated_at` column (already written on append/save) plus a new nullable `expires_at` column; `purgeExpired({ maxIdleMs })` MUST delete sessions whose `updated_at`/`expires_at` is past the computed cutoff, in a single transactional statement. | Must |
| FR-6.4 | `FilesystemJsonlSessionStore` and `InMemorySessionStore` MUST implement `ExpiringSessionStore` using tracked last-write timestamps; JSONL `purgeExpired` MUST remove whole session files. | Should |
| FR-6.5 | Expiry MUST be opt-in: no store may delete data unless `setExpiry`/`purgeExpired` is called by the host. The library MUST NOT start any background timer. | Must |

#### Persisted session summaries (report §7)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-7.1 | The library MUST provide a `summarizingCompactor(opts)` implementing the existing `SessionCompactor` contract (`src/session-stores/types.ts`) that compresses older turns into a single persisted `system` summary message and returns a `SessionCompactionResult` whose `archive` carries the removed messages. | Must |
| FR-7.2 | `summarizingCompactor` MUST keep the most recent `keepRecentTurns` (default RECOMMENDED 6) turns verbatim and MUST split at a turn boundary (FR-5.3 alignment). | Must |
| FR-7.3 | `summarizingCompactor.shouldCompact` MUST gate on a configurable threshold (`messages` count and/or estimated `tokens`); below threshold it MUST return `false` (no provider call). | Must |
| FR-7.4 | Compaction MUST be wired through the existing `withSessionStoreHooks` decorator (no new decorator), and MUST be idempotent enough that a re-compaction over an already-summarized history does not stack duplicate summaries. | Should |
| FR-7.5 | A persisted summary message MUST be tagged (`metadata.pinned === true`) so structure-aware trimming (FR-5.2) never drops it. | Should |

#### Session-model compatibility (report §8)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-8.1 | When a session is resumed and its resume record records a `model`/`provider` differing from the run's resolved `model`/`provider`, `runAgent` MUST apply the `RunOptions.modelCompatibility` policy: `"warn"` (default — log + emit), `"error"` (throw `SessionModelMismatchError`), or `"ignore"`. | Must |
| FR-8.2 | `"warn"` MUST log via the run logger and emit a `custom` event `{ name: "session.model_mismatch", data: { expected, actual } }`; it MUST NOT alter execution. | Must |
| FR-8.3 | `createSession` MAY accept `expectedModel`/`expectedProvider`; when set they take precedence over the recorded resume record as the comparison baseline. | May |
| FR-8.4 | The library MUST export a new `SessionModelMismatchError extends AgentError` carrying `{ expected, actual }`. | Must |

#### Session-lifecycle events (report §9)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-9.1 | The `RunEvent` union MUST gain `session.resumed`, `session.compacted`, and `session.expired` variants, delivered through the existing `onEvent`/`subscribers`/`EventHub` path. | Must |
| FR-9.2 | `runAgent` MUST emit `session.resumed` once, after a resumed session is loaded and reconciled, before the first provider call. | Must |
| FR-9.3 | `runAgent` MUST emit `session.compacted` when an append it performed triggered compaction (detected via the new `AppendResult`, FR-10.3). | Must |
| FR-9.4 | `purgeExpired()` MUST report each purged session as a `session.expired` event shape via an optional `onEvent` callback in its options (there is no run/hub during background purge); `runAgent` MUST also emit `session.expired` if it detects an expired session at load time under lazy-expiry. | Should |

#### Store contract v2 (cross-cutting, breaking)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-10.1 | `SessionStore` MUST gain a required `setMetadata(id, metadata: Record<string, unknown>): Promise<void>` that replaces the stored metadata object for `id` (caller merges). This enables resume-record updates without rewriting message history. | Must |
| FR-10.2 | The `Session` handle MUST gain `setMetadata(metadata)`, `getMetadata(): Promise<Record<string, unknown> \| undefined>`, in addition to existing `messages/append/clear`. | Must |
| FR-10.3 | `SessionStore.append` and `Session.append` MUST return `Promise<AppendResult>` (currently `Promise<void>`), where `AppendResult` optionally reports `{ compacted, removed, summaryAdded }`. The `withSessionStoreHooks` decorator MUST populate it when its compactor runs. | Must |
| FR-10.4 | The release MUST be versioned `2.0.0`; the contract change MUST be documented in a migration note (§9) and all built-in stores updated in lockstep. | Must |

### 5.2 Non-functional requirements

| ID | Category | Requirement |
| --- | --- | --- |
| NFR-1 | Performance | `list({ limit: n })` MUST be O(n) in returned rows, not O(total sessions): Redis MUST use cursor-based `SCAN`, SQL MUST use indexed `ORDER BY updated_at LIMIT n OFFSET/keyset`. A single `list` page MUST add ≤ 1 round-trip beyond the backend's native paging primitive. |
| NFR-2 | Performance | Checkpoint `"step"` mode MUST add at most one store `append` (+ one `setMetadata` on the first step only, or on status change) per provider step; it MUST NOT re-serialize prior messages. |
| NFR-3 | Reliability | Incremental append + resume MUST be crash-consistent: after a crash at any step boundary, `load()` MUST return a valid conversation (no half-written message, no `tool_call` lost relative to its persisted `tool_result`). The JSONL append-only and SQL transactional designs already provide this; the spec MUST NOT weaken it. |
| NFR-4 | Reliability | `purgeExpired` MUST be safe to call concurrently with `append`/`load`; an in-flight append to a session being purged MUST NOT corrupt the store (last-writer-wins on the id; partial rows MUST NOT survive). |
| NFR-5 | Security/Privacy | Resume metadata and persisted summaries MUST pass through the configured `SessionStoreCodec` exactly like messages, so encryption-at-rest still yields no plaintext on disk. `totalUsage` and `model` names are not secrets but MUST NOT include API keys or prompt content beyond the model-generated summary. |
| NFR-6 | Observability | Every new event MUST carry `sessionId` and be emitted through the same isolated `EventHub` path (a throwing subscriber MUST NOT abort the run), consistent with `src/events/hub.ts`. |
| NFR-7 | Compatibility | The provider-neutral message model MUST be unchanged. Strategy/compactor/store additions MUST be tree-shakeable from their existing subpaths (`/context`, `/session-stores`). |
| NFR-8 | Testing | All built-in stores MUST pass a new shared **store conformance battery** (modeled on the provider battery in `src/testing/conformance.ts`) covering v2 methods. |

### 5.3 Constraints & assumptions

- **Runtime**: TypeScript on Bun; tests use `bun:test` (see `tests/`). No new
  runtime deps beyond `@infinityi/forge` (already used).
- **Single-writer assumption**: correctness guarantees assume at most one writer
  per session id at a time (consistent with current stores). Cross-writer
  locking is out of scope (Open Question 1).
- **Redis client**: the structural client interface
  (`RedisSessionStoreClient`, `src/session-stores/redis.ts`) MUST be extended
  with optional `scan`/`pExpire` members; clients lacking them cause the
  corresponding capability to throw a clear, documented error (not silently
  no-op).
- **Assumption**: hosts that need expiry will call `purgeExpired` on their own
  schedule (cron, queue). Acceptable to be wrong about — if hosts want built-in
  scheduling, that becomes a follow-up, not a redesign.

## 6. Design / Proposed solution

### 6.1 Overview

```
                       ┌──────────────────────────────────────────┐
   createSession ─────▶│ Session handle (v2)                       │
                       │  messages / append→AppendResult           │
                       │  setMetadata / getMetadata / clear        │
                       └───────────────┬──────────────────────────┘
                                       │ SessionStore v2
        ┌──────────────────────────────┴───────────────────────────┐
        │ load · append→AppendResult · save · delete                │
        │ list(opts)→SessionListPage · setMetadata                  │   (+ ExpiringSessionStore capability)
        └──────────────────────────────┬───────────────────────────┘
                                        │
       ┌────────────┬───────────┬───────┴───────┬──────────────┬─────────────┐
   InMemory      Redis     ForgeData(SQL)   JSONL      withSessionStoreHooks(summarizingCompactor)
                                                                  │ AppendResult.compacted

   runAgent loop ── reads resume record ─▶ reconcile dangling tool_calls ─▶ emit session.resumed
                ── per step (checkpoint:"step") ─▶ append delta + setMetadata(interrupted)
                ── on finish ─▶ setMetadata(completed) · emit session.compacted (if AppendResult.compacted)
                ── applyContextWindow(truncateToolAware | summarizeOldest)  (request view only)
```

The change spans four seams that already exist:
`SessionStore`/`Session` (`src/session/`), the run loop (`src/execution/run.ts`),
context strategies (`src/context/window.ts`), and the `RunEvent` union
(`src/execution/types.ts`). No new module directory is required; new store
capabilities live in `src/session-stores/`.

### 6.2 Public interface / API contract

#### Store contract (`src/session/types.ts`)

```ts
export interface AppendResult {
  /** True when the store decorator compacted this session during the append. */
  readonly compacted?: boolean;
  /** Messages removed by compaction (when known). */
  readonly removed?: number;
  /** True when compaction added/refreshed a persisted summary message. */
  readonly summaryAdded?: boolean;
}

export interface SessionListOptions {
  readonly prefix?: string;
  readonly limit?: number;            // default 100
  readonly cursor?: string;           // opaque; from a prior page
  readonly order?: "recent" | "id";   // default "recent" when updatedAt tracked
}

export interface SessionListing {
  readonly id: string;
  readonly createdAt?: string;        // ISO-8601
  readonly updatedAt?: string;        // ISO-8601
  readonly messageCount?: number;
  readonly resume?: SessionResumeInfo;
}

export interface SessionListPage {
  readonly sessions: readonly SessionListing[];
  /** Present when more pages remain; pass back as options.cursor. */
  readonly cursor?: string;
}

export interface SessionStore {
  load(id: string): Promise<SessionState | undefined>;
  append(id: string, messages: readonly Message[]): Promise<AppendResult>; // was Promise<void>
  save(state: SessionState): Promise<void>;
  delete(id: string): Promise<void>;
  list(options?: SessionListOptions): Promise<SessionListPage>;            // NEW (required)
  setMetadata(id: string, metadata: Record<string, unknown>): Promise<void>; // NEW (required)
}

export interface ExpiringSessionStore extends SessionStore {
  /** Apply a TTL to the session id (native where supported). */
  setExpiry(id: string, ttlMs: number): Promise<void>;
  /** Delete sessions past their TTL or idle beyond maxIdleMs. Returns purged ids. */
  purgeExpired(options?: {
    readonly maxIdleMs?: number;
    readonly now?: string;                 // ISO-8601, for deterministic tests
    readonly onEvent?: (event: Extract<RunEvent, { type: "session.expired" }>) => void;
  }): Promise<string[]>;
}

export function isExpiringSessionStore(s: SessionStore): s is ExpiringSessionStore;
```

#### Resume metadata (`src/session/resume.ts` — new)

```ts
export const RESUME_METADATA_KEY = "engine:resume" as const;
export const RESUME_SCHEMA_VERSION = 1 as const;

export interface SessionResumeInfo {
  readonly schemaVersion: number;
  readonly agentName: string;
  readonly model?: string;
  readonly provider?: string;
  readonly lastActiveAt: string;          // ISO-8601
  readonly lastRunStatus: "completed" | "failed" | "interrupted";
  readonly totalUsage?: Usage;
}

export function readResumeInfo(
  source: SessionState | Record<string, unknown> | undefined,
): SessionResumeInfo | undefined;

export function withResumeInfo(
  metadata: Record<string, unknown> | undefined,
  info: SessionResumeInfo,
): Record<string, unknown>;               // merge under RESUME_METADATA_KEY
```

#### Session handle (`src/session/types.ts`)

```ts
export interface Session {
  readonly id: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  messages(): Promise<Message[]>;
  append(messages: readonly Message[]): Promise<AppendResult>;   // was Promise<void>
  setMetadata(metadata: Record<string, unknown>): Promise<void>; // NEW
  getMetadata(): Promise<Record<string, unknown> | undefined>;   // NEW
  clear(): Promise<void>;
}
```

#### Run options (`src/execution/types.ts`)

```ts
export interface CheckpointPolicy {
  readonly mode?: "step" | "off";                                // default "off"
  onCheckpoint?(checkpoint: RunCheckpoint): void | Promise<void>;
}

export interface RunCheckpoint {
  readonly sessionId?: string;
  readonly agent: string;
  readonly step: number;
  readonly newMessages: readonly Message[];   // produced by this run so far
  readonly pending: readonly ToolCallPart[];  // tool calls awaiting results
  readonly status: "running";
}

export interface ResumeOptions {
  readonly danglingToolCalls?: "synthesize-error" | "reexecute" | "drop"; // default "synthesize-error"
}

export interface RunOptions {
  // …existing fields…
  readonly checkpoint?: CheckpointPolicy;
  readonly resume?: ResumeOptions | boolean;                    // default true (auto-detect)
  readonly modelCompatibility?: "warn" | "error" | "ignore";   // default "warn"
}
```

#### New RunEvent variants (`src/execution/types.ts`)

```ts
| { readonly type: "session.resumed"; readonly sessionId: string;
    readonly messageCount: number; readonly reconciledToolCalls: number;
    readonly resume?: SessionResumeInfo }
| { readonly type: "session.compacted"; readonly sessionId: string;
    readonly removed: number; readonly summaryAdded: boolean }
| { readonly type: "session.expired"; readonly sessionId: string;
    readonly reason: "ttl" | "idle" | "purged" }
```

#### Context strategy (`src/context/window.ts`)

```ts
export function truncateToolAware(opts?: {
  pin?: (message: Message, index: number) => boolean;
}): ContextStrategy;   // name: "truncate-tool-aware"
```

#### Summarizing compactor (`src/session-stores/`)

```ts
export function summarizingCompactor(opts: {
  readonly provider: Provider;
  readonly model: string;
  readonly keepRecentTurns?: number;                           // default 6
  readonly shouldCompactAt?: { messages?: number; tokens?: number };
  readonly countTokens?: TokenCounter;
}): SessionCompactor;
```

#### Error (`src/errors.ts`)

```ts
export class SessionModelMismatchError extends AgentError {
  readonly expected: { model?: string; provider?: string };
  readonly actual: { model?: string; provider?: string };
}
```

### 6.3 Data model

- **SessionState.metadata** gains a reserved key `engine:resume` →
  `SessionResumeInfo`. Free-form host keys are preserved alongside it.
- **Persisted summary** is a `system` message with
  `metadata = { pinned: true, "engine:summary": true }`, stored in the normal
  message stream so existing `load()` returns it transparently.
- **Forge SQL schema** (`src/session-stores/forge-data.ts` `migrate()`): add a
  nullable `expires_at TEXT` column to `<prefix>_sessions` and an index
  `(updated_at)` to support `list(order:"recent")` and `purgeExpired`.
  Migration MUST be `create table if not exists` + `alter table add column if
  not exists`-equivalent (guarded), bumping `SESSION_STORE_SCHEMA_VERSION`.
- **Redis**: per-id keys (`:messages`, `:metadata`, `:exists`) gain optional TTL
  via `PEXPIRE`; `list` uses `SCAN MATCH <prefix>:*:exists`.
- **JSONL**: a new record `op: "expiry"` (carrying `expiresAt`) MAY be appended;
  `updatedAt` derived from the last record's `at`.

### 6.4 Behavior & control flow

**Resume + reconcile (FR-4):**

| Given | When | Then |
| --- | --- | --- |
| Session whose last persisted message is an assistant turn with one unmatched `tool_call`, resume record `interrupted` | `runAgent({ session })` (default `resume`) | runAgent injects a synthesized error `tool_result` for the dangling call, emits `session.resumed { reconciledToolCalls: 1 }`, then enters the loop; no prior tool is re-run |
| Same, `resume.danglingToolCalls: "reexecute"` | run | the dangling tool is re-dispatched with its original arguments |
| Same, `resume.danglingToolCalls: "drop"` | run | the trailing assistant turn is removed from the request view; loop proceeds |
| Same, `resume: false` | run | interrupted marker ignored; treated as a normal (possibly invalid-pair) history per legacy behavior |

**Checkpoint step mode (FR-3):**

```
for each step:
  call provider → assistant turn
  if checkpoint.mode == "step" && session:
     append([assistant turn])              // AppendResult captured for compaction event
     if first persisted step: setMetadata(withResumeInfo(meta, {status:"interrupted",...}))
  dispatch tools → tool_result messages
  if checkpoint.mode == "step" && session: append(tool_results)
  await onCheckpoint?(...)                  // throwing → run fails (FR-3.4)
on terminal:
  if checkpoint.mode != "step": append(newMessages)   // legacy single append
  setMetadata(withResumeInfo(meta, {status: completed|failed, totalUsage,...}))
```

**Model compatibility (FR-8):** baseline = `expectedModel/Provider` (if set on
`createSession`) else recorded resume record. Compare to resolved run model.
`warn` → log + `custom` event; `error` → throw `SessionModelMismatchError`
before the first provider call; `ignore` → nothing.

### 6.5 Error handling & edge cases

| Condition | Handling | Observable result |
| --- | --- | --- |
| `list()` on a store whose backend cannot page (no `scan`) | Reject | Thrown `Error` with a clear "client must implement scan" message (mirrors existing `lRange`/`rPush` guards) |
| `cursor` from a different store/prefix | Reject | `Error("invalid list cursor")`; MUST NOT return arbitrary rows |
| Dangling tool_call with `reexecute` but tool no longer registered | Per-call isolation | Synthesized `tool_result { ok:false, error:"unknown tool" }` (same as live path); loop continues |
| `onCheckpoint` throws/rejects | Propagate | Run fails; `error` event with `ExecutionError` wrapping the cause (FR-3.4) |
| Crash between append(assistant) and append(tool_results) | Recovered on resume | `load()` returns assistant turn with dangling call → reconciled per FR-4 |
| `setMetadata` on absent id | Create-or-set | Metadata stored; empty message history; `load()` returns state with metadata, `messages: []` |
| Compaction during a non-checkpoint run | Detected via final-append `AppendResult` | `session.compacted` emitted once if `compacted === true` |
| `summarizeOldest`/`truncateToolAware` cannot fit even one trailing turn + pins | Reject | `ContextWindowError { tokens, limit }` |
| Resume record present but `schemaVersion` newer than runtime supports | Degrade | Treat as absent for typed reads; log a warning; do not crash |
| `purgeExpired` concurrent with `append` to same id | Serialize per store rules | No partial rows; last-writer-wins (NFR-4) |
| Model mismatch with policy `error` | Reject pre-flight | `SessionModelMismatchError`; no provider call made |

### 6.6 Security & privacy

- Resume metadata and summaries flow through the existing `SessionStoreCodec`
  (NFR-5), so encryption-at-rest deployments stay plaintext-free on disk.
- No new external egress except the summarization provider call, which already
  exists for `summarizeOldest`; `summarizingCompactor` sends only conversation
  content the host already persists.
- `list()` exposes session ids and resume metadata; it is a same-trust-boundary
  store operation (no new authz surface). Hosts that multi-tenant a single store
  MUST continue to namespace ids via `prefix` (documented).
- No secrets are added to metadata; `Secret` values (`src/runtime/secret.ts`)
  MUST NOT be written into resume records.

### 6.7 Observability

- Three new `RunEvent`s (FR-9) on the existing stream; they appear in
  `loggingSubscriber`/`messageBusSubscriber` output automatically.
- Telemetry (`src/events/telemetry.ts`): the run span SHOULD gain attributes
  `session.resumed` (bool), `session.reconciled_tool_calls` (int), and
  `session.compacted` (bool) when applicable. No new span types required.
- `purgeExpired` returns purged ids and (optionally) emits `session.expired`
  per id for host-side metrics.

## 7. Acceptance criteria

- **AC-1 (FR-1.1–1.5):** Given a store with sessions `a`, `b`, `c`, when
  `list({ limit: 2, order: "recent" })` is called, then exactly 2 listings are
  returned most-recent first with a `cursor`, and a follow-up `list({ cursor })`
  returns the remainder; verified for all five built-in stores.
- **AC-2 (FR-2.2–2.4):** Given a completed `runAgent({ session })`, when
  `readResumeInfo(await store.load(id))` is read, then it returns
  `{ agentName, model, provider, lastRunStatus: "completed", totalUsage }` with
  `lastActiveAt` set, and pre-existing host metadata keys are still present.
- **AC-3 (FR-3.1–3.3):** Given `checkpoint: { mode: "step" }`, when a run is
  aborted (simulated crash) after step 2 of 4, then `store.load(id)` returns the
  messages from steps 1–2 and a resume record `lastRunStatus: "interrupted"`;
  and a normal completed step-mode run yields the same final `messages` as the
  non-checkpoint path with no duplicate messages.
- **AC-4 (FR-3.4):** Given an `onCheckpoint` that rejects, when a run reaches the
  first checkpoint, then the run rejects with an `ExecutionError` whose cause is
  the thrown error and an `error` event was emitted.
- **AC-5 (FR-4.1–4.4):** Given a persisted history ending in an assistant turn
  with one unmatched `tool_call` and an `interrupted` marker, when
  `runAgent({ session })` runs with default resume, then a synthesized error
  `tool_result` is present in the request, no prior tool executes, and exactly
  one `session.resumed { reconciledToolCalls: 1 }` event is emitted before the
  first provider call.
- **AC-6 (FR-4.2 reexecute):** Same precondition with
  `resume.danglingToolCalls: "reexecute"`, then the dangling tool's `execute` is
  invoked once with the original arguments.
- **AC-7 (FR-5.1–5.2):** Given a history of complete turns exceeding `maxTokens`,
  when `truncateToolAware()` reduces it, then no resulting `tool_result` lacks
  its `tool_call` (and vice versa), system + pinned messages are retained, and
  `countTokens(result) ≤ maxTokens`.
- **AC-8 (FR-5.4):** Given system + one pinned message already over budget, when
  any strategy runs, then `ContextWindowError { tokens, limit }` is thrown.
- **AC-9 (FR-6.1–6.3):** Given a `ForgeDataSessionStore` with one session whose
  `updated_at` is 10 days old and one 1 minute old, when
  `purgeExpired({ maxIdleMs: 86_400_000 })` runs, then only the stale id is
  returned and `load()` of it yields `undefined`; the fresh one survives.
- **AC-10 (FR-6.2):** Given a `RedisSessionStore` with a fake client recording
  calls, when `setExpiry(id, 1000)` is called, then `PEXPIRE` (or `pExpire`) is
  issued for each key of `id`.
- **AC-11 (FR-7.1–7.5):** Given `withSessionStoreHooks(base, { compactor:
  summarizingCompactor({...}) })` and a history above threshold, when `append`
  runs, then `load()` returns a single pinned `system` summary plus the recent
  turns, the archive received the removed messages, and `AppendResult.compacted
  === true`; a second append below threshold makes no provider call and adds no
  second summary.
- **AC-12 (FR-8.1–8.4):** Given a resume record `model: "gpt-4"` and a run
  resolving `model: "claude-3-opus"`, when policy is `"error"`, then
  `SessionModelMismatchError { expected, actual }` is thrown before any provider
  call; when `"warn"`, a `custom` `session.model_mismatch` event is emitted and
  the run proceeds.
- **AC-13 (FR-9.3):** Given a non-checkpoint run whose final append triggers
  compaction, when the run finishes, then exactly one `session.compacted` event
  with `removed > 0` is observed by a subscriber.
- **AC-14 (FR-10.3):** `Session.append` and `SessionStore.append` resolve to an
  `AppendResult` for every built-in store; existing callers that ignored the
  return value still compile only after the documented type migration.
- **AC-15 (NFR-1):** With 10 000 sessions in the SQL store, `list({ limit: 50 })`
  issues one indexed query and returns in ≤ 50 ms locally (p99 over 20 runs).
- **AC-16 (NFR-8):** Every built-in store passes the shared store-conformance
  battery for all v2 methods.

## 8. Test strategy

- **Framework:** `bun:test`, co-located in `tests/` (existing
  `tests/session.test.ts`, `tests/session-stores.test.ts`).
- **Shared store conformance battery** (new,
  `src/testing/store-conformance.ts`, exported from
  `@infinityi/engine-lib/testing`): a `runSessionStoreConformance(makeStore)`
  function asserting v2 semantics (load/append→AppendResult/save/delete,
  list+pagination+ordering, setMetadata merge, immutability, and — when the
  store advertises `ExpiringSessionStore` — TTL/purge). Each built-in store
  registers it, mirroring `runProviderConformance` in
  `src/testing/conformance.ts`.
- **Unit:** resume helpers (`readResumeInfo`/`withResumeInfo`),
  `truncateToolAware` pairing/pinning, `summarizeOldest` turn-boundary split,
  `summarizingCompactor` thresholds/idempotency, `isExpiringSessionStore`.
- **Integration (run loop):** checkpoint step persistence + simulated crash via
  `AbortSignal` at a step boundary; resume reconciliation for all three
  `danglingToolCalls` modes using a fake provider that emits an unmatched
  tool_call; model-compatibility policies; lifecycle-event emission asserted via
  a recording subscriber.
- **Fakes:** existing fake provider patterns; in-memory + a recording Redis
  client double (extending `RedisSessionStoreClient` with `scan`/`pExpire`).
- **Done =** all ACs covered, conformance battery green for five stores, `bun
  test` and typecheck clean, docs updated (§9).

## 9. Rollout, migration & backward compatibility

- **Breaking, major `2.0.0`.** `SessionStore` gains required `list` +
  `setMetadata`; `append` return type changes `void → AppendResult`.
- **Migration note (MUST ship in `docs/sessions-and-context.md` + CHANGELOG):**
  1. Custom `SessionStore` implementers MUST add `list` and `setMetadata` and
     change `append` to return `AppendResult` (returning `{}` is valid).
  2. Callers awaiting `append`/`Session.append` are source-compatible (the
     resolved value was previously `undefined`); only TS types tighten.
  3. SQL stores require running `migrate()` to add `expires_at` + index; the
     migration is additive and idempotent. `SESSION_STORE_SCHEMA_VERSION` bumps.
  4. Redis clients used with expiry/list MUST provide `scan` and `pExpire`.
- **Opt-in features** (checkpointing, resume reconciliation knobs, TTL,
  summarizing compactor, model-compat policy) default to today's behavior except
  where noted: `resume` defaults to `true` (auto-reconcile) and
  `modelCompatibility` defaults to `"warn"`. A host wanting strict legacy
  behavior sets `resume: false` and `modelCompatibility: "ignore"`.
- **Phasing (single major, mergeable in order):**
  - Phase A — store v2 contract (list, setMetadata, AppendResult), resume
    metadata + helpers, lifecycle event variants, model-compat, errors.
  - Phase B — checkpointing + resume reconciliation in the run loop.
  - Phase C — `truncateToolAware`, structure-aware `summarizeOldest`,
    `summarizingCompactor`.
  - Phase D — expiry/TTL across stores + store conformance battery.
- **Rollback:** features are additive at the call site; reverting the major means
  reverting the contract change. Because resume defaults to auto-reconcile,
  rollback risk is the reconciliation path — gate it behind `resume:false` in
  any incident.

## 10. Alternatives considered

- **Keep SessionStore additive (capability interfaces only).** Rejected per
  maintainer decision in favor of a clean v2 with `list`/`setMetadata` required;
  optional capability interfaces (`ExpiringSessionStore`) are still used only
  where backends genuinely differ (TTL).
- **Full durable run state machine with `resumeAgent()` and a first-class
  checkpoint record.** Rejected for this spec as oversized/risky; the chosen
  "checkpoint-persist + safe re-entry" covers the high-value crash case while
  keeping the loop single-entry (`runAgent`). Can be revisited if multi-process
  hand-off is required.
- **Separate `SessionEvent` channel/subscriber.** Rejected per decision: reuse
  the `RunEvent` union + `EventHub` so consumers learn one surface; `RunEvent`
  consumers are already told to handle unknown variants defensively
  (`src/execution/types.ts`).
- **Re-execute dangling tools by default on resume.** Rejected as unsafe for
  side-effectful tools; default is `synthesize-error`, with `reexecute` opt-in.
- **Persist summaries as session metadata rather than a message.** Rejected;
  storing the summary as a pinned `system` message keeps `load()` returning a
  ready-to-send conversation with no special re-injection step.

## 11. Open questions

| # | Question | Owner | Blocks implementation? |
| --- | --- | --- | --- |
| 1 | Do we need cross-writer/locking guarantees (multiple processes resuming the same id concurrently), or is single-writer-per-id a sufficient documented constraint? | maintainers | No (spec assumes single-writer; locking is a follow-up) |
| 2 | Should `list()` default page size be 100, and should ordering default to `"recent"` only when `updatedAt` exists (else `"id"`)? Confirm the numbers. | maintainers | No (defaults chosen; tune in review) |
| 3 | `summarizingCompactor` default `keepRecentTurns = 6` and default compaction threshold — confirm values against real transcript sizes. | maintainers | No |
| 4 | For lazy expiry: should `runAgent` actively delete an expired session on load, or only emit `session.expired` and treat it as empty? (Spec: emit + treat-as-empty, no auto-delete.) | maintainers | No |
| 5 | Should `setExpiry`/TTL also refresh on every `append` (sliding window) or only when explicitly called? (Spec: explicit only; Redis TTL is sticky unless re-set.) | maintainers | No |

## 12. References

- Source analysis: `.claude/reports/session-hardening.md`
- Sessions: `src/session/types.ts`, `src/session/session.ts`, `src/session/store.ts`
- Stores: `src/session-stores/{types,hooks,redis,forge-data,jsonl,versioning}.ts`
- Run loop: `src/execution/run.ts`, `src/execution/types.ts`
- Context windows: `src/context/window.ts`, `src/context/types.ts`
- Events/telemetry: `src/events/{types,hub,telemetry,subscribers}.ts`
- Conformance pattern: `src/testing/conformance.ts`
- Standards: ISO/IEC/IEEE 29148:2018; RFC 2119 / RFC 8174; arc42 / C4; ADR
  (Nygard); Gherkin (Given/When/Then)

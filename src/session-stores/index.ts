/**
 * `@infinityi/engine-lib/session-stores` — optional durable implementations of
 * the stable session-store contract.
 *
 * These adapters are opt-in so the root package stays lightweight. Built-ins
 * include Forge SQL/SQLite/PostgreSQL, Redis, and filesystem JSONL stores, plus
 * common codec, migration, compaction, and archival helpers.
 *
 * @module
 */

export { jsonSessionStoreCodec } from "./codec";
export { SUMMARY_METADATA_KEY, summarizingCompactor } from "./compactor";
export {
  ForgeDataSessionStore,
  createPostgresSessionStore,
  createSqliteSessionStore,
} from "./forge-data";
export { withSessionStoreHooks } from "./hooks";
export { FilesystemJsonlSessionStore } from "./jsonl";
export {
  isCasSessionStore,
  isVersionMismatch,
  tenantScopedStore,
  withVersionRetry,
} from "./concurrency";
export { RedisSessionStore } from "./redis";
export { InMemorySessionStore } from "../session/index";
export {
  SESSION_STORE_SCHEMA_VERSION,
  isCloseableSessionStore,
  isExpiringSessionStore,
  isVersionedSessionStore,
  migrateSessionStore,
} from "./versioning";

export type {
  CreatePostgresSessionStoreOptions,
  CreateSqliteSessionStoreOptions,
  ForgeDataSessionStoreOptions,
} from "./forge-data";
export type { SummarizingCompactorOptions } from "./compactor";
export type { FilesystemJsonlSessionStoreOptions } from "./jsonl";
export type {
  RedisSessionStoreClient,
  RedisSessionStoreOptions,
  RedisSessionStoreTransaction,
} from "./redis";
export type {
  CasSessionStore,
  TenantDeniedEvent,
  VersionMismatch,
} from "./concurrency";
export type {
  CloseableSessionStore,
  ExpiringSessionStore,
  PurgeExpiredOptions,
  SessionArchiveRecord,
  SessionArchiver,
  SessionCompactionResult,
  SessionCompactor,
  SessionStoreCodec,
  SessionStoreHookContext,
  SessionStoreHookOperation,
  SessionStoreHooks,
  VersionedSessionStore,
} from "./types";

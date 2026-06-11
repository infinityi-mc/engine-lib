/**
 * `@infinityi/engine-lib/session-stores` — optional durable implementations of
 * the stable {@link SessionStore} contract.
 *
 * These adapters are opt-in so the root package stays lightweight. Built-ins
 * include Forge SQL/SQLite/PostgreSQL, Redis, and filesystem JSONL stores, plus
 * common codec, migration, compaction, and archival helpers.
 *
 * @module
 */

export { jsonSessionStoreCodec } from "./codec";
export { ForgeDataSessionStore, createPostgresSessionStore, createSqliteSessionStore } from "./forge-data";
export { withSessionStoreHooks } from "./hooks";
export { FilesystemJsonlSessionStore } from "./jsonl";
export { RedisSessionStore } from "./redis";
export { SESSION_STORE_SCHEMA_VERSION, isCloseableSessionStore, isVersionedSessionStore, migrateSessionStore } from "./versioning";

export type {
  CreatePostgresSessionStoreOptions,
  CreateSqliteSessionStoreOptions,
  ForgeDataSessionStoreOptions,
} from "./forge-data";
export type { FilesystemJsonlSessionStoreOptions } from "./jsonl";
export type { RedisSessionStoreClient, RedisSessionStoreOptions, RedisSessionStoreTransaction } from "./redis";
export type {
  CloseableSessionStore,
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

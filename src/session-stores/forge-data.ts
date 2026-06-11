import { createDb, raw, sql } from "@infinityi/forge/data";
import type { DatabaseSchema, Db, SqlFragment } from "@infinityi/forge/data";
import { createPostgresDialect, createPostgresDriver } from "@infinityi/forge/data/dialects/postgres";
import type { PostgresClientLike } from "@infinityi/forge/data/dialects/postgres";
import { createSqliteDialect, createSqliteDriver } from "@infinityi/forge/data/dialects/sqlite";
import type { SqliteDriverOptions } from "@infinityi/forge/data/dialects/sqlite";

import type { Message } from "../messages/types";
import type { SessionState, SessionStore } from "../session/types";
import { decodeMessages, decodeMetadata, encodeMessages, encodeMetadata, jsonSessionStoreCodec } from "./codec";
import { assertTablePrefix } from "./ids";
import type { SessionStoreCodec } from "./types";
import { SESSION_STORE_SCHEMA_VERSION } from "./versioning";

const DEFAULT_TABLE_PREFIX = "engine_session";

interface SessionRow {
  readonly id: string;
  readonly metadata: string | null;
}

interface MessageRow {
  readonly payload: string;
}

interface SequenceRow {
  readonly next_seq: number | string | bigint;
}

interface VersionRow {
  readonly value: string;
}

interface StoreTables {
  readonly sessions: SqlFragment;
  readonly messages: SqlFragment;
  readonly meta: SqlFragment;
}

export interface ForgeDataSessionStoreOptions {
  readonly db: Db<DatabaseSchema>;
  readonly tablePrefix?: string;
  readonly codec?: SessionStoreCodec;
  readonly closeDbOnClose?: boolean;
}

export interface CreateSqliteSessionStoreOptions extends Pick<SqliteDriverOptions, "database" | "filename" | "create"> {
  readonly tablePrefix?: string;
  readonly codec?: SessionStoreCodec;
  readonly migrate?: boolean;
}

export interface CreatePostgresSessionStoreOptions {
  readonly client: PostgresClientLike;
  readonly closeOnShutdown?: boolean;
  readonly tablePrefix?: string;
  readonly codec?: SessionStoreCodec;
  readonly migrate?: boolean;
}

function table(db: Db<DatabaseSchema>, name: string): SqlFragment {
  return raw(db.dialect.quoteIdentifier(name));
}

function tablesFor(db: Db<DatabaseSchema>, prefix: string): StoreTables {
  const valid = assertTablePrefix(prefix);
  return {
    sessions: table(db, `${valid}_sessions`),
    messages: table(db, `${valid}_messages`),
    meta: table(db, `${valid}_meta`),
  };
}

function toNumber(value: number | string | bigint): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number.parseInt(value, 10);
}

function stateOf(
  id: string,
  messages: readonly Message[],
  metadata: Readonly<Record<string, unknown>> | undefined,
): SessionState {
  return {
    id,
    messages: [...messages],
    ...(metadata !== undefined ? { metadata: { ...metadata } } : {}),
  };
}

/** SQL-backed {@link SessionStore} implemented over a Forge `Db`. */
export class ForgeDataSessionStore implements SessionStore {
  private readonly db: Db<DatabaseSchema>;
  private readonly codec: SessionStoreCodec;
  private readonly tables: StoreTables;
  private readonly closeDbOnClose: boolean;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: ForgeDataSessionStoreOptions) {
    this.db = options.db;
    this.codec = options.codec ?? jsonSessionStoreCodec;
    this.tables = tablesFor(options.db, options.tablePrefix ?? DEFAULT_TABLE_PREFIX);
    this.closeDbOnClose = options.closeDbOnClose ?? false;
  }

  async migrate(): Promise<void> {
    await this.db.raw(sql`
      create table if not exists ${this.tables.sessions} (
        id text primary key,
        metadata text null,
        next_seq integer not null default 0,
        created_at text not null,
        updated_at text not null
      )
    `).execute();

    await this.db.raw(sql`
      create table if not exists ${this.tables.messages} (
        session_id text not null,
        seq integer not null,
        payload text not null,
        created_at text not null,
        primary key (session_id, seq)
      )
    `).execute();

    await this.db.raw(sql`
      create table if not exists ${this.tables.meta} (
        key text primary key,
        value text not null
      )
    `).execute();

    await this.db.raw(sql`
      insert into ${this.tables.meta} (key, value)
      values (${"schema_version"}, ${String(SESSION_STORE_SCHEMA_VERSION)})
      on conflict (key) do update set value = excluded.value
    `).execute();
  }

  async schemaVersion(): Promise<number | undefined> {
    const row = await this.db.raw<VersionRow>(sql`
      select value from ${this.tables.meta} where key = ${"schema_version"}
    `).executeTakeFirst();
    return row === undefined ? undefined : Number.parseInt(row.value, 10);
  }

  async load(id: string): Promise<SessionState | undefined> {
    await this.writeQueue.catch(() => {});
    const session = await this.db.raw<SessionRow>(sql`
      select id, metadata from ${this.tables.sessions} where id = ${id}
    `).executeTakeFirst();
    if (session === undefined) return undefined;

    const rows = await this.db.raw<MessageRow>(sql`
      select payload from ${this.tables.messages}
      where session_id = ${id}
      order by seq asc
    `).execute();

    const messages = await decodeMessages(this.codec, rows.rows.map((row) => row.payload));
    const metadata = await decodeMetadata(this.codec, session.metadata);
    return stateOf(id, messages, metadata);
  }

  async append(id: string, messages: readonly Message[]): Promise<void> {
    if (messages.length === 0) return;
    const encoded = await encodeMessages(this.codec, messages);
    const now = new Date().toISOString();

    await this.enqueueWrite(async () => this.db.uow(async (tx) => {
      await tx.raw(sql`
        insert into ${this.tables.sessions} (id, metadata, next_seq, created_at, updated_at)
        values (${id}, null, 0, ${now}, ${now})
        on conflict (id) do nothing
      `).execute();

      const row = await tx.raw<SequenceRow>(sql`
        update ${this.tables.sessions}
        set next_seq = next_seq + ${encoded.length}, updated_at = ${now}
        where id = ${id}
        returning next_seq
      `).executeTakeFirst();
      if (row === undefined) throw new Error(`Failed to allocate session sequence for ${id}`);

      const start = toNumber(row.next_seq) - encoded.length;
      for (let index = 0; index < encoded.length; index += 1) {
        await tx.raw(sql`
          insert into ${this.tables.messages} (session_id, seq, payload, created_at)
          values (${id}, ${start + index}, ${encoded[index]!}, ${now})
        `).execute();
      }
    }));
  }

  async save(state: SessionState): Promise<void> {
    const encoded = await encodeMessages(this.codec, state.messages);
    const metadata = await encodeMetadata(this.codec, state.metadata);
    const now = new Date().toISOString();

    await this.enqueueWrite(async () => this.db.uow(async (tx) => {
      await tx.raw(sql`
        insert into ${this.tables.sessions} (id, metadata, next_seq, created_at, updated_at)
        values (${state.id}, ${metadata ?? null}, ${encoded.length}, ${now}, ${now})
        on conflict (id) do update set
          metadata = excluded.metadata,
          next_seq = excluded.next_seq,
          updated_at = excluded.updated_at
      `).execute();

      await tx.raw(sql`
        delete from ${this.tables.messages} where session_id = ${state.id}
      `).execute();

      for (let index = 0; index < encoded.length; index += 1) {
        await tx.raw(sql`
          insert into ${this.tables.messages} (session_id, seq, payload, created_at)
          values (${state.id}, ${index}, ${encoded[index]!}, ${now})
        `).execute();
      }
    }));
  }

  async delete(id: string): Promise<void> {
    await this.enqueueWrite(async () => this.db.uow(async (tx) => {
      await tx.raw(sql`delete from ${this.tables.messages} where session_id = ${id}`).execute();
      await tx.raw(sql`delete from ${this.tables.sessions} where id = ${id}`).execute();
    }));
  }

  async close(): Promise<void> {
    await this.writeQueue.catch(() => {});
    if (this.closeDbOnClose) await this.db.shutdown();
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.catch(() => {}).then(task);
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}

export async function createSqliteSessionStore(
  options: CreateSqliteSessionStoreOptions = {},
): Promise<ForgeDataSessionStore> {
  const db = createDb<DatabaseSchema>({
    dialect: createSqliteDialect(),
    driver: createSqliteDriver({
      database: options.database,
      filename: options.filename,
      create: options.create,
    }),
  });
  const store = new ForgeDataSessionStore({
    db,
    tablePrefix: options.tablePrefix,
    codec: options.codec,
    closeDbOnClose: true,
  });
  if (options.migrate) await store.migrate();
  return store;
}

export async function createPostgresSessionStore(
  options: CreatePostgresSessionStoreOptions,
): Promise<ForgeDataSessionStore> {
  const db = createDb<DatabaseSchema>({
    dialect: createPostgresDialect(),
    driver: createPostgresDriver({
      client: options.client,
      closeOnShutdown: options.closeOnShutdown,
    }),
  });
  const store = new ForgeDataSessionStore({
    db,
    tablePrefix: options.tablePrefix,
    codec: options.codec,
    closeDbOnClose: true,
  });
  if (options.migrate) await store.migrate();
  return store;
}

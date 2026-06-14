import { createDb, raw, sql } from "@infinityi/forge/data";
import type { DatabaseSchema, Db, SqlFragment } from "@infinityi/forge/data";
import { createPostgresDialect, createPostgresDriver } from "@infinityi/forge/data/dialects/postgres";
import type { PostgresClientLike } from "@infinityi/forge/data/dialects/postgres";
import { createSqliteDialect, createSqliteDriver } from "@infinityi/forge/data/dialects/sqlite";
import type { SqliteDriverOptions } from "@infinityi/forge/data/dialects/sqlite";

import type { Message } from "../messages/types";
import { encodeSessionListCursor, normalizeSessionListOptions } from "../session/list";
import { readResumeInfo } from "../session/resume";
import type {
  AppendResult,
  SessionListOptions,
  SessionListPage,
  SessionState,
  SessionStore,
} from "../session/types";
import { decodeMessages, decodeMetadata, encodeMessages, encodeMetadata, jsonSessionStoreCodec } from "./codec";
import { assertTablePrefix } from "./ids";
import type { PurgeExpiredOptions, SessionStoreCodec } from "./types";
import { SESSION_STORE_SCHEMA_VERSION } from "./versioning";

const DEFAULT_TABLE_PREFIX = "engine_session";

interface SessionRow {
  readonly id: string;
  readonly metadata: string | null;
  readonly version?: number | string | bigint | null;
  readonly tenant_id?: string | null;
  readonly expires_at?: string | null;
}

interface MessageRow {
  readonly payload: string;
}

interface ListRow {
  readonly id: string;
  readonly metadata: string | null;
  readonly version: number | string | bigint;
  readonly tenant_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly message_count: number | string | bigint;
}

interface SequenceRow {
  readonly next_seq: number | string | bigint;
}

interface VersionRow {
  readonly value: string;
}

interface IdRow {
  readonly id: string;
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
  version: number,
  tenantId: string | undefined,
): SessionState {
  return {
    id,
    messages: [...messages],
    ...(metadata !== undefined ? { metadata: { ...metadata } } : {}),
    version,
    ...(tenantId !== undefined ? { tenantId } : {}),
  };
}

/** SQL-backed {@link SessionStore} implemented over a Forge `Db`. */
export class ForgeDataSessionStore implements SessionStore {
  private readonly db: Db<DatabaseSchema>;
  private readonly codec: SessionStoreCodec;
  private readonly tables: StoreTables;
  private readonly tablePrefix: string;
  private readonly closeDbOnClose: boolean;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: ForgeDataSessionStoreOptions) {
    this.db = options.db;
    this.codec = options.codec ?? jsonSessionStoreCodec;
    this.tablePrefix = assertTablePrefix(options.tablePrefix ?? DEFAULT_TABLE_PREFIX);
    this.tables = tablesFor(options.db, this.tablePrefix);
    this.closeDbOnClose = options.closeDbOnClose ?? false;
  }

  async migrate(): Promise<void> {
    await this.db.raw(sql`
      create table if not exists ${this.tables.sessions} (
        id text primary key,
        metadata text null,
        next_seq integer not null default 0,
        version integer not null default 0,
        tenant_id text null,
        created_at text not null,
        updated_at text not null,
        expires_at text null
      )
    `).execute();

    await this.addExpiresAtColumnIfNeeded();
    await this.addVersionColumnIfNeeded();
    await this.addTenantIdColumnIfNeeded();

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
      create index if not exists ${this.indexName("sessions_updated_at_idx")}
      on ${this.tables.sessions} (updated_at)
    `).execute();

    await this.db.raw(sql`
      create index if not exists ${this.indexName("sessions_expires_at_idx")}
      on ${this.tables.sessions} (expires_at)
    `).execute();

    await this.db.raw(sql`
      create index if not exists ${this.indexName("sessions_tenant_id_idx")}
      on ${this.tables.sessions} (tenant_id)
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
      select id, metadata, version, tenant_id, expires_at from ${this.tables.sessions} where id = ${id}
    `).executeTakeFirst();
    if (session === undefined) return undefined;
    if (session.expires_at !== null && session.expires_at !== undefined && Date.parse(session.expires_at) <= Date.now()) {
      return undefined;
    }

    const rows = await this.db.raw<MessageRow>(sql`
      select payload from ${this.tables.messages}
      where session_id = ${id}
      order by seq asc
    `).execute();

    const messages = await decodeMessages(this.codec, rows.rows.map((row) => row.payload));
    const metadata = await decodeMetadata(this.codec, session.metadata);
    return stateOf(
      id,
      messages,
      metadata,
      session.version == null ? 0 : toNumber(session.version),
      session.tenant_id ?? undefined,
    );
  }

  async append(id: string, messages: readonly Message[]): Promise<AppendResult> {
    if (messages.length === 0) return {};
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
    return {};
  }

  async setMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
    const encoded = await encodeMetadata(this.codec, metadata);
    const now = new Date().toISOString();

    await this.enqueueWrite(async () => this.db.uow(async (tx) => {
      await tx.raw(sql`
        insert into ${this.tables.sessions} (id, metadata, next_seq, created_at, updated_at, expires_at)
        values (${id}, ${encoded ?? null}, 0, ${now}, ${now}, null)
        on conflict (id) do update set
          metadata = excluded.metadata,
          updated_at = excluded.updated_at
      `).execute();
    }));
  }

  async list(options?: SessionListOptions): Promise<SessionListPage> {
    await this.writeQueue.catch(() => {});
    const normalized = normalizeSessionListOptions(options, "recent");
    const prefix = normalized.prefix;
    const tenantId = normalized.tenantId;
    const limit = normalized.limit + 1;
    const offset = normalized.offset;
    const pattern = prefix === undefined ? undefined : `${prefix}%`;

    const rows = normalized.order === "id"
      ? await this.db.raw<ListRow>(sql`
          select s.id, s.metadata, s.version, s.tenant_id, s.created_at, s.updated_at, count(m.seq) as message_count
          from ${this.tables.sessions} s
          left join ${this.tables.messages} m on m.session_id = s.id
          where (s.expires_at is null or s.expires_at > ${new Date().toISOString()})
          ${pattern === undefined ? sql`` : sql`and s.id like ${pattern}`}
          ${tenantId === undefined ? sql`` : sql`and s.tenant_id = ${tenantId}`}
          group by s.id, s.metadata, s.version, s.tenant_id, s.created_at, s.updated_at
          order by s.id asc
          limit ${limit} offset ${offset}
        `).execute()
      : await this.db.raw<ListRow>(sql`
          select s.id, s.metadata, s.version, s.tenant_id, s.created_at, s.updated_at, count(m.seq) as message_count
          from ${this.tables.sessions} s
          left join ${this.tables.messages} m on m.session_id = s.id
          where (s.expires_at is null or s.expires_at > ${new Date().toISOString()})
          ${pattern === undefined ? sql`` : sql`and s.id like ${pattern}`}
          ${tenantId === undefined ? sql`` : sql`and s.tenant_id = ${tenantId}`}
          group by s.id, s.metadata, s.version, s.tenant_id, s.created_at, s.updated_at
          order by s.updated_at desc, s.id asc
          limit ${limit} offset ${offset}
        `).execute();

    const pageRows = rows.rows.slice(0, normalized.limit);
    return {
      sessions: await Promise.all(pageRows.map(async (row) => {
        const metadata = await decodeMetadata(this.codec, row.metadata);
        const resume = readResumeInfo(metadata);
        return {
          id: row.id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          messageCount: toNumber(row.message_count),
          version: toNumber(row.version),
          ...(row.tenant_id !== null ? { tenantId: row.tenant_id } : {}),
          ...(resume !== undefined ? { resume } : {}),
        };
      })),
      ...(rows.rows.length > normalized.limit
        ? {
            cursor: encodeSessionListCursor({
              ...(normalized.prefix !== undefined ? { prefix: normalized.prefix } : {}),
              ...(normalized.tenantId !== undefined ? { tenantId: normalized.tenantId } : {}),
              order: normalized.order,
              offset: normalized.offset + normalized.limit,
            }),
          }
        : {}),
    };
  }

  async save(state: SessionState): Promise<void> {
    const encoded = await encodeMessages(this.codec, state.messages);
    const metadata = await encodeMetadata(this.codec, state.metadata);
    const now = new Date().toISOString();

    await this.enqueueWrite(async () => this.db.uow(async (tx) => {
      const existing = await tx.raw<SessionRow>(sql`
        select version, tenant_id from ${this.tables.sessions} where id = ${state.id}
      `).executeTakeFirst();
      const stateVersion = state.version ?? (existing?.version == null ? 0 : toNumber(existing.version));
      const tenantId = state.tenantId ?? existing?.tenant_id ?? null;

      await tx.raw(sql`
        insert into ${this.tables.sessions} (id, metadata, next_seq, version, tenant_id, created_at, updated_at)
        values (${state.id}, ${metadata ?? null}, ${encoded.length}, ${stateVersion}, ${tenantId}, ${now}, ${now})
        on conflict (id) do update set
          metadata = excluded.metadata,
          next_seq = excluded.next_seq,
          version = excluded.version,
          tenant_id = excluded.tenant_id,
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

  async setExpiry(id: string, ttlMs: number): Promise<void> {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error("ttlMs must be a non-negative finite number");
    }
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await this.enqueueWrite(async () => this.db.uow(async (tx) => {
      await tx.raw(sql`
        insert into ${this.tables.sessions} (id, metadata, next_seq, created_at, updated_at, expires_at)
        values (${id}, null, 0, ${now}, ${now}, ${expiresAt})
        on conflict (id) do update set expires_at = excluded.expires_at
      `).execute();
    }));
  }

  async purgeExpired(options: PurgeExpiredOptions = {}): Promise<string[]> {
    const now = new Date().toISOString();
    const idleCutoff = options.maxIdleMs === undefined
      ? undefined
      : new Date(Date.now() - options.maxIdleMs).toISOString();

    if (idleCutoff === undefined) {
      return this.purgeWhere(sql`expires_at is not null and expires_at <= ${now}`, "ttl", options);
    }

    return this.purgeWhere(sql`
      (expires_at is not null and expires_at <= ${now}) or updated_at <= ${idleCutoff}
    `, "purged", options);
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

  private indexName(name: string): SqlFragment {
    return raw(this.db.dialect.quoteIdentifier(`${this.tablePrefix}_${name}`));
  }

  private async addExpiresAtColumnIfNeeded(): Promise<void> {
    try {
      await this.db.raw(sql`
        alter table ${this.tables.sessions} add column expires_at text null
      `).execute();
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      const message = [
        error instanceof Error ? error.message : String(error),
        cause instanceof Error ? cause.message : "",
      ].join(" ").toLowerCase();
      if (!message.includes("duplicate") && !message.includes("exists")) throw error;
    }
  }

  private async addVersionColumnIfNeeded(): Promise<void> {
    try {
      await this.db.raw(sql`
        alter table ${this.tables.sessions} add column version integer not null default 0
      `).execute();
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      const message = [
        error instanceof Error ? error.message : String(error),
        cause instanceof Error ? cause.message : "",
      ].join(" ").toLowerCase();
      if (!message.includes("duplicate") && !message.includes("exists")) throw error;
    }
  }

  private async addTenantIdColumnIfNeeded(): Promise<void> {
    try {
      await this.db.raw(sql`
        alter table ${this.tables.sessions} add column tenant_id text null
      `).execute();
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      const message = [
        error instanceof Error ? error.message : String(error),
        cause instanceof Error ? cause.message : "",
      ].join(" ").toLowerCase();
      if (!message.includes("duplicate") && !message.includes("exists")) throw error;
    }
  }

  private async purgeWhere(
    predicate: SqlFragment,
    defaultReason: "ttl" | "idle" | "purged",
    options: PurgeExpiredOptions,
  ): Promise<string[]> {
    const ids = await this.enqueueWrite(async () => this.db.uow(async (tx) => {
      const rows = await tx.raw<IdRow>(sql`
        select id from ${this.tables.sessions} where ${predicate}
      `).execute();
      const purgedIds = rows.rows.map((row) => row.id);
      if (purgedIds.length === 0) return purgedIds;
      for (const id of purgedIds) {
        await tx.raw(sql`delete from ${this.tables.messages} where session_id = ${id}`).execute();
      }
      await tx.raw(sql`delete from ${this.tables.sessions} where ${predicate}`).execute();
      return purgedIds;
    }));

    for (const id of ids) {
      options.onEvent?.({ type: "session.expired", sessionId: id, reason: defaultReason });
    }
    return ids;
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

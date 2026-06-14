import type { Message } from "../messages/types";
import { encodeSessionListCursor, normalizeSessionListOptions } from "../session/list";
import { readResumeInfo } from "../session/resume";
import type {
  AppendResult,
  SessionListOptions,
  SessionListPage,
  SessionTenantClaim,
  SessionState,
  SessionStore,
} from "../session/types";
import { decodeMessages, decodeMetadata, encodeMessages, encodeMetadata, jsonSessionStoreCodec } from "./codec";
import { safeSessionKey } from "./ids";
import type { PurgeExpiredOptions, SessionStoreCodec } from "./types";
import { SESSION_STORE_SCHEMA_VERSION } from "./versioning";

export interface RedisSessionStoreTransaction {
  del(...keys: string[]): RedisSessionStoreTransaction;
  set(key: string, value: string): RedisSessionStoreTransaction;
  rPush?(key: string, ...values: string[]): RedisSessionStoreTransaction;
  rpush?(key: string, ...values: string[]): RedisSessionStoreTransaction;
  exec(): Promise<unknown> | unknown;
}

export interface RedisSessionStoreClient {
  get(key: string): Promise<string | null | undefined> | string | null | undefined;
  set(key: string, value: string): Promise<unknown> | unknown;
  del(...keys: string[]): Promise<unknown> | unknown;
  lRange?(key: string, start: number, stop: number): Promise<string[]> | string[];
  lrange?(key: string, start: number, stop: number): Promise<string[]> | string[];
  rPush?(key: string, ...values: string[]): Promise<unknown> | unknown;
  rpush?(key: string, ...values: string[]): Promise<unknown> | unknown;
  pExpire?(key: string, ttlMs: number): Promise<unknown> | unknown;
  pexpire?(key: string, ttlMs: number): Promise<unknown> | unknown;
  scan?(
    cursor: string,
    options?: { readonly MATCH?: string; readonly match?: string; readonly COUNT?: number; readonly count?: number },
  ): Promise<{ cursor: string | number; keys: string[] } | [string | number, string[]]>
    | { cursor: string | number; keys: string[] }
    | [string | number, string[]];
  multi?(): RedisSessionStoreTransaction;
}

export interface RedisSessionStoreOptions {
  readonly client: RedisSessionStoreClient;
  readonly keyPrefix?: string;
  readonly codec?: SessionStoreCodec;
}

function metadataState(
  id: string,
  messages: readonly Message[],
  metadata: Readonly<Record<string, unknown>> | undefined,
  info: RedisExistsInfo | undefined,
): SessionState {
  return {
    id,
    messages: [...messages],
    ...(metadata !== undefined ? { metadata: { ...metadata } } : {}),
    version: info?.version ?? 0,
    ...(info?.tenantId !== undefined ? { tenantId: info.tenantId } : {}),
  };
}

function rpushTransaction(tx: RedisSessionStoreTransaction, key: string, values: readonly string[]): void {
  if (values.length === 0) return;
  if (tx.rPush !== undefined) {
    tx.rPush(key, ...values);
    return;
  }
  if (tx.rpush !== undefined) {
    tx.rpush(key, ...values);
    return;
  }
  throw new Error("Redis session store transaction must implement rPush/rpush");
}

interface RedisExistsInfo {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version?: number;
  readonly tenantId?: string;
}

function encodeExistsInfo(info: RedisExistsInfo): string {
  return JSON.stringify(info);
}

function decodeExistsInfo(payload: string | null | undefined): RedisExistsInfo | undefined {
  if (payload == null || payload === "1") return undefined;
  try {
    const parsed = JSON.parse(payload) as Partial<RedisExistsInfo>;
    if (typeof parsed.createdAt === "string" && typeof parsed.updatedAt === "string") {
      return {
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        ...(typeof parsed.version === "number" ? { version: parsed.version } : {}),
        ...(typeof parsed.tenantId === "string" ? { tenantId: parsed.tenantId } : {}),
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function decodeSessionKey(keyPrefix: string, key: string): string | undefined {
  const head = `${keyPrefix}:`;
  const tail = ":exists";
  if (!key.startsWith(head) || !key.endsWith(tail)) return undefined;
  const encoded = key.slice(head.length, -tail.length);
  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

/** Redis-list-backed {@link SessionStore} using a structural Redis client. */
export class RedisSessionStore implements SessionStore {
  private readonly client: RedisSessionStoreClient;
  private readonly keyPrefix: string;
  private readonly codec: SessionStoreCodec;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(options: RedisSessionStoreOptions) {
    this.client = options.client;
    this.keyPrefix = options.keyPrefix ?? "engine:sessions";
    this.codec = options.codec ?? jsonSessionStoreCodec;
  }

  async migrate(): Promise<void> {
    await this.client.set(this.versionKey(), String(SESSION_STORE_SCHEMA_VERSION));
  }

  async load(id: string): Promise<SessionState | undefined> {
    const payloads = await this.lRange(this.messagesKey(id), 0, -1);
    const metadataPayload = await this.client.get(this.metadataKey(id));
    const exists = await this.client.get(this.existsKey(id));
    if (payloads.length === 0 && metadataPayload == null && exists == null) return undefined;
    const existsInfo = decodeExistsInfo(exists);
    const metadata = await decodeMetadata(this.codec, metadataPayload);
    const messages = await decodeMessages(this.codec, payloads);
    return metadataState(id, messages, metadata, existsInfo);
  }

  async append(id: string, messages: readonly Message[]): Promise<AppendResult> {
    if (messages.length === 0) return {};
    const encoded = await encodeMessages(this.codec, messages);
    await this.enqueue(id, async () => {
      const exists = await this.nextExistsInfo(id);
      const tx = this.client.multi?.();
      if (tx !== undefined) {
        tx.set(this.existsKey(id), encodeExistsInfo(exists));
        rpushTransaction(tx, this.messagesKey(id), encoded);
        await tx.exec();
      } else {
        await this.rPush(this.messagesKey(id), encoded);
        await this.client.set(this.existsKey(id), encodeExistsInfo(exists));
      }
    });
    return {};
  }

  async setMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
    const encoded = await encodeMetadata(this.codec, metadata);
    await this.enqueue(id, async () => {
      const exists = await this.nextExistsInfo(id);
      const tx = this.transaction();
      tx.del(this.metadataKey(id));
      tx.set(this.existsKey(id), encodeExistsInfo(exists));
      if (encoded !== undefined) tx.set(this.metadataKey(id), encoded);
      await tx.exec();
    });
  }

  async list(options?: SessionListOptions): Promise<SessionListPage> {
    const normalized = normalizeSessionListOptions(options, "id");
    const scan = this.client.scan;
    if (scan === undefined) throw new Error("Redis session store client must implement scan for list()");

    const rawKeys = new Set<string>();
    let cursor = "0";
    const matchPrefix = `${this.keyPrefix}:*:exists`;
    do {
      const response = await scan.call(this.client, cursor, {
        MATCH: matchPrefix,
        COUNT: Math.max(normalized.limit + normalized.offset + 1, 100),
      });
      if (Array.isArray(response)) {
        cursor = String(response[0]);
        for (const key of response[1]) rawKeys.add(key);
      } else {
        cursor = String(response.cursor);
        for (const key of response.keys) rawKeys.add(key);
      }
    } while (cursor !== "0");

    const rows: Array<{
      id: string;
      createdAt?: string;
      updatedAt?: string;
      state?: SessionState;
      tenantId?: string;
      version?: number;
    }> = [];
    for (const key of rawKeys) {
      const id = decodeSessionKey(this.keyPrefix, key);
      if (id === undefined) continue;
      if (normalized.prefix !== undefined && !id.startsWith(normalized.prefix)) continue;
      const exists = decodeExistsInfo(await this.client.get(this.existsKey(id)));
      if (normalized.tenantId !== undefined && exists?.tenantId !== normalized.tenantId) continue;
      rows.push({
        id,
        ...(exists?.createdAt !== undefined ? { createdAt: exists.createdAt } : {}),
        ...(exists?.updatedAt !== undefined ? { updatedAt: exists.updatedAt } : {}),
        version: exists?.version ?? 0,
        ...(exists?.tenantId !== undefined ? { tenantId: exists.tenantId } : {}),
      });
    }

    rows.sort((a, b) => {
      if (normalized.order === "recent") {
        const byRecent = (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
        if (byRecent !== 0) return byRecent;
      }
      return a.id.localeCompare(b.id);
    });

    const pageRows = rows.slice(normalized.offset, normalized.offset + normalized.limit);
    const sessions = [];
    for (const row of pageRows) {
      const state = await this.load(row.id);
      const resume = readResumeInfo(state);
      sessions.push({
        id: row.id,
        ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
        ...(row.updatedAt !== undefined ? { updatedAt: row.updatedAt } : {}),
        ...(state !== undefined ? { messageCount: state.messages.length } : {}),
        version: row.version ?? 0,
        ...(row.tenantId !== undefined ? { tenantId: row.tenantId } : {}),
        ...(resume !== undefined ? { resume } : {}),
      });
    }

    const hasMore = normalized.offset + normalized.limit < rows.length;
    return {
      sessions,
      ...(hasMore
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
    await this.enqueue(state.id, () => this.writeState(state));
  }

  async claimTenant(claim: SessionTenantClaim): Promise<boolean> {
    return this.enqueue(claim.id, async () => {
      const existing = await this.load(claim.id);
      if (existing?.tenantId !== undefined && existing.tenantId !== claim.tenantId) {
        throw new Error(`session "${claim.id}" is owned by a different tenant`);
      }

      const shouldSeedMessages =
        claim.messages !== undefined &&
        claim.messages.length > 0 &&
        (existing === undefined || existing.messages.length === 0);
      const shouldSeedMetadata = claim.metadata !== undefined && existing === undefined;
      const shouldSeedTenant = existing?.tenantId === undefined;
      if (!shouldSeedMessages && !shouldSeedMetadata && !shouldSeedTenant) return false;

      await this.writeState({
        id: claim.id,
        messages: shouldSeedMessages ? claim.messages ?? [] : existing?.messages ?? [],
        ...(shouldSeedMetadata ? { metadata: claim.metadata } : existing?.metadata !== undefined ? { metadata: existing.metadata } : {}),
        version: existing?.version ?? 0,
        tenantId: claim.tenantId,
      });
      return true;
    });
  }

  async delete(id: string): Promise<void> {
    await this.enqueue(id, async () => {
      const tx = this.transaction();
      tx.del(this.messagesKey(id), this.metadataKey(id), this.existsKey(id));
      await tx.exec();
    });
  }

  async setExpiry(id: string, ttlMs: number): Promise<void> {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error("ttlMs must be a non-negative finite number");
    }
    await Promise.all([
      this.pExpire(this.messagesKey(id), ttlMs),
      this.pExpire(this.metadataKey(id), ttlMs),
      this.pExpire(this.existsKey(id), ttlMs),
    ]);
  }

  purgeExpired(_options: PurgeExpiredOptions = {}): Promise<string[]> {
    return Promise.resolve([]);
  }

  private transaction(): RedisSessionStoreTransaction {
    const tx = this.client.multi?.();
    if (tx === undefined) throw new Error("Redis session store save/delete require a transaction-capable client");
    return tx;
  }

  private async enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const next = run.then(() => undefined, () => undefined);
    this.queues.set(id, next);
    try {
      return await run;
    } finally {
      if (this.queues.get(id) === next) this.queues.delete(id);
    }
  }

  private async writeState(state: SessionState): Promise<void> {
    const tx = this.transaction();
    const messagesKey = this.messagesKey(state.id);
    const metadataKey = this.metadataKey(state.id);
    const existsKey = this.existsKey(state.id);
    const encoded = await encodeMessages(this.codec, state.messages);
    const metadata = await encodeMetadata(this.codec, state.metadata);
    const exists = await this.existsInfoForState(state);

    tx.del(messagesKey, metadataKey, existsKey);
    tx.set(existsKey, encodeExistsInfo(exists));
    if (metadata !== undefined) tx.set(metadataKey, metadata);
    rpushTransaction(tx, messagesKey, encoded);
    await tx.exec();
  }

  private async lRange(key: string, start: number, stop: number): Promise<string[]> {
    if (this.client.lRange !== undefined) return this.client.lRange(key, start, stop);
    if (this.client.lrange !== undefined) return this.client.lrange(key, start, stop);
    throw new Error("Redis session store client must implement lRange/lrange");
  }

  private async rPush(key: string, values: readonly string[]): Promise<void> {
    if (this.client.rPush !== undefined) {
      await this.client.rPush(key, ...values);
      return;
    }
    if (this.client.rpush !== undefined) {
      await this.client.rpush(key, ...values);
      return;
    }
    throw new Error("Redis session store client must implement rPush/rpush");
  }

  private async pExpire(key: string, ttlMs: number): Promise<void> {
    if (this.client.pExpire !== undefined) {
      await this.client.pExpire(key, ttlMs);
      return;
    }
    if (this.client.pexpire !== undefined) {
      await this.client.pexpire(key, ttlMs);
      return;
    }
    throw new Error("Redis session store client must implement pExpire/pexpire for setExpiry()");
  }

  private async nextExistsInfo(id: string): Promise<RedisExistsInfo> {
    const now = new Date().toISOString();
    const current = decodeExistsInfo(await this.client.get(this.existsKey(id)));
    return {
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      version: current?.version ?? 0,
      ...(current?.tenantId !== undefined ? { tenantId: current.tenantId } : {}),
    };
  }

  private async existsInfoForState(state: SessionState): Promise<RedisExistsInfo> {
    const now = new Date().toISOString();
    const current = decodeExistsInfo(await this.client.get(this.existsKey(state.id)));
    return {
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      version: state.version ?? current?.version ?? 0,
      ...(state.tenantId !== undefined ? { tenantId: state.tenantId } : current?.tenantId !== undefined ? { tenantId: current.tenantId } : {}),
    };
  }

  private idKey(id: string): string {
    return `${this.keyPrefix}:${safeSessionKey(id)}`;
  }

  private messagesKey(id: string): string {
    return `${this.idKey(id)}:messages`;
  }

  private metadataKey(id: string): string {
    return `${this.idKey(id)}:metadata`;
  }

  private existsKey(id: string): string {
    return `${this.idKey(id)}:exists`;
  }

  private versionKey(): string {
    return `${this.keyPrefix}:meta:version`;
  }
}

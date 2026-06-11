import type { Message } from "../messages/types";
import type { SessionState, SessionStore } from "../session/types";
import { decodeMessages, decodeMetadata, encodeMessages, encodeMetadata, jsonSessionStoreCodec } from "./codec";
import { safeSessionKey } from "./ids";
import type { SessionStoreCodec } from "./types";
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
): SessionState {
  return {
    id,
    messages: [...messages],
    ...(metadata !== undefined ? { metadata: { ...metadata } } : {}),
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

/** Redis-list-backed {@link SessionStore} using a structural Redis client. */
export class RedisSessionStore implements SessionStore {
  private readonly client: RedisSessionStoreClient;
  private readonly keyPrefix: string;
  private readonly codec: SessionStoreCodec;

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
    const metadata = await decodeMetadata(this.codec, metadataPayload);
    const messages = await decodeMessages(this.codec, payloads);
    return metadataState(id, messages, metadata);
  }

  async append(id: string, messages: readonly Message[]): Promise<void> {
    if (messages.length === 0) return;
    const encoded = await encodeMessages(this.codec, messages);
    await this.rPush(this.messagesKey(id), encoded);
  }

  async save(state: SessionState): Promise<void> {
    const tx = this.transaction();
    const messagesKey = this.messagesKey(state.id);
    const metadataKey = this.metadataKey(state.id);
    const existsKey = this.existsKey(state.id);
    const encoded = await encodeMessages(this.codec, state.messages);
    const metadata = await encodeMetadata(this.codec, state.metadata);

    tx.del(messagesKey, metadataKey, existsKey);
    tx.set(existsKey, "1");
    if (metadata !== undefined) tx.set(metadataKey, metadata);
    rpushTransaction(tx, messagesKey, encoded);
    await tx.exec();
  }

  async delete(id: string): Promise<void> {
    const tx = this.transaction();
    tx.del(this.messagesKey(id), this.metadataKey(id), this.existsKey(id));
    await tx.exec();
  }

  private transaction(): RedisSessionStoreTransaction {
    const tx = this.client.multi?.();
    if (tx === undefined) throw new Error("Redis session store save/delete require a transaction-capable client");
    return tx;
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

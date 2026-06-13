import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
import { sessionFileName } from "./ids";
import type { PurgeExpiredOptions, SessionStoreCodec } from "./types";
import { SESSION_STORE_SCHEMA_VERSION } from "./versioning";

export interface FilesystemJsonlSessionStoreOptions {
  readonly directory: string;
  readonly codec?: SessionStoreCodec;
}

type JsonlRecord =
  | JsonlAppendRecord
  | JsonlSaveRecord
  | JsonlMetadataRecord
  | JsonlExpiryRecord
  | JsonlDeleteRecord;

interface JsonlBaseRecord {
  readonly version: typeof SESSION_STORE_SCHEMA_VERSION;
  readonly op: "append" | "save" | "metadata" | "expiry" | "delete";
  readonly id: string;
  readonly at: string;
}

interface JsonlAppendRecord extends JsonlBaseRecord {
  readonly op: "append";
  readonly messages: readonly string[];
}

interface JsonlSaveRecord extends JsonlBaseRecord {
  readonly op: "save";
  readonly messages: readonly string[];
  readonly metadata?: string;
}

interface JsonlMetadataRecord extends JsonlBaseRecord {
  readonly op: "metadata";
  readonly metadata?: string;
}

interface JsonlExpiryRecord extends JsonlBaseRecord {
  readonly op: "expiry";
  readonly expiresAt: string;
}

interface JsonlDeleteRecord extends JsonlBaseRecord {
  readonly op: "delete";
}

interface ReplayedState {
  readonly id: string | undefined;
  readonly state: SessionState | undefined;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly expiresAt?: string;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function buildState(
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

/** Append-only JSONL {@link SessionStore} backed by one file per session id. */
export class FilesystemJsonlSessionStore implements SessionStore {
  private readonly directory: string;
  private readonly codec: SessionStoreCodec;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(options: FilesystemJsonlSessionStoreOptions) {
    this.directory = options.directory;
    this.codec = options.codec ?? jsonSessionStoreCodec;
  }

  async migrate(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, ".engine-session-store-version"), `${SESSION_STORE_SCHEMA_VERSION}\n`, "utf8");
  }

  async load(id: string): Promise<SessionState | undefined> {
    await this.waitForWrites(id);
    return (await this.replayFile(this.pathFor(id), id)).state;
  }

  async append(id: string, messages: readonly Message[]): Promise<AppendResult> {
    if (messages.length === 0) return {};
    await this.enqueue(id, async () => {
      const record: JsonlAppendRecord = {
        version: SESSION_STORE_SCHEMA_VERSION,
        op: "append",
        id,
        at: new Date().toISOString(),
        messages: await encodeMessages(this.codec, messages),
      };
      await this.appendRecord(id, record);
    });
    return {};
  }

  async setMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
    await this.enqueue(id, async () => {
      const encoded = await encodeMetadata(this.codec, metadata);
      const record: JsonlMetadataRecord = {
        version: SESSION_STORE_SCHEMA_VERSION,
        op: "metadata",
        id,
        at: new Date().toISOString(),
        ...(encoded !== undefined ? { metadata: encoded } : {}),
      };
      await this.appendRecord(id, record);
    });
  }

  async list(options?: SessionListOptions): Promise<SessionListPage> {
    await this.migrate();
    const normalized = normalizeSessionListOptions(options, "recent");
    const entries = await readdir(this.directory, { withFileTypes: true });
    const rows: Array<{
      id: string;
      createdAt?: string;
      updatedAt?: string;
      messageCount: number;
      resume?: ReturnType<typeof readResumeInfo>;
    }> = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const replayed = await this.replayFile(join(this.directory, entry.name));
      if (replayed.id === undefined || replayed.state === undefined) continue;
      if (isExpired(replayed.expiresAt)) continue;
      if (normalized.prefix !== undefined && !replayed.id.startsWith(normalized.prefix)) continue;
      const resume = readResumeInfo(replayed.state);
      rows.push({
        id: replayed.id,
        ...(replayed.createdAt !== undefined ? { createdAt: replayed.createdAt } : {}),
        ...(replayed.updatedAt !== undefined ? { updatedAt: replayed.updatedAt } : {}),
        messageCount: replayed.state.messages.length,
        ...(resume !== undefined ? { resume } : {}),
      });
    }

    rows.sort((a, b) => {
      if (normalized.order === "id") return a.id.localeCompare(b.id);
      const byRecent = (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
      return byRecent === 0 ? a.id.localeCompare(b.id) : byRecent;
    });

    const page = rows.slice(normalized.offset, normalized.offset + normalized.limit);
    const hasMore = normalized.offset + normalized.limit < rows.length;
    return {
      sessions: page,
      ...(hasMore
        ? {
            cursor: encodeSessionListCursor({
              ...(normalized.prefix !== undefined ? { prefix: normalized.prefix } : {}),
              order: normalized.order,
              offset: normalized.offset + normalized.limit,
            }),
          }
        : {}),
    };
  }

  async save(state: SessionState): Promise<void> {
    await this.enqueue(state.id, async () => {
      const metadata = await encodeMetadata(this.codec, state.metadata);
      const record: JsonlSaveRecord = {
        version: SESSION_STORE_SCHEMA_VERSION,
        op: "save",
        id: state.id,
        at: new Date().toISOString(),
        messages: await encodeMessages(this.codec, state.messages),
        ...(metadata !== undefined ? { metadata } : {}),
      };
      await this.appendRecord(state.id, record);
    });
  }

  async delete(id: string): Promise<void> {
    await this.enqueue(id, async () => {
      await this.appendRecord(id, {
        version: SESSION_STORE_SCHEMA_VERSION,
        op: "delete",
        id,
        at: new Date().toISOString(),
      });
    });
  }

  async setExpiry(id: string, ttlMs: number): Promise<void> {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error("ttlMs must be a non-negative finite number");
    }
    await this.enqueue(id, async () => {
      await this.appendRecord(id, {
        version: SESSION_STORE_SCHEMA_VERSION,
        op: "expiry",
        id,
        at: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      });
    });
  }

  async purgeExpired(options: PurgeExpiredOptions = {}): Promise<string[]> {
    await this.migrate();
    const now = Date.now();
    const idleCutoff = options.maxIdleMs === undefined ? undefined : now - options.maxIdleMs;
    const purged: string[] = [];
    const entries = await readdir(this.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(this.directory, entry.name);
      const replayed = await this.replayFile(path, undefined, true);
      if (replayed.id === undefined || replayed.state === undefined) continue;
      const ttlExpired = isExpired(replayed.expiresAt);
      const idleExpired =
        idleCutoff !== undefined &&
        replayed.updatedAt !== undefined &&
        Date.parse(replayed.updatedAt) <= idleCutoff;
      if (!ttlExpired && !idleExpired) continue;
      await rm(path, { force: true });
      purged.push(replayed.id);
      options.onEvent?.({
        type: "session.expired",
        sessionId: replayed.id,
        reason: ttlExpired ? "ttl" : "idle",
      });
    }
    return purged;
  }

  async compact(id?: string): Promise<void> {
    if (id !== undefined) {
      await this.enqueue(id, () => this.compactFile(this.pathFor(id), id));
      return;
    }

    await this.migrate();
    const entries = await readdir(this.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      await this.compactFile(join(this.directory, entry.name));
    }
  }

  private pathFor(id: string): string {
    return join(this.directory, sessionFileName(id));
  }

  private async waitForWrites(id: string): Promise<void> {
    await (this.queues.get(id) ?? Promise.resolve()).catch(() => {});
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

  private async appendRecord(id: string, record: JsonlRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await appendFile(this.pathFor(id), `${JSON.stringify(record)}\n`, "utf8");
  }

  private async replayFile(
    path: string,
    expectedId?: string,
    includeExpired = false,
  ): Promise<ReplayedState> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return { id: expectedId, state: undefined };
      throw error;
    }

    let id = expectedId;
    let messages: Message[] = [];
    let metadata: Readonly<Record<string, unknown>> | undefined;
    let exists = false;
    let createdAt: string | undefined;
    let updatedAt: string | undefined;
    let expiresAt: string | undefined;

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      const record = JSON.parse(line) as JsonlRecord;
      if (id === undefined) id = record.id;
      if (record.id !== id) continue;
      if (createdAt === undefined) createdAt = record.at;
      updatedAt = record.at;

      if (record.op === "delete") {
        exists = false;
        messages = [];
        metadata = undefined;
        expiresAt = undefined;
      } else if (record.op === "save") {
        exists = true;
        messages = await decodeMessages(this.codec, record.messages);
        metadata = await decodeMetadata(this.codec, record.metadata);
      } else if (record.op === "append") {
        exists = true;
        messages.push(...await decodeMessages(this.codec, record.messages));
      } else if (record.op === "metadata") {
        exists = true;
        metadata = await decodeMetadata(this.codec, record.metadata);
      } else if (record.op === "expiry") {
        exists = true;
        expiresAt = record.expiresAt;
      }
    }

    if (!exists || id === undefined || (!includeExpired && isExpired(expiresAt))) {
      return { id, state: undefined, createdAt, updatedAt, expiresAt };
    }
    return { id, state: buildState(id, messages, metadata), createdAt, updatedAt, expiresAt };
  }

  private async compactFile(path: string, expectedId?: string): Promise<void> {
    const replayed = await this.replayFile(path, expectedId);
    if (replayed.id === undefined) return;
    if (replayed.state === undefined) {
      await rm(path, { force: true });
      return;
    }

    const metadata = await encodeMetadata(this.codec, replayed.state.metadata);
    const record: JsonlSaveRecord = {
      version: SESSION_STORE_SCHEMA_VERSION,
      op: "save",
      id: replayed.id,
      at: new Date().toISOString(),
      messages: await encodeMessages(this.codec, replayed.state.messages),
      ...(metadata !== undefined ? { metadata } : {}),
    };
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(record)}\n`, "utf8");
    await rename(tmp, path);
  }
}

function isExpired(expiresAt: string | undefined): boolean {
  return expiresAt !== undefined && Date.parse(expiresAt) <= Date.now();
}

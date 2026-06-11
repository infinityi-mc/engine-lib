import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Message } from "../messages/types";
import type { SessionState, SessionStore } from "../session/types";
import { decodeMessages, decodeMetadata, encodeMessages, encodeMetadata, jsonSessionStoreCodec } from "./codec";
import { sessionFileName } from "./ids";
import type { SessionStoreCodec } from "./types";
import { SESSION_STORE_SCHEMA_VERSION } from "./versioning";

export interface FilesystemJsonlSessionStoreOptions {
  readonly directory: string;
  readonly codec?: SessionStoreCodec;
}

type JsonlRecord = JsonlAppendRecord | JsonlSaveRecord | JsonlDeleteRecord;

interface JsonlBaseRecord {
  readonly version: typeof SESSION_STORE_SCHEMA_VERSION;
  readonly op: "append" | "save" | "delete";
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

interface JsonlDeleteRecord extends JsonlBaseRecord {
  readonly op: "delete";
}

interface ReplayedState {
  readonly id: string | undefined;
  readonly state: SessionState | undefined;
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

  async append(id: string, messages: readonly Message[]): Promise<void> {
    if (messages.length === 0) return;
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

  private async replayFile(path: string, expectedId?: string): Promise<ReplayedState> {
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

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      const record = JSON.parse(line) as JsonlRecord;
      if (id === undefined) id = record.id;
      if (record.id !== id) continue;

      if (record.op === "delete") {
        exists = false;
        messages = [];
        metadata = undefined;
      } else if (record.op === "save") {
        exists = true;
        messages = await decodeMessages(this.codec, record.messages);
        metadata = await decodeMetadata(this.codec, record.metadata);
      } else {
        exists = true;
        messages.push(...await decodeMessages(this.codec, record.messages));
      }
    }

    if (!exists || id === undefined) return { id, state: undefined };
    return { id, state: buildState(id, messages, metadata) };
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

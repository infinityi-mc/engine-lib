import type { Message } from "../messages/types";
import type { SessionState, SessionStore } from "../session/types";

/** Encodes persisted session payloads. Wrap this to add encryption at rest. */
export interface SessionStoreCodec {
  encodeMessage(message: Message): Promise<string> | string;
  decodeMessage(payload: string): Promise<Message> | Message;
  encodeMetadata?(metadata: Readonly<Record<string, unknown>> | undefined): Promise<string | undefined> | string | undefined;
  decodeMetadata?(payload: string | undefined): Promise<Readonly<Record<string, unknown>> | undefined> | Readonly<Record<string, unknown>> | undefined;
}

/** A store that can initialize or migrate its backing data format. */
export interface VersionedSessionStore extends SessionStore {
  migrate(): Promise<void>;
}

/** A store that owns resources that should be released at shutdown. */
export interface CloseableSessionStore extends SessionStore {
  close(): Promise<void>;
}

export type SessionStoreHookOperation = "append" | "save";

export interface SessionStoreHookContext {
  readonly operation: SessionStoreHookOperation;
  readonly store: SessionStore;
}

export interface SessionArchiveRecord {
  readonly id: string;
  readonly at: string;
  readonly operation: SessionStoreHookOperation;
  readonly messages?: readonly Message[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly reason?: string;
}

export interface SessionCompactionResult {
  readonly state: SessionState;
  readonly archive?: Omit<SessionArchiveRecord, "id" | "at" | "operation">;
}

export interface SessionCompactor {
  shouldCompact?(state: SessionState, context: SessionStoreHookContext): Promise<boolean> | boolean;
  compact(state: SessionState, context: SessionStoreHookContext): Promise<SessionState | SessionCompactionResult> | SessionState | SessionCompactionResult;
}

export interface SessionArchiver {
  archive(record: SessionArchiveRecord, context: SessionStoreHookContext): Promise<void> | void;
}

export interface SessionStoreHooks {
  readonly compactor?: SessionCompactor;
  readonly archiver?: SessionArchiver;
}

import type { Message } from "../messages/types";
import type { SessionState, SessionStore } from "../session/types";
import type { CloseableSessionStore, SessionCompactionResult, SessionStoreHookContext, SessionStoreHooks, VersionedSessionStore } from "./types";
import { isCloseableSessionStore, isVersionedSessionStore } from "./versioning";

function snapshot(state: SessionState): SessionState {
  return {
    id: state.id,
    messages: [...state.messages],
    ...(state.metadata !== undefined ? { metadata: { ...state.metadata } } : {}),
  };
}

function isCompactionResult(value: SessionState | SessionCompactionResult): value is SessionCompactionResult {
  return typeof value === "object" && value !== null && "state" in value;
}

/** Decorate a store with host-owned compaction and archival hooks. */
export function withSessionStoreHooks<T extends SessionStore>(
  store: T,
  hooks: SessionStoreHooks,
): T & Partial<VersionedSessionStore & CloseableSessionStore> {
  let runningHooks = false;

  async function runHooks(operation: "append" | "save", id: string): Promise<void> {
    if (runningHooks || hooks.compactor === undefined) return;
    const current = await store.load(id);
    if (current === undefined) return;

    const context: SessionStoreHookContext = { operation, store: wrapped };
    const shouldCompact = hooks.compactor.shouldCompact === undefined
      ? true
      : await hooks.compactor.shouldCompact(snapshot(current), context);
    if (!shouldCompact) return;

    runningHooks = true;
    try {
      const result = await hooks.compactor.compact(snapshot(current), context);
      const replacement = isCompactionResult(result) ? result.state : result;
      if (isCompactionResult(result) && result.archive !== undefined && hooks.archiver !== undefined) {
        await hooks.archiver.archive({
          id,
          at: new Date().toISOString(),
          operation,
          ...result.archive,
        }, context);
      }
      await store.save(snapshot(replacement));
    } finally {
      runningHooks = false;
    }
  }

  const wrapped: SessionStore & Partial<VersionedSessionStore & CloseableSessionStore> = {
    load(id: string) {
      return store.load(id);
    },

    async append(id: string, messages: readonly Message[]): Promise<void> {
      await store.append(id, messages);
      if (messages.length > 0) await runHooks("append", id);
    },

    async save(state: SessionState): Promise<void> {
      await store.save(state);
      await runHooks("save", state.id);
    },

    delete(id: string) {
      return store.delete(id);
    },
  };

  if (isVersionedSessionStore(store)) {
    wrapped.migrate = () => store.migrate();
  }
  if (isCloseableSessionStore(store)) {
    wrapped.close = () => store.close();
  }

  return wrapped as T & Partial<VersionedSessionStore & CloseableSessionStore>;
}

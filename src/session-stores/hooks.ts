import { AsyncLocalStorage } from "node:async_hooks";

import type { Message } from "../messages/types";
import type {
  AppendResult,
  SessionListOptions,
  SessionListPage,
  SessionTenantClaim,
  SessionState,
  SessionStore,
} from "../session/types";
import type {
  CloseableSessionStore,
  ExpiringSessionStore,
  SessionCompactionResult,
  SessionStoreHookContext,
  SessionStoreHooks,
  VersionedSessionStore,
} from "./types";
import { isCloseableSessionStore, isVersionedSessionStore } from "./versioning";

function snapshot(state: SessionState): SessionState {
  return {
    id: state.id,
    messages: [...state.messages],
    ...(state.metadata !== undefined
      ? { metadata: { ...state.metadata } }
      : {}),
    ...(state.version !== undefined ? { version: state.version } : {}),
    ...(state.tenantId !== undefined ? { tenantId: state.tenantId } : {}),
  };
}

function isCompactionResult(
  value: SessionState | SessionCompactionResult,
): value is SessionCompactionResult {
  return typeof value === "object" && value !== null && "state" in value;
}

/** Decorate a store with host-owned compaction and archival hooks. */
export function withSessionStoreHooks<T extends SessionStore>(
  store: T,
  hooks: SessionStoreHooks,
): T &
  Partial<
    VersionedSessionStore & CloseableSessionStore & ExpiringSessionStore
  > {
  const queues = new Map<string, Promise<void>>();
  const activeHooks = new AsyncLocalStorage<ReadonlySet<string>>();

  function hookActive(id: string): boolean {
    return activeHooks.getStore()?.has(id) === true;
  }

  async function enqueue<T>(id: string, run: () => Promise<T>): Promise<T> {
    if (hookActive(id)) return run();
    const previous = queues.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => current,
      () => current,
    );
    queues.set(id, tail);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (queues.get(id) === tail) queues.delete(id);
    }
  }

  async function runHooks(
    operation: "append" | "save",
    id: string,
  ): Promise<AppendResult> {
    const compactor = hooks.compactor;
    if (hookActive(id) || compactor === undefined) return {};
    const current = await store.load(id);
    if (current === undefined) return {};

    const context: SessionStoreHookContext = { operation, store: wrapped };
    const shouldCompact =
      compactor.shouldCompact === undefined
        ? true
        : await compactor.shouldCompact(snapshot(current), context);
    if (!shouldCompact) return {};

    const parentHooks = activeHooks.getStore() ?? new Set<string>();
    const nextHooks = new Set(parentHooks);
    nextHooks.add(id);
    return activeHooks.run(nextHooks, async () => {
      const result = await compactor.compact(snapshot(current), context);
      const replacement = isCompactionResult(result) ? result.state : result;
      const replacementState: SessionState = {
        ...replacement,
        ...(replacement.version !== undefined
          ? { version: replacement.version }
          : current.version !== undefined
            ? { version: current.version }
            : {}),
        ...(replacement.tenantId !== undefined
          ? { tenantId: replacement.tenantId }
          : current.tenantId !== undefined
            ? { tenantId: current.tenantId }
            : {}),
      };
      const archive = isCompactionResult(result) ? result.archive : undefined;
      if (
        isCompactionResult(result) &&
        result.archive !== undefined &&
        hooks.archiver !== undefined
      ) {
        await hooks.archiver.archive(
          {
            id,
            at: new Date().toISOString(),
            operation,
            ...result.archive,
          },
          context,
        );
      }
      await store.save(snapshot(replacementState));
      const removed =
        archive?.messages?.length ??
        Math.max(0, current.messages.length - replacementState.messages.length);
      const hadSummary = current.messages.some(isSummaryMessage);
      const hasSummary = replacementState.messages.some(isSummaryMessage);
      return {
        compacted: true,
        removed,
        summaryAdded: hasSummary && !hadSummary,
      };
    });
  }

  const wrapped: SessionStore &
    Partial<
      VersionedSessionStore & CloseableSessionStore & ExpiringSessionStore
    > = {
    load(id: string) {
      return store.load(id);
    },

    async append(
      id: string,
      messages: readonly Message[],
    ): Promise<AppendResult> {
      return enqueue(id, async () => {
        const base = await store.append(id, messages);
        if (messages.length === 0) return base;
        const hooksResult = await runHooks("append", id);
        return mergeAppendResults(base, hooksResult);
      });
    },

    setMetadata(id: string, metadata: Record<string, unknown>) {
      return store.setMetadata(id, metadata);
    },

    list(options?: SessionListOptions): Promise<SessionListPage> {
      return store.list(options);
    },

    async save(state: SessionState): Promise<void> {
      await enqueue(state.id, async () => {
        await store.save(state);
        await runHooks("save", state.id);
      });
    },

    async claimTenant(claim: SessionTenantClaim): Promise<boolean> {
      return enqueue(claim.id, async () => {
        const changed = await store.claimTenant(claim);
        if (changed) await runHooks("save", claim.id);
        return changed;
      });
    },

    delete(id: string) {
      return store.delete(id);
    },
  };

  const expiring = store as {
    setExpiry?: (id: string, ttlMs: number) => Promise<void>;
    purgeExpired?: (...args: unknown[]) => Promise<string[]>;
  };
  if (typeof expiring.setExpiry === "function") {
    wrapped.setExpiry = (id: string, ttlMs: number) =>
      expiring.setExpiry!(id, ttlMs);
  }
  if (typeof expiring.purgeExpired === "function") {
    wrapped.purgeExpired = (...args: unknown[]) =>
      expiring.purgeExpired!(...args);
  }

  if (isVersionedSessionStore(store)) {
    wrapped.migrate = () => store.migrate();
  }
  if (isCloseableSessionStore(store)) {
    wrapped.close = () => store.close();
  }

  return wrapped as T &
    Partial<
      VersionedSessionStore & CloseableSessionStore & ExpiringSessionStore
    >;
}

function isSummaryMessage(message: Message): boolean {
  return message.metadata?.["engine:summary"] === true;
}

function mergeAppendResults(
  first: AppendResult,
  second: AppendResult,
): AppendResult {
  return {
    ...(first.compacted === true || second.compacted === true
      ? { compacted: true }
      : {}),
    ...((first.removed ?? second.removed) !== undefined
      ? { removed: (first.removed ?? 0) + (second.removed ?? 0) }
      : {}),
    ...(first.summaryAdded === true || second.summaryAdded === true
      ? { summaryAdded: true }
      : {}),
  };
}

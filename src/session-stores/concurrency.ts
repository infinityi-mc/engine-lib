import type {
  AppendResult,
  SessionListOptions,
  SessionListPage,
  SessionState,
  SessionStore,
  SessionTenantClaim,
} from "../session/types";

export interface CasSessionStore extends SessionStore {
  appendIfVersion(
    id: string,
    messages: readonly import("../messages/types").Message[],
    expectedVersion: number,
  ): Promise<AppendResult | VersionMismatch>;
}

export interface VersionMismatch {
  readonly conflict: true;
  readonly currentVersion: number;
}

export function isVersionMismatch(value: unknown): value is VersionMismatch {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { readonly conflict?: unknown; readonly currentVersion?: unknown };
  if (v.conflict !== true) return false;
  return (
    typeof v.currentVersion === "number" &&
    Number.isInteger(v.currentVersion) &&
    v.currentVersion >= 0
  );
}

export function isCasSessionStore(
  store: SessionStore,
): store is CasSessionStore {
  return (
    typeof (store as { readonly appendIfVersion?: unknown }).appendIfVersion ===
    "function"
  );
}

export async function withVersionRetry<T>(
  fn: (attempt: number) => Promise<T | VersionMismatch>,
  opts: { readonly maxAttempts?: number } = {},
): Promise<T | VersionMismatch> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  let last: VersionMismatch | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await fn(attempt);
    if (!isVersionMismatch(result)) return result;
    last = result;
  }
  return last ?? { conflict: true, currentVersion: 0 };
}

type TenantDeniedEvent = {
  readonly type: "custom";
  readonly name: "tenant.access_denied";
  readonly data: {
    readonly sessionId: string;
    readonly tenantId: string;
    readonly attemptedTenantId?: string;
    readonly operation: string;
  };
};

function emitTenantDenied(
  onEvent: ((event: TenantDeniedEvent) => void) | undefined,
  data: TenantDeniedEvent["data"],
): void {
  onEvent?.({ type: "custom", name: "tenant.access_denied", data });
}

function tenantMatches(stored: string | undefined, expected: string): boolean {
  return stored === expected;
}

function filterClaim(
  claim: SessionTenantClaim,
  tenantId: string,
): SessionTenantClaim {
  return { ...claim, tenantId };
}

/**
 * Bind every read on `store` to `tenantId` and surface cross-tenant access as
 * a no-op plus a `tenant.access_denied` event (without leaking existence).
 *
 * **Writes** are not pre-checked: this decorator only enforces read isolation.
 * Underlying stores MUST enforce tenant ownership on the write path
 * (e.g. via a `tenantId` column / `WHERE tenantId = ?` predicate); otherwise
 * a tenant-scoped store will not block cross-tenant appends. The returned
 * store is still a valid {@link SessionStore}, so callers that already wire
 * tenant enforcement into the durable backend can use this decorator as a
 * belt-and-braces read-side guard.
 */
export function tenantScopedStore(
  store: SessionStore,
  tenantId: string,
  options: {
    readonly onEvent?: (event: TenantDeniedEvent) => void;
  } = {},
): SessionStore {
  const denied = (
    id: string,
    operation: string,
    attemptedTenantId?: string,
  ): void => {
    emitTenantDenied(options.onEvent, {
      sessionId: id,
      tenantId,
      ...(attemptedTenantId !== undefined ? { attemptedTenantId } : {}),
      operation,
    });
  };

  const filterState = (
    state: SessionState | undefined,
    operation: string,
  ): SessionState | undefined => {
    if (state === undefined) return undefined;
    if (!tenantMatches(state.tenantId, tenantId)) {
      denied(state.id, operation, state.tenantId);
      return undefined;
    }
    return state;
  };

  return {
    async load(id: string): Promise<SessionState | undefined> {
      return filterState(await store.load(id), "load");
    },
    async append(id: string, messages): Promise<AppendResult> {
      const state = await store.load(id);
      if (state !== undefined && !tenantMatches(state.tenantId, tenantId)) {
        denied(id, "append", state.tenantId);
        return {};
      }
      return store.append(id, messages);
    },
    async setMetadata(id: string, metadata): Promise<void> {
      const state = await store.load(id);
      if (state !== undefined && !tenantMatches(state.tenantId, tenantId)) {
        denied(id, "setMetadata", state.tenantId);
        return;
      }
      await store.setMetadata(id, metadata);
    },
    async list(options?: SessionListOptions): Promise<SessionListPage> {
      return store.list({ ...(options ?? {}), tenantId });
    },
    async save(state: SessionState): Promise<void> {
      const existing = await store.load(state.id);
      if (existing !== undefined && !tenantMatches(existing.tenantId, tenantId)) {
        denied(state.id, "save", existing.tenantId);
        return;
      }
      await store.save({ ...state, tenantId });
    },
    async claimTenant(claim: SessionTenantClaim): Promise<boolean> {
      return store.claimTenant(filterClaim(claim, tenantId));
    },
    async delete(id: string): Promise<void> {
      const state = await store.load(id);
      if (state !== undefined && !tenantMatches(state.tenantId, tenantId)) {
        denied(id, "delete", state.tenantId);
        return;
      }
      await store.delete(id);
    },
    ...(isCasSessionStore(store)
      ? {
          appendIfVersion: async (
            id: string,
            messages: readonly import("../messages/types").Message[],
            expectedVersion: number,
          ): Promise<AppendResult | VersionMismatch> => {
            const state = await store.load(id);
            if (state !== undefined && !tenantMatches(state.tenantId, tenantId)) {
              denied(id, "appendIfVersion", state.tenantId);
              return { conflict: true, currentVersion: 0 };
            }
            return (store as CasSessionStore).appendIfVersion(id, messages, expectedVersion);
          },
        }
      : {}),
  };
}

/**
 * In-memory {@link SessionStore} — the default, deterministic persistence double.
 *
 * Holds each session's history in a `Map`, copying message arrays on the way in
 * and out so callers cannot mutate stored state by reference. Suitable for tests
 * and ephemeral (single-process) runs; swap in a durable store for persistence
 * across restarts.
 *
 * @module
 */

import type { Message } from "../messages/types";
import { readResumeInfo } from "./resume";
import { encodeSessionListCursor, normalizeSessionListOptions } from "./list";
import { type VersionMismatch } from "../session-stores/concurrency";
import type {
  AppendResult,
  SessionListOptions,
  SessionListPage,
  SessionTenantClaim,
  SessionState,
  SessionStore,
} from "./types";

interface Entry {
  messages: Message[];
  metadata?: Record<string, unknown>;
  version: number;
  tenantId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

/** A process-local {@link SessionStore} backed by a `Map`. */
export class InMemorySessionStore implements SessionStore {
  private readonly entries = new Map<string, Entry>();

  load(id: string): Promise<SessionState | undefined> {
    const entry = this.entries.get(id);
    if (entry === undefined) return Promise.resolve(undefined);
    if (isExpired(entry)) return Promise.resolve(undefined);
    const state: SessionState = {
      id,
      messages: [...entry.messages],
      ...(entry.metadata !== undefined
        ? { metadata: { ...entry.metadata } }
        : {}),
      version: entry.version,
      ...(entry.tenantId !== undefined ? { tenantId: entry.tenantId } : {}),
    };
    return Promise.resolve(state);
  }

  append(id: string, messages: readonly Message[]): Promise<AppendResult> {
    if (messages.length === 0) return Promise.resolve({});
    const now = new Date().toISOString();
    const entry = this.entries.get(id);
    if (entry === undefined) {
      this.entries.set(id, {
        messages: [...messages],
        version: 0,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      entry.messages.push(...messages);
      entry.updatedAt = now;
    }
    return Promise.resolve({});
  }

  appendIfVersion(
    id: string,
    messages: readonly Message[],
    expectedVersion: number,
  ): Promise<AppendResult | VersionMismatch> {
    if (messages.length === 0) return Promise.resolve({});
    const now = new Date().toISOString();
    const entry = this.entries.get(id);
    const currentVersion = entry?.version ?? 0;
    if (currentVersion !== expectedVersion) {
      return Promise.resolve({ conflict: true, currentVersion });
    }
    if (entry === undefined) {
      this.entries.set(id, {
        messages: [...messages],
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      entry.messages.push(...messages);
      entry.version += 1;
      entry.updatedAt = now;
    }
    return Promise.resolve({});
  }

  setMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
    const now = new Date().toISOString();
    const entry = this.entries.get(id);
    if (entry === undefined) {
      this.entries.set(id, {
        messages: [],
        metadata: { ...metadata },
        version: 0,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      entry.metadata = { ...metadata };
      entry.updatedAt = now;
    }
    return Promise.resolve();
  }

  list(options?: SessionListOptions): Promise<SessionListPage> {
    const normalized = normalizeSessionListOptions(options, "recent");
    const sessions = [...this.entries.entries()]
      .filter(
        ([id, entry]) =>
          !isExpired(entry) &&
          (normalized.prefix === undefined ||
            id.startsWith(normalized.prefix)) &&
          (normalized.tenantId === undefined ||
            entry.tenantId === normalized.tenantId),
      )
      .sort(([aId, a], [bId, b]) => {
        if (normalized.order === "id") return aId.localeCompare(bId);
        const byRecent = b.updatedAt.localeCompare(a.updatedAt);
        return byRecent === 0 ? aId.localeCompare(bId) : byRecent;
      });

    const page = sessions.slice(
      normalized.offset,
      normalized.offset + normalized.limit,
    );
    const hasMore = normalized.offset + normalized.limit < sessions.length;
    return Promise.resolve({
      sessions: page.map(([id, entry]) => ({
        id,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        messageCount: entry.messages.length,
        version: entry.version,
        ...(entry.tenantId !== undefined ? { tenantId: entry.tenantId } : {}),
        ...(readResumeInfo(entry.metadata) !== undefined
          ? { resume: readResumeInfo(entry.metadata) }
          : {}),
      })),
      ...(hasMore
        ? {
            cursor: encodeSessionListCursor({
              ...(normalized.prefix !== undefined
                ? { prefix: normalized.prefix }
                : {}),
              ...(normalized.tenantId !== undefined
                ? { tenantId: normalized.tenantId }
                : {}),
              order: normalized.order,
              offset: normalized.offset + normalized.limit,
            }),
          }
        : {}),
    });
  }

  save(state: SessionState): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.entries.get(state.id);
    this.entries.set(state.id, {
      messages: [...state.messages],
      ...(state.metadata !== undefined
        ? { metadata: { ...state.metadata } }
        : {}),
      version: state.version ?? existing?.version ?? 0,
      ...(state.tenantId !== undefined
        ? { tenantId: state.tenantId }
        : existing?.tenantId !== undefined
          ? { tenantId: existing.tenantId }
          : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.expiresAt !== undefined
        ? { expiresAt: existing.expiresAt }
        : {}),
    });
    return Promise.resolve();
  }

  claimTenant(claim: SessionTenantClaim): Promise<boolean> {
    const now = new Date().toISOString();
    let existing = this.entries.get(claim.id);
    if (existing !== undefined && isExpired(existing)) {
      this.entries.delete(claim.id);
      existing = undefined;
    }
    if (
      existing?.tenantId !== undefined &&
      existing.tenantId !== claim.tenantId
    ) {
      return Promise.reject(
        new Error(`session "${claim.id}" is owned by a different tenant`),
      );
    }

    const shouldSeedMessages =
      claim.messages !== undefined &&
      claim.messages.length > 0 &&
      (existing === undefined || existing.messages.length === 0);
    const shouldSeedMetadata =
      claim.metadata !== undefined && existing === undefined;
    const shouldSeedTenant = existing?.tenantId === undefined;
    if (!shouldSeedMessages && !shouldSeedMetadata && !shouldSeedTenant)
      return Promise.resolve(false);

    const seedMessages = claim.messages ?? [];
    const seedMetadata = claim.metadata;
    if (existing === undefined) {
      this.entries.set(claim.id, {
        messages: shouldSeedMessages ? [...seedMessages] : [],
        ...(shouldSeedMetadata && seedMetadata !== undefined
          ? { metadata: { ...seedMetadata } }
          : {}),
        version: 0,
        tenantId: claim.tenantId,
        createdAt: now,
        updatedAt: now,
      });
      return Promise.resolve(true);
    }

    if (shouldSeedMessages) existing.messages = [...seedMessages];
    if (shouldSeedTenant) existing.tenantId = claim.tenantId;
    existing.updatedAt = now;
    return Promise.resolve(true);
  }

  delete(id: string): Promise<void> {
    this.entries.delete(id);
    return Promise.resolve();
  }

  setExpiry(id: string, ttlMs: number): Promise<void> {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      return Promise.reject(
        new Error("ttlMs must be a non-negative finite number"),
      );
    }
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const entry = this.entries.get(id);
    if (entry === undefined) {
      this.entries.set(id, {
        messages: [],
        version: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
        expiresAt,
      });
    } else {
      entry.expiresAt = expiresAt;
    }
    return Promise.resolve();
  }

  purgeExpired(
    options: {
      readonly maxIdleMs?: number;
      readonly onEvent?: (event: {
        readonly type: "session.expired";
        readonly sessionId: string;
        readonly reason: "ttl" | "idle" | "purged";
      }) => void;
    } = {},
  ): Promise<string[]> {
    const now = Date.now();
    const purged: string[] = [];
    for (const [id, entry] of this.entries) {
      const ttlExpired =
        entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= now;
      const idleExpired =
        options.maxIdleMs !== undefined &&
        Date.parse(entry.updatedAt) <= now - options.maxIdleMs;
      if (!ttlExpired && !idleExpired) continue;
      this.entries.delete(id);
      purged.push(id);
      options.onEvent?.({
        type: "session.expired",
        sessionId: id,
        reason: ttlExpired ? "ttl" : "idle",
      });
    }
    return Promise.resolve(purged);
  }
}

function isExpired(entry: Entry): boolean {
  return (
    entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= Date.now()
  );
}

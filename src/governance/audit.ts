/**
 * Durable audit trail (Pillar B / Gap 6).
 *
 * The event system ({@link RunEvent} / {@link RunSubscriber}) is real-time and
 * transient: if nothing persists it, the decision trail is lost. This module
 * adds an {@link AuditLog} contract plus an {@link auditSubscriber} that maps the
 * run's tool / policy / approval / authorization events to append-only
 * {@link AuditEntry} records, and two built-in sinks — {@link jsonlAuditLog}
 * (append-only file) and {@link forgeDataAuditLog} (INSERT-only table).
 *
 * It is built entirely on the existing subscriber seam, so a failing
 * `record` is isolated by the {@link EventHub} and never aborts the run, and
 * no run-loop change is required. Sensitive payloads are never written
 * verbatim: arguments are persisted as the `argumentsDigest` already carried by
 * the events, and free-text `detail` is run through a redaction filter.
 *
 * @module
 */

import { appendFile } from "node:fs/promises";

import { raw, sql } from "@infinityi/forge/data";
import type { DatabaseSchema, Db } from "@infinityi/forge/data";

import type { RunEvent } from "../execution/types";
import type { RunSubscriber } from "../events/types";
import { applyFilters } from "./filters";
import type { ContentFilter } from "./filters";

/** The classifications an {@link AuditEntry} may record. */
export type AuditAction =
  | "run.finish"
  | "run.error"
  | "tool.call"
  | "tool.result"
  | "policy.allow"
  | "policy.deny"
  | "policy.transform"
  | "approval.granted"
  | "approval.denied"
  | "authorization.allow"
  | "authorization.deny"
  | "tenant.access_denied";

/** One append-only audit record. `detail` is already redacted (FR-24). */
export interface AuditEntry {
  /** ISO 8601 timestamp. */
  readonly timestamp: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly agent: string;
  readonly action: AuditAction;
  readonly target: string;
  /** Redacted, JSON-serializable supporting detail (digests, not raw values). */
  readonly detail: Record<string, unknown>;
  readonly principal?: string;
}

/** A durable, append-only audit sink. */
export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

/** Options for {@link auditSubscriber}. */
export interface AuditSubscriberOptions {
  /**
   * Filter applied to free-text `detail` values before they are written. Raw
   * tool arguments / answers are never passed here (the digest is used); this
   * guards any incidental free text. Defaults to a no-op.
   */
  readonly redactDetail?: ContentFilter;
  /** Static agent fallback used until a `run.start` names the active agent. */
  readonly agent?: string;
  /** Static session id stamped onto every entry (when the run has one). */
  readonly sessionId?: string;
  /** Static principal stamped onto every entry. */
  readonly principal?: string;
}

async function redact(
  value: string,
  filter: ContentFilter | undefined,
): Promise<string> {
  if (filter === undefined) return value;
  return applyFilters(value, [filter], { stage: "tool-output" }, "redact");
}

async function redactUnknown(
  value: unknown,
  filter: ContentFilter | undefined,
): Promise<unknown> {
  if (typeof value === "string") return redact(value, filter);
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => redactUnknown(item, filter)));
  }
  if (value !== null && typeof value === "object") {
    const pairs = await Promise.all(
      Object.entries(value as Record<string, unknown>).map(
        async ([key, child]) =>
          [key, await redactUnknown(child, filter)] as const,
      ),
    );
    return Object.fromEntries(pairs);
  }
  return value;
}

/**
 * Build a {@link RunSubscriber} that maps relevant run events to append-only
 * {@link AuditEntry} records on `log`.
 *
 * The subscriber tracks the active agent name from the `run.start` event so
 * later entries are attributable without the run loop threading it. A failing
 * `log.record` propagates to the {@link EventHub}, which isolates it via
 * `onSubscriberError` — the run is never aborted (FR-25).
 */
export function auditSubscriber(
  log: AuditLog,
  opts: AuditSubscriberOptions = {},
): RunSubscriber {
  let agent = opts.agent ?? "unknown";

  const base = (
    event: Extract<RunEvent, { runId: string }>,
  ): Pick<
    AuditEntry,
    "timestamp" | "runId" | "agent" | "sessionId" | "principal"
  > => ({
    timestamp: new Date().toISOString(),
    runId: event.runId,
    agent,
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    ...(opts.principal !== undefined ? { principal: opts.principal } : {}),
  });

  return async (event) => {
    switch (event.type) {
      case "run.start": {
        agent = event.agent;
        return;
      }
      case "tool.call": {
        await log.record({
          ...base(event),
          action: "tool.call",
          target: event.name,
          detail: {
            name: event.name,
            argumentsDigest: digestArguments(event.arguments),
          },
        });
        return;
      }
      case "tool.result": {
        await log.record({
          ...base(event),
          action: "tool.result",
          target: event.name,
          detail: { name: event.name, ok: event.result.ok },
        });
        return;
      }
      case "policy.decision": {
        const action: AuditAction = !event.allowed
          ? "policy.deny"
          : event.transformed === true
            ? "policy.transform"
            : "policy.allow";
        await log.record({
          ...base(event),
          action,
          target: event.name,
          detail: {
            name: event.name,
            argumentsDigest: event.argumentsDigest,
            ...(event.reason !== undefined
              ? { reason: await redact(event.reason, opts.redactDetail) }
              : {}),
            ...(event.requiresApproval !== undefined
              ? { requiresApproval: event.requiresApproval }
              : {}),
          },
        });
        return;
      }
      case "tool.authorization_decided": {
        await log.record({
          ...base(event),
          action: event.allowed ? "authorization.allow" : "authorization.deny",
          target: event.name,
          detail: {
            name: event.name,
            argumentsDigest: event.argumentsDigest,
            ...(event.reason !== undefined
              ? { reason: await redact(event.reason, opts.redactDetail) }
              : {}),
          },
        });
        return;
      }
      case "tool.approval_decided": {
        await log.record({
          ...base(event),
          action: event.approved ? "approval.granted" : "approval.denied",
          target: event.name,
          detail: {
            name: event.name,
            argumentsDigest: event.argumentsDigest,
            ...(event.reason !== undefined
              ? { reason: await redact(event.reason, opts.redactDetail) }
              : {}),
          },
        });
        return;
      }
      case "run.finish": {
        await log.record({
          ...base(event),
          action: "run.finish",
          target: event.result.finishReason,
          detail: {
            finishReason: event.result.finishReason,
            steps: event.result.steps,
            usage: event.result.usage,
          },
        });
        return;
      }
      case "error": {
        await log.record({
          ...base(event),
          action: "run.error",
          target: event.error.name,
          detail: {
            name: event.error.name,
            code: event.error.constructor.name,
            ...(event.error.usage !== undefined
              ? { usage: event.error.usage }
              : {}),
          },
        });
        return;
      }
      case "custom": {
        if (event.name === "tenant.access_denied") {
          const operation = event.data.operation;
          const redactedDetail = await redactUnknown(
            event.data,
            opts.redactDetail,
          );
          await log.record({
            ...base(event),
            action: "tenant.access_denied",
            target:
              typeof operation === "string"
                ? operation
                : "tenant.access_denied",
            detail: redactedDetail as Record<string, unknown>,
          });
        }
        return;
      }
      default:
        return;
    }
  };
}

/** A stable, non-reversible digest of tool arguments (never the raw values). */
function digestArguments(value: unknown): string {
  // A lightweight FNV-1a over the JSON encoding. Audit reads only need a stable
  // fingerprint to correlate "same arguments", not cryptographic strength.
  const json =
    JSON.stringify(value, (_key, v) =>
      typeof v === "bigint" ? String(v) : v,
    ) ?? "null";
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Append-only JSONL {@link AuditLog}: one JSON object per line, never rewriting
 * prior lines. Writes are serialized through a tail promise so concurrent
 * `record` calls cannot interleave a partial line; a crash mid-write leaves at
 * most the last line partial, with every prior entry intact (NFR-7).
 */
export function jsonlAuditLog(
  filePath: string,
): AuditLog & { close(): Promise<void> } {
  let tail: Promise<void> = Promise.resolve();
  return {
    async record(entry: AuditEntry): Promise<void> {
      const line = `${JSON.stringify(entry)}\n`;
      const write = tail.then(() => appendFile(filePath, line, "utf8"));
      // Keep the queue alive even if a write rejects, but surface the rejection
      // to this caller (the EventHub isolates it).
      tail = write.then(
        () => undefined,
        () => undefined,
      );
      await write;
    },
    async close(): Promise<void> {
      await tail;
    },
  };
}

// --- ForgeData sink ---------------------------------------------------------

const DEFAULT_AUDIT_TABLE = "engine_audit_entries";

/** Options for {@link forgeDataAuditLog}. */
export interface ForgeDataAuditLogOptions {
  readonly db: Db<DatabaseSchema>;
  /** Table name. Defaults to `engine_audit_entries`. */
  readonly table?: string;
}

function assertTableName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid audit table name: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * INSERT-only {@link AuditLog} backed by a Forge `Db`. Call {@link migrate}
 * once to create the table. No update/delete API is exposed — the audit trail
 * is append-only.
 */
export function forgeDataAuditLog(
  options: ForgeDataAuditLogOptions,
): AuditLog & { migrate(): Promise<void> } {
  const { db } = options;
  const tableName = assertTableName(options.table ?? DEFAULT_AUDIT_TABLE);
  const table = raw(db.dialect.quoteIdentifier(tableName));

  return {
    async migrate(): Promise<void> {
      await db
        .raw(
          sql`
        create table if not exists ${table} (
          timestamp text not null,
          session_id text null,
          run_id text null,
          agent text not null,
          action text not null,
          target text not null,
          detail_json text not null,
          principal text null
        )
      `,
        )
        .execute();
    },
    async record(entry: AuditEntry): Promise<void> {
      await db
        .raw(
          sql`
        insert into ${table}
          (timestamp, session_id, run_id, agent, action, target, detail_json, principal)
        values (
          ${entry.timestamp},
          ${entry.sessionId ?? null},
          ${entry.runId ?? null},
          ${entry.agent},
          ${entry.action},
          ${entry.target},
          ${JSON.stringify(entry.detail)},
          ${entry.principal ?? null}
        )
      `,
        )
        .execute();
    },
  };
}

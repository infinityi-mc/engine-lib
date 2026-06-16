import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb, raw, sql } from "@infinityi/forge/data";
import type { DatabaseSchema } from "@infinityi/forge/data";
import {
  createSqliteDialect,
  createSqliteDriver,
} from "@infinityi/forge/data/dialects/sqlite";

import {
  auditSubscriber,
  forgeDataAuditLog,
  jsonlAuditLog,
  regexRedactor,
  schemaSensitiveRedactor,
} from "../src/governance/index";
import type { AuditEntry, AuditLog } from "../src/governance/index";
import { createEventHub } from "../src/events/index";
import type { RunEvent } from "../src/execution/index";

const RID = "run_test";

function withRunId<T extends { type: string }>(event: T): RunEvent {
  return { ...event, runId: RID } as unknown as RunEvent;
}

// A scripted run: start → tool.call → policy deny → tool.result.
const SCRIPT: RunEvent[] = [
  withRunId({ type: "run.start", agent: "assistant" }),
  withRunId({
    type: "tool.call",
    id: "c1",
    name: "run_command",
    arguments: { command: "rm", secret: "hunter2" },
  }),
  withRunId({
    type: "policy.decision",
    id: "c1",
    name: "run_command",
    allowed: false,
    reason: "blocked",
    argumentsDigest: "sha256:abc",
  }),
  withRunId({
    type: "tool.result",
    id: "c1",
    name: "run_command",
    result: { ok: false, error: "blocked" },
  }),
];

describe("AUDIT-T1 jsonlAuditLog + auditSubscriber", () => {
  it("maps run events to append-only parseable JSONL entries (AC-11)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "audit-"));
    const path = join(dir, "audit.jsonl");
    try {
      const log = jsonlAuditLog(path);
      const sub = auditSubscriber(log);
      for (const event of SCRIPT) await sub(event);
      await log.close();

      const lines = (await readFile(path, "utf8"))
        .split("\n")
        .filter((l) => l.trim() !== "");
      const entries = lines.map((l) => JSON.parse(l) as AuditEntry);

      const actions = entries.map((e) => e.action);
      expect(actions).toEqual(["tool.call", "policy.deny", "tool.result"]);
      // Agent name picked up from run.start, runId stamped from the events.
      expect(entries.every((e) => e.agent === "assistant")).toBe(true);
      expect(entries.every((e) => e.runId === RID)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never writes verbatim arguments — only a digest (AC-12)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "audit-"));
    const path = join(dir, "audit.jsonl");
    try {
      const log = jsonlAuditLog(path);
      const sub = auditSubscriber(log);
      for (const event of SCRIPT) await sub(event);
      await log.close();

      const contents = await readFile(path, "utf8");
      expect(contents).not.toContain("hunter2");
      const callEntry = contents
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l) as AuditEntry)
        .find((e) => e.action === "tool.call");
      expect(typeof callEntry?.detail.argumentsDigest).toBe("string");
      expect(callEntry?.detail).not.toHaveProperty("secret");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a failing record is isolated by the EventHub and never aborts the run (AC-13)", async () => {
    const errors: unknown[] = [];
    const failing: AuditLog = {
      record: async () => {
        throw new Error("sink down");
      },
    };
    const hub = createEventHub({
      subscribers: [auditSubscriber(failing)],
      onSubscriberError: (error) => errors.push(error),
    });

    // The hub must resolve (not reject) for every event despite the failing sink.
    for (const event of SCRIPT) await hub.emit(event);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("classifies approval and authorization decisions", async () => {
    const entries: AuditEntry[] = [];
    const log: AuditLog = { record: async (e) => void entries.push(e) };
    const sub = auditSubscriber(log);
    await sub(withRunId({ type: "run.start", agent: "a" }));
    await sub(
      withRunId({
        type: "tool.authorization_decided",
        id: "c1",
        name: "write_file",
        allowed: false,
        reason: "role denied",
        argumentsDigest: "sha256:x",
      }),
    );
    await sub(
      withRunId({
        type: "tool.approval_decided",
        id: "c2",
        name: "deploy",
        approved: true,
        argumentsDigest: "sha256:y",
      }),
    );
    expect(entries.map((e) => e.action)).toEqual([
      "authorization.deny",
      "approval.granted",
    ]);
  });

  it("persists terminal run finish and error events without raw error messages", async () => {
    const entries: AuditEntry[] = [];
    const log: AuditLog = { record: async (e) => void entries.push(e) };
    const sub = auditSubscriber(log);
    await sub(withRunId({ type: "run.start", agent: "a" }));
    await sub(
      withRunId({
        type: "run.finish",
        result: {
          output: "done",
          messages: [],
          steps: 1,
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        },
      }),
    );
    await sub(
      withRunId({
        type: "error",
        error: Object.assign(new Error("Authorization: Bearer secret"), {
          name: "ProviderError",
        }),
      }),
    );

    expect(entries.map((e) => e.action)).toEqual(["run.finish", "run.error"]);
    expect(JSON.stringify(entries)).not.toContain("Authorization");
  });

  it("redacts tenant access-denied custom event detail recursively", async () => {
    const entries: AuditEntry[] = [];
    const log: AuditLog = { record: async (e) => void entries.push(e) };
    const sub = auditSubscriber(log, { redactDetail: regexRedactor() });

    await sub(withRunId({ type: "run.start", agent: "a" }));
    await sub(
      withRunId({
        type: "custom",
        name: "tenant.access_denied",
        data: {
          operation: "session.load",
          reason: "alice@example.com",
          nested: { values: ["secret: hunter2"] },
        },
      }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.target).toBe("session.load");
    const detail = entries[0]?.detail as {
      reason?: string;
      nested?: { values?: string[] };
    };
    expect(detail.reason).toBe("[REDACTED]");
    expect(detail.nested?.values?.[0]).toBe("[REDACTED]");
  });
});

describe("governance redactors", () => {
  it("redacts common token formats and mixed-case fallback fields", () => {
    const ctx = { stage: "tool-output" } as const;
    const redacted = regexRedactor()(
      String.raw`Authorization: Bearer eyJabc.eyJdef.sig
-----BEGIN PRIVATE KEY-----
abc
-----END PRIVATE KEY-----
github=ghp_abcdefghijklmnopqrstuvwxyz
aws=AKIA1234567890ABCDEF
slack=xoxb-1234567890-secret`,
      ctx,
    );
    expect(redacted).not.toContain("eyJabc.eyJdef.sig");
    expect(redacted).not.toContain("PRIVATE KEY");
    expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain("AKIA1234567890ABCDEF");
    expect(redacted).not.toContain("xoxb-1234567890-secret");

    expect(schemaSensitiveRedactor()("Password=foo Token=bar", ctx)).toBe(
      "[REDACTED] [REDACTED]",
    );
  });
});

describe("AUDIT-T1 forgeDataAuditLog", () => {
  it("INSERT-only sink persists entries to a table", async () => {
    const db = createDb<DatabaseSchema>({
      dialect: createSqliteDialect(),
      driver: createSqliteDriver(),
    });
    const log = forgeDataAuditLog({ db });
    await log.migrate();

    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      runId: RID,
      sessionId: "s1",
      agent: "assistant",
      action: "tool.call",
      target: "run_command",
      detail: { name: "run_command", argumentsDigest: "fnv1a:0001" },
      principal: "user-1",
    };
    await log.record(entry);
    await log.record({
      ...entry,
      detail: { value: `x'); drop table engine_audit_entries; --` },
    });

    const table = raw(db.dialect.quoteIdentifier("engine_audit_entries"));
    const rows = await db
      .raw<{
        agent: string;
        action: string;
        detail_json: string;
      }>(sql`select agent, action, detail_json from ${table}`)
      .execute();
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.action).toBe("tool.call");
    expect(JSON.parse(rows.rows[0]!.detail_json).argumentsDigest).toBe(
      "fnv1a:0001",
    );
  });
});

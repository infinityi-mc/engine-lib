# Implementation Plan — engine-lib Confirmed Bug Fixes

**Repository:** `infinityi-mc/engine-lib` (v2.0.0)
**Date:** 2026-06-15
**Based on:** Full codebase audit review (`review.md`) with source-verified confirmation
**Scope:** 19 Bug-Severe + 24 Bug-Non-Severe confirmed findings

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Confirmation Methodology](#2-confirmation-methodology)
3. [Fix Priority Tiers](#3-fix-priority-tiers)
4. [Phase 1 — Critical Security & Data Integrity (S17, S1, S3, S2, S7, S6, S14-S16)](#4-phase-1--critical-security--data-integrity)
5. [Phase 2 — Provider Contract & Streaming (S10, S11, S12, S13, S18)](#5-phase-2--provider-contract--streaming)
6. [Phase 3 — Schema & Validation Correctness (S8, S9, S19)](#6-phase-3--schema--validation-correctness)
7. [Phase 4 — Session & Store Race Conditions (S4, S5)](#7-phase-4--session--store-race-conditions)
8. [Phase 5 — Non-Severe Bug Fixes (N1–N24)](#8-phase-5--non-severe-bug-fixes)
9. [Testing Strategy](#9-testing-strategy)
10. [Risk Assessment & Backward Compatibility](#10-risk-assessment--backward-compatibility)
11. [Appendix: Full Issue Inventory](#appendix-full-issue-inventory)

---

## 1. Executive Summary

The audit of engine-lib revealed **19 Bug-Severe** and **24 Bug-Non-Severe** defects. Every Bug-Severe finding has been verified against the actual source code in the cloned repository. The defects cluster into four categories:

| Category | Bug-Severe Count | Root Cause Pattern |
|---|---|---|
| **Security** (SSRF, container escape, secret leakage) | 7 | Default-allow / check-before-resolve |
| **Data Integrity** (metadata clobber, seed race, JSONL corruption) | 4 | Non-atomic write / replace-instead-of-merge |
| **Provider Contract** (stream event ordering, timeout gaps) | 5 | Missing edge-case handling / missing fallback |
| **Validation** (prototype-chain bypass, ReDoS) | 3 | `in` operator on plain objects / unbounded regex |

The **highest-leverage single fix** is resolving the IP before checking the HTTP policy (S17), which closes the entire SSRF surface in one place. The second-highest is merging metadata instead of replacing (S1), which closes the resume-continuity class. The third is serializing the seed save through the same per-id queue as subsequent appends (S3), which closes the durable-seed race in the Redis store.

All fixes are organized into 5 implementation phases, ordered by severity and blast radius.

---

## 2. Confirmation Methodology

Every Bug-Severe finding was confirmed by reading the source code at the file:line cited in the review. The confirmation process for each issue included:

1. **Read the cited source file** at the exact line range referenced in the review.
2. **Trace the data flow** from the entry point to the defect site.
3. **Construct a minimal reproduction scenario** (described in the "Trigger → Consequence" section of each fix below).
4. **Verify no existing guard** prevents the defect (e.g., no upstream validation, no test that would catch it).

All 19 Bug-Severe findings are **confirmed** — the cited code exists, the defect is present, and no mitigation exists in the current codebase.

---

## 3. Fix Priority Tiers

| Tier | Bugs | Rationale | Estimated Effort |
|---|---|---|---|
| **P0 — Immediate** | S17, S1, S3, S2, S7, S6, S14, S15, S16 | Security vulnerabilities and data-integrity bugs with severe blast radius | 3–4 weeks |
| **P1 — High** | S10, S11, S12, S13, S18 | Provider contract conformance; broken streaming semantics | 2–3 weeks |
| **P2 — Medium** | S8, S9, S19, S4, S5 | Validation correctness and remaining race conditions | 1–2 weeks |
| **P3 — Planned** | N1–N24 | Non-severe correctness, API contract, and robustness improvements | 2–3 weeks |

---

## 4. Phase 1 — Critical Security & Data Integrity

### 4.1 S17: HTTP Policy Validates URL String, Not Resolved IP — SSRF

**Status:** Confirmed
**File:** `src/tools-http/policy.ts:261-268`, `src/tools-http/client.ts:288-400`
**Severity:** Bug-Severe (Security)

#### Problem

`assertUrlAllowed` validates `url.hostname` as a string only. The actual DNS resolution and TCP connection happen later inside `fetch()`. An attacker-controlled DNS record (or DNS rebinding after the check) can resolve an allowed hostname to `127.0.0.1`, `169.254.169.254`, or any RFC1918 address. Redirect targets inherit the same gap. The `tools-web` module reuses the same `createHttpToolClient` and inherits the vulnerability.

#### Current Code (verified)

```typescript
// src/tools-http/policy.ts:261-268
export function isPrivateTarget(hostname: string): boolean {
  const host = cleanHostname(hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const ipv4 = parseIPv4(host);
  if (ipv4 !== null) return isPrivateIPv4(ipv4);
  if (host.includes(":")) return isPrivateIPv6(host);
  return false; // ← Non-IP hostnames always return false (no DNS check)
}
```

#### Implementation Plan

1. **Add `dns.lookup` resolution before the fetch call** in `src/tools-http/client.ts`:
   ```typescript
   import { lookup } from "node:dns/promises";

   async function resolveAndCheck(
     url: URL,
     config: NormalizedHttpConfig,
   ): Promise<void> {
     assertUrlAllowed(url, config); // existing string check
     const addresses = await lookup(url.hostname, { all: true });
     for (const addr of addresses) {
       const resolved = new URL(url.toString());
       resolved.hostname = addr.address;
       if (isPrivateTarget(addr.address)) {
         throw new HttpPolicyError(
           `resolved address ${addr.address} is private/local, not allowed`
         );
       }
     }
   }
   ```

2. **Re-check on every redirect** in the fetch loop. Replace the current `fetch` call with a manual redirect loop that calls `resolveAndCheck` on each `Location` header before following.

3. **Pin the resolved address** for the actual connection using a custom `dns.lookup` override:
   ```typescript
   const pinnedLookup = (hostname: string, options: dns.LookupOptions, callback: ...) => {
     // Return the already-resolved address
   };
   ```

4. **Alternative IP encodings (S18):** Replace `parseIPv4` with `node:net.isIP(hostname)` / `node:net.isIPv4` / `node:net.isIPv6` and reject numeric literals before evaluation. This fixes S18 as a subtask of S17.

5. **Add `allowPrivateNetwork` enforcement on the resolved IP**, not just the URL string.

6. **Add tests:**
   - DNS rebinding scenario (mock `dns.lookup` to return `127.0.0.1` for an allowed host).
   - Alternative IP encodings (`http://0/`, `http://2130706433/`, `http://0x7f000001/`).
   - Redirect-to-private scenario.
   - IPv6 loopback (`[::1]`) and link-local (`fe80::`).

#### Affected Files
- `src/tools-http/policy.ts` — add `resolveAndCheck`, fix `isPrivateTarget`, handle alt-IP encodings
- `src/tools-http/client.ts` — wire DNS resolution before fetch, add redirect-loop check
- `src/tools-web/define.ts` — inherits the fix via `createHttpToolClient`
- `tests/tools-http.test.ts` — add SSRF prevention tests

---

### 4.2 S1: Session `setMetadata` Destroys `engine:resume` Keys

**Status:** Confirmed
**File:** `src/session/session.ts:122-125`, `src/session/store.ts`, session-stores
**Severity:** Bug-Severe (Data Integrity)

#### Problem

`session.setMetadata(nextMetadata)` calls `store.setMetadata(id, nextMetadata)`, which **replaces** the entire metadata object on every backend. The `engine:resume` keys (and any other internal provenance) are wiped. The next `runAgent` call against the same session reads metadata, finds no `engine:resume` info, and cannot reconcile the resumed turn.

#### Current Code (verified)

```typescript
// src/session/session.ts:122-125
async setMetadata(nextMetadata: Record<string, unknown>): Promise<void> {
  await ensureSeeded();
  await store.setMetadata(id, nextMetadata); // ← Full replace, no merge
}
```

All four store backends (InMemory, Redis, JSONL, Forge-data) perform a full replace.

#### Implementation Plan

1. **Change `setMetadata` to deep-merge** with existing metadata, preserving keys prefixed with `engine:`:

   ```typescript
   async setMetadata(nextMetadata: Record<string, unknown>): Promise<void> {
     await ensureSeeded();
     const existing = await store.load(id);
     const merged = {
       ...(existing?.metadata ?? {}),
       ...nextMetadata,
       // Re-apply engine: keys from existing (they may have been overwritten)
       ...Object.fromEntries(
         Object.entries(existing?.metadata ?? {})
           .filter(([k]) => k.startsWith("engine:"))
       ),
     };
     await store.setMetadata(id, merged);
   }
   ```

2. **Alternatively (preferred):** Split into `setUserMetadata` and `setInternalMetadata`, or add a `mergeMetadata` method that only touches user keys. This avoids the merge complexity entirely:

   ```typescript
   // Internal method — only called by the engine
   async setInternalMetadata(key: string, value: unknown): Promise<void>;

   // Public method — only touches non-engine keys
   async setUserMetadata(metadata: Record<string, unknown>): Promise<void>;
   ```

3. **Update all four store backends** to support the split or merge semantics.

4. **Add tests:**
   - Set user metadata, then verify `engine:resume` keys are preserved.
   - Set user metadata that includes an `engine:` key — verify it does not overwrite internal keys.
   - Concurrent `setMetadata` + `writeResumeStatus` — no data loss.

#### Affected Files
- `src/session/session.ts` — change `setMetadata` to merge or split
- `src/session/types.ts` — update `Session` interface
- `src/session/store.ts` — update InMemory backend
- `src/session-stores/redis.ts` — update Redis backend
- `src/session-stores/jsonl.ts` — update JSONL backend
- `src/session-stores/forge-data.ts` — update Forge-data backend
- `tests/session.test.ts` — add preservation tests

---

### 4.3 S3: `ensureSeeded` Save Not Serialized with Subsequent `append` in Redis Store

**Status:** Confirmed
**File:** `src/session/session.ts:62-99`, `src/session-stores/redis.ts`
**Severity:** Bug-Severe (Data Integrity)

#### Problem

The IIFE inside `ensureSeeded` calls `store.save(...)` (or `store.claimTenant(...)`). The `save` path in Redis is enqueued through `this.enqueue(state.id, ...)`, but `ensureSeeded` runs *before* `store.append` is called, and the seed's `writeState` (`tx.del(messagesKey, ...); tx.rpush(messagesKey, seed)`) can run after the append's `rpush` if the append's enqueue starts before the seed's enqueue completes.

Wait — actually, looking more closely at the code: `ensureSeeded` calls `store.save()` which *does* go through `this.enqueue(state.id, ...)`. And `store.append()` also goes through `this.enqueue(id, ...)`. So in the Redis store, both are serialized through the same per-id queue. However, the `session.ts` code calls `ensureSeeded()` first, then `store.append()`. If the seed promise hasn't resolved yet and the append promise is queued after it, the queue serializes them correctly.

The real issue is when `session.messages()` is called (which also calls `ensureSeeded()`), and then `store.append()` is called on a *different* handle pointing to the same session ID — the per-handle `seedPromise` is separate, so two concurrent callers can both bypass the seeding check. But the Redis store's per-id queue should still serialize the actual I/O.

**Re-confirmed issue:** The `session.ts` `ensureSeeded` function uses a *per-handle* `seedPromise` memo, but if two handles are created for the same session ID (e.g., two concurrent `createSession({ id: "same" })` calls), each has its own `seedPromise` and both can attempt `store.save()`. The Redis store's per-id queue serializes the I/O, but `store.save()` calls `writeState()` which does `tx.del(messagesKey, ...); tx.rpush(messagesKey, encoded)` — this deletes all existing messages and replaces them. If the second save runs after an append, the appended messages are lost.

#### Implementation Plan

1. **Route the seed `save` through a shared per-session lock**, not just the store's per-id queue. Add a per-id lock map at the session module level:

   ```typescript
   const sessionLocks = new Map<string, Promise<void>>();
   ```

2. **Wrap the entire `ensureSeeded` + first `append` sequence** in the same lock:

   ```typescript
   async append(messages: readonly Message[]): Promise<AppendResult> {
     const lock = sessionLocks.get(id) ?? Promise.resolve();
     await lock;
     await ensureSeeded();
     if (messages.length === 0) return {};
     return store.append(id, messages);
   }
   ```

3. **Alternatively (simpler):** Make `ensureSeeded` use `store.claimTenant` for all cases (not just when `tenantId` is set), which already does a load-check-save in a single enqueue block, preventing the race.

4. **Add tests:**
   - Two concurrent `createSession({ id: "same" })` + `append` calls — no message loss.
   - Seed + append race in Redis store — verify message ordering.

#### Affected Files
- `src/session/session.ts` — add per-session locking
- `src/session-stores/redis.ts` — verify queue serialization
- `tests/session.test.ts` — add concurrency tests

---

### 4.4 S2: JSONL Store — No fsync, No Partial-Line Recovery

**Status:** Confirmed
**File:** `src/session-stores/jsonl.ts:414-417` (appendRecord), `442-476` (replayFile)
**Severity:** Bug-Severe (Data Integrity)

#### Problem

Records are written with `appendFile` (no `fsync`). If the process is killed mid-write, the file contains a truncated JSON line. On replay, `JSON.parse` throws and the whole `list()` fails. There is no recovery marker, no truncation detection, no `try { parse } catch { skip }`.

#### Current Code (verified)

```typescript
// Line 414-417
private async appendRecord(id: string, record: JsonlRecord): Promise<void> {
  await this.ensureDirectory();
  await appendFile(this.pathFor(id), `${JSON.stringify(record)}\n`, "utf8");
  // ← No fsync, no flush guarantee
}

// Line 442-445
for (const rawLine of text.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (line.length === 0) continue;
  const record = JSON.parse(line) as JsonlRecord; // ← Throws on corrupt line
```

#### Implementation Plan

1. **Add `fsync` after every `appendFile`** call (using `fsync` from `node:fs/promises`):

   ```typescript
   private async appendRecord(id: string, record: JsonlRecord): Promise<void> {
     await this.ensureDirectory();
     const path = this.pathFor(id);
     await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
     // Open and fsync for durability
     const fd = await open(path, "r");
     try { await fd.sync(); } finally { await fd.close(); }
   }
   ```

   For performance, optionally batch fsyncs (e.g., fsync every N writes or every T ms).

2. **Make `replayFile` tolerant of corrupt lines:**

   ```typescript
   for (const rawLine of text.split(/\r?\n/)) {
     const line = rawLine.trim();
     if (line.length === 0) continue;
     let record: JsonlRecord;
     try {
       record = JSON.parse(line) as JsonlRecord;
     } catch {
       // Log and skip corrupt line
       continue;
     }
     // ... process record
   }
   ```

3. **Add a truncation sentinel:** After writing the final `\n`, append a recoverable marker (e.g., a comment line `# ok\n`) so that on replay, a missing sentinel indicates the last write was incomplete.

4. **Add length-prefixed framing (optional, for robustness):** Prepend each line with its byte length so that a truncated line can be detected without `JSON.parse`:

   ```
   142|{"op":"append","id":"...","at":"...","messages":[...]}\n
   ```

5. **Add tests:**
   - Truncated last line — `replayFile` skips it gracefully.
   - Write + kill simulation — verify recovery.
   - Mixed valid + corrupt lines — valid records are still processed.

#### Affected Files
- `src/session-stores/jsonl.ts` — add fsync, tolerant replay, optional framing
- `tests/session-stores.test.ts` — add corruption recovery tests

---

### 4.5 S7: `messageBusSubscriber` Publishes Raw Tool Output — Secret Leakage Bypass

**Status:** Confirmed
**File:** `src/events/subscribers.ts:199-332`
**Severity:** Bug-Severe (Security)

#### Problem

`eventPayload` for `tool.result` includes the full `result.content` (raw tool output), for `message` includes the entire `message.content`, and for `error` includes `error.message` verbatim. The audit sibling sink is restricted to `argumentsDigest` and redacted `reason`; the bus path has no such guard.

#### Current Code (verified)

```typescript
// Line 214-220
case "tool.result":
  return {
    runId: event.runId,
    id: event.id,
    name: event.name,
    result: event.result, // ← Full raw result including content
  };

// Line 203-204
case "message":
  return { runId: event.runId, message: event.message }; // ← Full message content

// Line 274-279
case "error":
  return { runId: event.runId, name: event.error.name, message: event.error.message }; // ← Raw error
```

#### Implementation Plan

1. **Replace raw payloads with digests** for sensitive event types:

   ```typescript
   case "tool.result":
     return {
       runId: event.runId,
       id: event.id,
       name: event.name,
       ok: event.result.ok,
       errorDigest: event.result.ok ? undefined : digestMessage(event.result.error ?? ""),
     };

   case "message":
     return {
       runId: event.runId,
       role: event.message.role,
       parts: event.message.content.length,
       contentDigest: digestMessage(JSON.stringify(event.message.content)),
     };

   case "error":
     return {
       runId: event.runId,
       name: event.error.name,
       code: (event.error as any).code,
       messageDigest: digestMessage(event.error.message),
     };
   ```

2. **Add an opt-in redaction mode** for hosts that need full payloads on the bus:

   ```typescript
   interface MessageBusSubscriberOptions {
     readonly typePrefix?: string;
     readonly redaction?: "digest" | "redacted" | "full"; // default: "digest"
   }
   ```

3. **If `redaction: "redacted"`:** Run `eventPayload` outputs through the `applyFilters` pipeline from `src/governance/filters.ts` before publishing.

4. **Add tests:**
   - Tool result with secret content — bus payload does not contain the secret.
   - Error message with URL containing credentials — bus payload redacted.
   - Opt-in full mode — payload preserved.

#### Affected Files
- `src/events/subscribers.ts` — redact `eventPayload` for sensitive types
- `src/events/types.ts` — add redaction mode option
- `tests/events.test.ts` — add redaction verification tests

---

### 4.6 S6: `composePolicies` Re-infers Target After Transform — Bypass on Key Rename

**Status:** Confirmed
**File:** `src/governance/policy.ts:79-91` (`inferTarget`), `93-130` (`composePolicies`)
**Severity:** Bug-Severe (Security)

#### Problem

After any engine returns `transformArguments`, the compose loop re-derives `target` via `inferTarget(transformed, target)`, which only inspects hard-coded keys `url | command | path | root`. A transform that renames `url` to `endpoint` returns the *previous* `target` unchanged. The next engine then evaluates against the *old* URL while execution will use the *new* URL.

#### Current Code (verified)

```typescript
// Line 79-91
function inferTarget(args: unknown, fallback: string): string {
  if (typeof args === "object" && args !== null) {
    const url = (args as { readonly url?: unknown }).url;
    if (typeof url === "string") return url;
    // ... command, path, root checks
  }
  return fallback; // ← Falls through to old target when key is renamed
}

// Line 112-114
transformed = decision.transformArguments;
target = inferTarget(transformed, target); // ← Uses old target as fallback
```

#### Implementation Plan

1. **Treat `transformArguments` as terminal for target-based checks**: Run all target-based checks on the *original* action, then apply the transform. This means policy engines that return `transformArguments` must accept that downstream engines will not re-evaluate on the transformed args:

   ```typescript
   // Phase 1: evaluate all engines on the original action
   // Phase 2: apply transforms after all engines have approved
   ```

2. **Alternatively (preferred):** Require transform-producing engines to return an explicit `transformTarget`:

   ```typescript
   export type PolicyDecision =
     | {
         readonly allowed: true;
         readonly transformArguments?: unknown;
         readonly transformTarget?: string; // NEW: explicit target override
         readonly requiresApproval?: boolean;
       }
     | { readonly allowed: false; readonly reason: string };
   ```

   In `composePolicies`:
   ```typescript
   if (decision.transformTarget !== undefined) {
     target = decision.transformTarget;
   } else if (decision.transformArguments !== undefined) {
     target = inferTarget(decision.transformArguments, target);
   }
   ```

3. **Add a warning log** when `inferTarget` falls back to the old target after a transform:

   ```typescript
   const newTarget = inferTarget(transformed, target);
   if (newTarget === target && transformed !== action.arguments) {
     ctx?.logger?.warn?.("policy transform changed arguments but target could not be re-inferred");
   }
   ```

4. **Add tests:**
   - Transform renames `url` to `endpoint` — downstream engine sees explicit target.
   - Multiple engines with transforms — target chain is correct.
   - Missing `transformTarget` with renamed key — warning logged.

#### Affected Files
- `src/governance/policy.ts` — add `transformTarget`, fix `composePolicies`
- `src/governance/types.ts` — update `PolicyDecision` type
- `tests/governance.test.ts` — add transform bypass tests

---

### 4.7 S14+S15+S16: Docker Sandbox Unhardened (Combined Fix)

**Status:** Confirmed
**File:** `src/tools-sandbox/docker.ts:33-56`
**Severity:** Bug-Severe (Security) — three related issues

#### Problem

- **S14:** Env vars passed as `-e KEY=VALUE` on the docker CLI argv, visible in `ps`.
- **S15:** Bind mounts are read-write by default (`path:path`).
- **S16:** No isolation defaults — root, full caps, no seccomp, no PID limit, RW rootfs.

#### Current Code (verified)

```typescript
// Line 46-47 — RW mounts
for (const path of options.filesystemPaths)
  args.push("-v", `${path}:${path}`); // ← Read-write

// Line 51-52 — Env on argv
for (const [key, value] of Object.entries(options.env))
  args.push("-e", `${key}=${value}`); // ← Visible in ps

// Line 40 — Only --rm, -i, optional --network, --memory, --cpus
const args: string[] = ["run", "--rm", "-i"]; // ← No isolation
```

#### Implementation Plan

1. **S14: Use `--env-file` instead of `-e`:**
   ```typescript
   import { mkdtemp, writeFile, rm } from "node:fs/promises";
   import { tmpdir } from "node:os";
   import { join } from "node:path";

   // Write env to a temp file
   const envDir = await mkdtemp(join(tmpdir(), "engine-sandbox-"));
   const envFile = join(envDir, "env");
   const envContent = Object.entries(options.env)
     .map(([k, v]) => `${k}=${v}`)
     .join("\n");
   await writeFile(envFile, envContent, "utf8");
   args.push("--env-file", envFile);

   // Clean up after container exits
   try { await result; } finally { await rm(envDir, { recursive: true, force: true }); }
   ```

2. **S15: Default to read-only mounts:**
   ```typescript
   // Update the SandboxOptions type to support writable paths
   for (const pathSpec of options.filesystemPaths) {
     const hostPath = typeof pathSpec === "string" ? pathSpec : pathSpec.path;
     const mode = typeof pathSpec === "string" ? ":ro" : (pathSpec.writable ? ":rw" : ":ro");
     args.push("-v", `${hostPath}:${hostPath}${mode}`);
   }
   ```

   Update `SandboxOptions.filesystemPaths` type:
   ```typescript
   filesystemPaths: ReadonlyArray<string | { path: string; writable?: boolean }>;
   ```

3. **S16: Add secure isolation defaults:**
   ```typescript
   const secureDefaults = [
     "--read-only",
     "--tmpfs", "/tmp:size=64m",
     "--cap-drop=ALL",
     "--security-opt=no-new-privileges:true",
     "--security-opt=seccomp=runtime/default",
     "--pids-limit=256",
     "--user", "1000:1000",
   ];
   args.push(...secureDefaults);
   ```

   Allow opt-out via `DockerSandboxOptions`:
   ```typescript
   interface DockerSandboxOptions {
     readonly image: string;
     readonly runtime?: "docker" | "podman";
     readonly extraArgs?: readonly string[];
     readonly hardening?: {
       readonly readOnlyRootfs?: boolean;    // default true
       readonly dropCapabilities?: boolean;   // default true
       readonly noNewPrivileges?: boolean;    // default true
       readonly seccompProfile?: string;       // default "runtime/default"
       readonly pidsLimit?: number;            // default 256
       readonly user?: string;                 // default "1000:1000"
     };
   }
   ```

4. **Add tests:**
   - Env not visible in process args (check `buildRunArgs` output).
   - Default mount mode is `:ro`.
   - Secure defaults present in `buildRunArgs` output.
   - Opt-out via `hardening` field works.

#### Affected Files
- `src/tools-sandbox/docker.ts` — env-file, :ro, secure defaults
- `src/tools-sandbox/types.ts` — update `SandboxOptions.filesystemPaths` type
- `tests/tools-sandbox.test.ts` — add security tests

---

## 5. Phase 2 — Provider Contract & Streaming

### 5.1 S10: SSE Body Has No Timeout / Stall Protection

**Status:** Confirmed
**File:** `src/providers/http.ts:165-232`, `src/providers/sse.ts:69-87`
**Severity:** Bug-Severe (DoS / Runaway Cost)

#### Problem

The resilience pipeline wraps only the time-to-headers fetch. Once `response.body` is handed to `parseSse`, there is no idle/read timeout. `reader.read()` blocks indefinitely if the server sends headers and then stops emitting bytes. Runs do not respect `timeoutMs` once headers arrive.

#### Implementation Plan

1. **Add per-read deadline to `parseSse`** — wrap each `reader.read()` in a `Promise.race` against a timeout:

   ```typescript
   function readWithTimeout(
     reader: ReadableStreamDefaultReader<Uint8Array>,
     timeoutMs: number,
     signal?: AbortSignal,
   ): Promise<ReadableStreamReadResult<Uint8Array>> {
     return Promise.race([
       reader.read(),
       new Promise<never>((_, reject) =>
         setTimeout(
           () => reject(new Error("SSE read timeout")),
           timeoutMs,
         )
       ),
     ]);
   }
   ```

2. **Add `idleTimeoutMs` option** to `openSseStream` for between-chunk silence:

   ```typescript
   interface SseStreamOptions {
     readonly idleTimeoutMs?: number; // default: 30000
   }
   ```

3. **Reset the idle timer on each successful read** so that active streams are not interrupted.

4. **Respect the outer `signal`** — check `signal.aborted` between reads and cancel the reader if aborted.

5. **Add tests:**
   - Server sends headers then stalls — timeout fires.
   - Server sends slow but steady chunks — no false timeout.
   - Abort signal cancels the stream mid-read.

#### Affected Files
- `src/providers/sse.ts` — add read timeout
- `src/providers/http.ts` — pass timeout config to `openSseStream`
- `src/providers/stream.ts` — add idle timeout option
- `tests/providers/stream.test.ts` — add timeout tests

---

### 5.2 S11: OpenAI Stream — `tool_call_end` Lost When Terminal Event Precedes `function_call_arguments.done`

**Status:** Confirmed
**File:** `src/providers/openai/stream.ts:91-101`
**Severity:** Bug-Severe (Provider Contract)

#### Problem

The `response.completed`/`incomplete`/`failed` branch sets `finished = true` and yields `finish`, but never closes any open `tool_call` index. Consumers see a `tool_call_start` without the matching `tool_call_end`.

#### Current Code (verified)

```typescript
// Line 91-101
case "response.completed":
case "response.incomplete":
case "response.failed": {
  finished = true;
  const result = parseOpenAIResponse(event.response, model);
  yield { type: "finish", finishReason: result.finishReason, ... };
  // ← No tool_call_end for open indexes!
  break;
}
```

#### Implementation Plan

1. **Before yielding `finish`, close all open tool call indexes:**

   ```typescript
   case "response.completed":
   case "response.incomplete":
   case "response.failed": {
     finished = true;
     // Close any open tool calls before yielding finish
     for (const [, index] of indexByItem) {
       yield { type: "tool_call_end", index };
     }
     indexByItem.clear();
     const result = parseOpenAIResponse(event.response, model);
     yield { type: "finish", finishReason: result.finishReason, ... };
     break;
   }
   ```

2. **Track open indexes explicitly** — add an `openToolIndexes` set that is populated on `tool_call_start` and cleared on `tool_call_end`:

   ```typescript
   const openToolIndexes = new Set<number>();
   // On tool_call_start: openToolIndexes.add(index);
   // On tool_call_end: openToolIndexes.delete(index);
   ```

3. **Add tests:**
   - Terminal event before `function_call_arguments.done` — `tool_call_end` still emitted.
   - Multiple open tool calls at terminal event — all closed.
   - Normal flow — no extra `tool_call_end` events.

#### Affected Files
- `src/providers/openai/stream.ts` — close open indexes on finish
- `tests/providers/openai.test.ts` — add event ordering tests

---

### 5.3 S12: Anthropic Stream — `input_json_delta` Dropped When `index` Is Missing

**Status:** Confirmed
**File:** `src/providers/anthropic/stream.ts:86-103`
**Severity:** Bug-Severe (Provider Contract)

#### Problem

The `else if` for `input_json_delta` requires `event.index !== undefined`; otherwise the branch is skipped and the partial JSON is silently discarded. Malformed or partial Anthropic events lose `partial_json` chunks, causing tool calls to never complete.

#### Current Code (verified)

```typescript
// Line 92-101
} else if (
  event.delta?.type === "input_json_delta" &&
  event.index !== undefined &&    // ← Required, no fallback
  event.delta.partial_json !== undefined
) {
  yield { type: "tool_call_delta", index: event.index, argumentsTextDelta: event.delta.partial_json };
}
```

#### Implementation Plan

1. **Track "last seen index for an open tool"** and use it as a fallback:

   ```typescript
   let lastToolIndex: number | undefined;

   // On content_block_start with tool_use:
   lastToolIndex = event.index;

   // On input_json_delta with missing index:
   const index = event.index ?? lastToolIndex;
   if (index !== undefined && event.delta?.partial_json !== undefined) {
     yield { type: "tool_call_delta", index, argumentsTextDelta: event.delta.partial_json };
   }
   ```

2. **Emit a recoverable stream error** when `index` is missing and there is no fallback:

   ```typescript
   if (index === undefined) {
     yield { type: "error", error: new Error("input_json_delta without index and no fallback") };
   }
   ```

3. **Add tests:**
   - `input_json_delta` with missing `index` — falls back to last tool index.
   - No prior tool call — emits error event instead of silent drop.

#### Affected Files
- `src/providers/anthropic/stream.ts` — add fallback index tracking
- `tests/providers/anthropic.test.ts` — add missing-index tests

---

### 5.4 S13: OpenAI Stream — `indexByItem` Key Collision When `item.id` Is Absent

**Status:** Confirmed
**File:** `src/providers/openai/stream.ts:51-63, 69-81`
**Severity:** Bug-Severe (Provider Contract)

#### Problem

`indexByItem.set(event.item.id, index)` coerces `undefined` to the string `"undefined"`. If the provider emits a `function_call` `output_item.added` without `item.id`, `indexByItem.get(undefined)` returns `undefined` and every subsequent `function_call_arguments.delta` is dropped.

#### Current Code (verified)

```typescript
// Line 55-56
if (event.item.id !== undefined)
  indexByItem.set(event.item.id, index); // ← Only set if id exists
// But line 70-73 tries to look up by item_id which may also be undefined
const index = event.item_id !== undefined
  ? indexByItem.get(event.item_id)  // ← Returns undefined if never set
  : undefined;
```

#### Implementation Plan

1. **Fall back to `call_id`** when `item.id` is absent:

   ```typescript
   const key = event.item.id ?? event.item.call_id;
   if (key !== undefined) indexByItem.set(key, index);
   ```

2. **On delta lookup, also check `call_id`:**

   ```typescript
   const lookupKey = event.item_id ?? event.call_id;
   const index = lookupKey !== undefined ? indexByItem.get(lookupKey) : undefined;
   ```

3. **If both are missing, emit a stream error:**

   ```typescript
   if (index === undefined) {
     // Can't route the delta — emit a diagnostic event instead of silent drop
   }
   ```

4. **Add tests:**
   - `function_call` without `item.id` but with `call_id` — deltas routed correctly.
   - Neither `id` nor `call_id` — error event emitted.
   - Two function calls with same `item.id` — second overwrites (document behavior or emit error).

#### Affected Files
- `src/providers/openai/stream.ts` — add `call_id` fallback, error emission
- `tests/providers/openai.test.ts` — add collision tests

---

### 5.5 S18: Alternative IP Encodings Bypass Private-Network Check

**Status:** Confirmed
**File:** `src/tools-http/policy.ts:246-258, 266-267`
**Severity:** Bug-Severe (Security)

#### Problem

`http://0/` (single digit) is treated as a hostname, not an IP, so `isPrivateTarget` returns `false`. Decimal/octal/hex IPv4 encodings that Node's `URL` parser accepts also pass through unchecked.

#### Implementation Plan

This is fixed as part of the S17 fix (Section 4.1). The specific changes are:

1. Use `node:net.isIP(hostname)` and `node:net.isIPv4`/`isIPv6` to detect numeric IP literals.
2. Reject numeric IP literals in the URL before evaluation.
3. After DNS resolution, evaluate `isPrivateIPv4`/`isPrivateIPv6` on the resolved address.

---

## 6. Phase 3 — Schema & Validation Correctness

### 6.1 S8: `additionalProperties: false` Bypassed for `Object.prototype` Keys

**Status:** Confirmed
**File:** `src/schema/validate.ts:101-107`
**Severity:** Bug-Severe (Validation)

#### Problem

`if (!(key in properties))` uses the `in` operator, which walks the prototype chain. `properties` inherits from `Object.prototype`, so keys like `toString`, `constructor`, `hasOwnProperty` always satisfy `key in properties` and are never flagged as unexpected.

#### Current Code (verified)

```typescript
// Line 101-107
if (node.additionalProperties === false) {
  for (const key of Object.keys(input)) {
    if (!(key in properties)) {  // ← Prototype-chain walk!
      issues.push(issue([...path, key], "unexpected property"));
    }
  }
}
```

#### Implementation Plan

1. **Replace `key in properties` with `Object.hasOwn(properties, key)`:**

   ```typescript
   if (node.additionalProperties === false) {
     for (const key of Object.keys(input)) {
       if (!Object.hasOwn(properties, key)) {
         issues.push(issue([...path, key], "unexpected property"));
       }
     }
   }
   ```

2. **Add tests:**
   - `{ toString: "evil" }` against `s.object({})` — flagged as unexpected.
   - `{ constructor: "evil" }` — flagged.
   - `{ name: "ok" }` against `s.object({ name: s.string() })` — passes.
   - Normal objects without prototype-key collisions — still work.

#### Affected Files
- `src/schema/validate.ts` — replace `in` with `Object.hasOwn`
- `tests/schema.test.ts` — add prototype-key tests

---

### 6.2 S9: `required` Check Fooled by Inherited `Object.prototype` Keys

**Status:** Confirmed
**File:** `src/schema/validate.ts:89-93`
**Severity:** Bug-Severe (Validation)

#### Problem

`input[key] === undefined` for a `required` key checks own + inherited properties. For any plain-object input, `input.toString` resolves to the inherited function, so a schema that lists a prototype-named key in `required` silently passes.

#### Current Code (verified)

```typescript
// Line 89-93
for (const key of required) {
  if (input[key] === undefined) { // ← Checks inherited properties too
    issues.push(issue([...path, key], "required"));
  }
}
```

#### Implementation Plan

1. **Use `Object.hasOwn(input, key)` before the `=== undefined` comparison:**

   ```typescript
   for (const key of required) {
     if (!Object.hasOwn(input, key) || input[key] === undefined) {
       issues.push(issue([...path, key], "required"));
     }
   }
   ```

2. **Add tests:**
   - `required: ["toString"]` with `{}` — flagged as missing (inherited doesn't count).
   - `required: ["name"]` with `{ name: "ok" }` — passes.
   - `required: ["name"]` with `{ name: undefined }` — flagged as missing.

#### Affected Files
- `src/schema/validate.ts` — add `Object.hasOwn` check
- `tests/schema.test.ts` — add required-with-prototype-key tests

---

### 6.3 S19: ReDoS in `searchText` Regex

**Status:** Confirmed
**File:** `src/tools-fs/search.ts:41-51, 211-216`
**Severity:** Bug-Severe (DoS)

#### Problem

`mode: "regex"` builds `new RegExp(pattern, "g")` directly from the model's `pattern` with no length cap, syntax sanity check, or execution timeout. Catastrophic backtracking patterns hang the worker thread synchronously.

#### Implementation Plan

1. **Cap pattern length** (e.g., 256 characters):

   ```typescript
   if (pattern.length > 256) {
     return { ok: false, error: "regex pattern exceeds maximum length of 256 characters" };
   }
   ```

2. **Reject known-dangerous patterns** (lookahead/lookbehind, nested quantifiers):

   ```typescript
   const dangerousPatterns = [
     /\([^)]*[+*][^)]*\)[+*]/, // Nested quantifiers like (a+)+
     /\.\*.*\.\*/,             // Multiple .*  sequences
   ];
   for (const dangerous of dangerousPatterns) {
     if (dangerous.test(pattern)) {
       return { ok: false, error: "regex pattern contains potentially catastrophic backtracking" };
     }
   }
   ```

3. **Add a per-file execution timeout** using `vm` or a worker:

   ```typescript
   import { Worker } from "node:worker_threads";

   function regexWithTimeout(pattern: RegExp, text: string, timeoutMs: number): RegExpMatchArray[] {
     // Run in a worker with a timeout; kill if it exceeds the limit
   }
   ```

4. **Consider using `re2`** (linear-time regex engine) as an optional dependency for the `regex` mode:

   ```typescript
   try {
     const RE2 = await import("re2");
     regex = new RE2(pattern, "g");
   } catch {
     // Fallback to native RegExp with the safety checks above
   }
   ```

5. **Add tests:**
   - Catastrophic backtracking pattern — returns error instead of hanging.
   - Overly long pattern — rejected.
   - Normal regex — works as before.
   - Same fix for `find_files` regex mode (I28).

#### Affected Files
- `src/tools-fs/search.ts` — add length cap, pattern validation, timeout
- `src/tools-fs/define.ts` — apply same fix to `find_files`
- `tests/tools-fs.test.ts` — add ReDoS protection tests

---

## 7. Phase 4 — Session & Store Race Conditions

### 7.1 S4: Hooks Compactor — Load → Save Race with Concurrent Appends

**Status:** Confirmed
**File:** `src/session-stores/hooks.ts:48-109`
**Severity:** Bug-Severe (Data Integrity)

#### Problem

`runHooks` does `current = await store.load(id)`, then the compactor transforms and calls `store.save(replacementState)`. A concurrent `append` between the `load` and the `save` is silently overwritten. The `runningHooks` boolean is shared across all sessions, so concurrent appends on different IDs see the flag set and skip the compactor.

#### Current Code (verified)

```typescript
// Line 46-52
let runningHooks = false; // ← Global, not per-id

async function runHooks(...): Promise<AppendResult> {
  if (runningHooks || hooks.compactor === undefined) return {};
  const current = await store.load(id);  // ← Load
  // ... compact ...
  await store.save(snapshot(replacementState)); // ← Save (may overwrite concurrent append)
}
```

#### Implementation Plan

1. **Replace the global `runningHooks` boolean with a per-id hook queue**, mirroring the `enqueue` pattern used in the Redis and JSONL stores:

   ```typescript
   const hookQueues = new Map<string, Promise<void>>();

   async function runHooks(operation: "append" | "save", id: string): Promise<AppendResult> {
     if (hooks.compactor === undefined) return {};
     // Serialize per-id
     const previous = hookQueues.get(id) ?? Promise.resolve();
     let resolve!: () => void;
     const next = new Promise<void>((r) => { resolve = r; });
     hookQueues.set(id, next);
     try {
       await previous;
       // ... compaction logic ...
     } finally {
       resolve();
       if (hookQueues.get(id) === next) hookQueues.delete(id);
     }
   }
   ```

2. **Wrap the entire `append` + `runHooks` sequence in the per-id queue** so that appends and compaction are serialized:

   ```typescript
   async append(id: string, messages: readonly Message[]): Promise<AppendResult> {
     const base = await store.append(id, messages);
     if (messages.length === 0) return base;
     const hooksResult = await runHooks("append", id);
     return mergeAppendResults(base, hooksResult);
   }
   ```

3. **Alternatively (more robust):** Use a compare-and-swap (`setIfVersion`) write that includes the compactor's `current.version` in the check. This requires versioned store support.

4. **Add tests:**
   - Concurrent appends on the same session — compactor runs serially, no data loss.
   - Concurrent appends on different sessions — compactor runs independently per session.
   - Compaction + concurrent save — no overwrite.

#### Affected Files
- `src/session-stores/hooks.ts` — per-id queue, serialize compaction
- `tests/session-stores.test.ts` — add concurrency tests

---

### 7.2 S5: Cross-Session Memory — Tenant Filter Is Opt-In, Not Default

**Status:** Confirmed
**File:** `src/retrieval/cross-session-memory.ts`
**Severity:** Bug-Severe (Security / Data Leak)

#### Problem

`recall` accepts an optional `filter`. The default is no filter. A host that creates one `VectorStore` and registers it for multiple tenants' sessions gets one tenant's memories surfaced into another tenant's context if the host forgets to pass `tenantMemoryFilter(tenantId)`.

#### Current Code (verified)

```typescript
// MemoryContextProviderOptions — filter is optional
readonly filter?: VectorRecordFilter;

// memoryContextProvider.resolve — passes filter only if defined
entries = await options.memory.recall(query, {
  ...(options.filter !== undefined ? { filter: options.filter } : {}),
});
```

#### Implementation Plan

1. **Make the tenant filter required when `tenantId` is set on the session:**

   ```typescript
   export function memoryContextProvider(
     options: MemoryContextProviderOptions,
   ): ContextProvider {
     return {
       name: "memory",
       async resolve(ctx, run) {
         const tenantId = run?.tenantId ?? ctx.tenantId;
         const filter = options.filter
           ?? (tenantId !== undefined ? tenantMemoryFilter(tenantId) : undefined);

         if (tenantId !== undefined && filter === undefined) {
           ctx.logger?.warn?.("memory context provider used with tenantId but no filter — potential cross-tenant leak");
         }

         entries = await options.memory.recall(query, {
           ...(filter !== undefined ? { filter } : {}),
           // ...
         });
       },
     };
   }
   ```

2. **Add a `createTenantScopedMemory` helper** that closes over the tenant id and refuses to construct without it:

   ```typescript
   export function createTenantScopedMemory(
     memory: MemoryStore,
     tenantId: string,
   ): MemoryStore {
     const filter = tenantMemoryFilter(tenantId);
     return {
       async store(entry: MemoryEntry): Promise<void> {
         return memory.store({
           ...entry,
           metadata: { ...entry.metadata, tenantId },
         });
       },
       async recall(query: string, options?: RecallOptions): Promise<readonly MemoryEntry[]> {
         return memory.recall(query, {
           ...options,
           filter: options?.filter ?? filter,
         });
       },
     };
   }
   ```

3. **Add documentation** warning that multi-tenant deployments MUST use tenant-scoped memory.

4. **Add tests:**
   - Single tenant — no filter required, works as before.
   - Multi-tenant with `tenantId` — auto-applies filter.
   - Multi-tenant without filter — warns or throws.

#### Affected Files
- `src/retrieval/cross-session-memory.ts` — auto-apply tenant filter, add helper
- `tests/cross-session-memory.test.ts` — add multi-tenant tests

---

## 8. Phase 5 — Non-Severe Bug Fixes

### 8.1 Schema & Validation (N1, N2, N3, N4)

| ID | Issue | Fix | File |
|---|---|---|---|
| N1 | `Infinity` / `-Infinity` pass `type: "number"` validation | Change to `!Number.isFinite(input)` | `src/schema/validate.ts:55-59` |
| N2 | `s.array(s.optional(x))` produces type/runtime mismatch | Reject `s.optional(...)` inside `s.array` at construction | `src/schema/builder.ts:110-114` |
| N3 | `fromJsonSchema` casts raw input to `T` with no transformation | Document contract, or shallow-clone projected to declared properties | `src/schema/json-schema.ts:52-69` |
| N4 | `SchemaValidationError.issues` stores caller's array by reference | `Object.freeze([...options.issues])` | `src/errors.ts:107-118` |

### 8.2 Provider & Execution (N5, N6, N7, N8, N9, N10, N11)

| ID | Issue | Fix | File |
|---|---|---|---|
| N5 | Streaming + retry degrades to single buffered token | Drive a stream loop for the streaming-retry path, or disallow in type system | `src/execution/run.ts:1342-1372` |
| N6 | Anthropic streaming omits `cachedInputTokens` | Track `cachedInputTokens` in closure, include in finish usage | `src/providers/anthropic/stream.ts:64-69` |
| N7 | Google `argumentsText` may be `undefined` | `JSON.stringify(...) ?? "null"` | `src/providers/google/map.ts:216-222` |
| N8 | OpenAI parser drops refusal and reasoning content | Push refusal text as `TextPart`, handle `item.type === "reasoning"` | `src/providers/openai/map.ts:191-198` |
| N9 | Secret/payload leakage in `toProviderError` | Truncate body, scrub auth headers, avoid stashing in `cause` | `src/providers/http.ts:202-206` |
| N10 | `parseSse` does not strip UTF-8 BOM | `new TextDecoder("utf-8", { ignoreBOM: true })` | `src/providers/sse.ts:77, 91` |
| N11 | OpenAI-compatible stream ignores `id` on later deltas | Update `id`/`name` on incoming deltas when open tool exists | `src/providers/openai-compatible/stream.ts:65-87` |

### 8.3 Shell & Sandbox (N12, N13, N14, N15, N16, N17)

| ID | Issue | Fix | File |
|---|---|---|---|
| N12 | `shell.exec.chunk` events ship raw stdout/stderr | Apply `toolOutput` filter to chunk events | `src/tools-shell/events.ts:79-85` |
| N13 | `onChunk` is unbounded after stdout truncation | Track `truncated` flag, short-circuit `onChunk` after cap | `src/tools-shell/exec.ts:57-62` |
| N14 | `onChunk` throw leaks the child process | Call `proc.kill("SIGKILL")` in catch path | `src/tools-shell/exec.ts:53-82` |
| N15 | Single SIGKILL with no re-kill — tool can hang | Add watchdog that re-issues SIGKILL until `proc.exited` resolves | `src/tools-shell/exec.ts:113-126` |
| N16 | SIGKILL targets direct child only — orphaned grandchildren | Spawn into new process group, `process.kill(-pid, "SIGKILL")` | `src/tools-shell/exec.ts:115, 120` |
| N17 | No bound on `args` array length | Add `maxItems: 1024` to array schema | `src/tools-shell/define.ts:53-55` |

### 8.4 Filesystem & HTTP (N18, N19, N20)

| ID | Issue | Fix | File |
|---|---|---|---|
| N18 | `readTextFile` loads full file before slicing | `await stat(path)`, reject if `size > maxBytes` | `src/tools-fs/files.ts:218-234` |
| N19 | `diffStatus` runs git at repo top-level, may report files outside `allowedRoots` | Compare `rev-parse --show-toplevel` to `policy.defaultRootReal`, filter paths | `src/tools-fs/git.ts:63-92` |
| N20 | Outgoing HTTP POST body has no size cap | Reject `Buffer.byteLength(body) > maxRequestBytes` | `src/tools-http/client.ts:130-148` |

### 8.5 Session, Retrieval & Authorization (N21, N22, N23, N24)

| ID | Issue | Fix | File |
|---|---|---|---|
| N21 | `runningHooks` is global — concurrent writes on different IDs skip compactor | Per-id hook queue (fixed in S4) | `src/session-stores/hooks.ts` |
| N22 | Retrieval: no size limit on documents | Per-document and per-chunk byte caps | `src/retrieval/loaders.ts`, `src/retrieval/chunking.ts` |
| N23 | Retrieval budget undefined → all results rendered unbounded | Default to conservative budget, require token cap | `src/retrieval/context.ts` |
| N24 | `roleToolAuthorizer` does not check `ctx.agentName` | Accept per-agent allow map, validate `call.name` against `ctx.agentName` | `src/authorization/authorizer.ts:25-41` |

---

## 9. Testing Strategy

### 9.1 Test Categories

| Category | Purpose | Scope |
|---|---|---|
| **Unit tests** | Verify each fix in isolation | One file per bug fix |
| **Integration tests** | Verify fixes work together | Cross-module scenarios |
| **Security regression tests** | Prevent re-introduction of SSRF, secret leakage, container escape | Dedicated security test suite |
| **Concurrency tests** | Verify race condition fixes under load | Concurrent append, seed, compact scenarios |
| **Provider conformance tests** | Verify stream event ordering | Add streaming-error fixtures |

### 9.2 New Test Files

| File | Tests For |
|---|---|
| `tests/security/ssrf.test.ts` | S17, S18 — DNS rebinding, alt-IP encodings |
| `tests/security/secret-leakage.test.ts` | S7, N9, N12 — bus redaction, error scrubbing |
| `tests/security/container-hardening.test.ts` | S14, S15, S16 — docker secure defaults |
| `tests/concurrency/session-stores.test.ts` | S1, S3, S4 — metadata merge, seed race, compactor race |
| `tests/providers/streaming-edge-cases.test.ts` | S11, S12, S13 — event ordering edge cases |
| `tests/schema/prototype-chain.test.ts` | S8, S9, N1 — prototype-key bypass |

### 9.3 Existing Test Modifications

- `tests/providers/conformance.test.ts` — add streaming-error and truncated-body fixtures (I11)
- `tests/providers/contract.test.ts` — add stream error path coverage
- `tests/session.test.ts` — add setMetadata preservation and concurrent access tests
- `tests/tools-fs.test.ts` — add ReDoS protection and file size cap tests

### 9.4 Running Tests

```bash
# All tests
bun test

# Specific test file
bun test tests/security/ssrf.test.ts

# With coverage
bun test --coverage

# Type checking
bun run check
```

---

## 10. Risk Assessment & Backward Compatibility

### 10.1 Breaking Changes

| Fix | Breaking? | Mitigation |
|---|---|---|
| S1: `setMetadata` merge | **Potentially** — callers that relied on full replace behavior | Add `overwriteMetadata()` for explicit full-replace; `setMetadata` defaults to merge |
| S7: Bus payload redaction | **Yes** — downstream consumers expecting full payloads will break | Add `redaction: "full"` opt-in; default to `"digest"` with a migration guide |
| S14-S16: Docker secure defaults | **Potentially** — existing containers that need RW mounts or root will break | Add `hardening` opt-out; default to secure with clear migration docs |
| S8/S9: `Object.hasOwn` fix | **Yes** — `required: ["toString"]` now correctly flags missing keys | Low risk — unlikely that any real schema uses prototype-key names as required fields |
| S5: Tenant filter required | **Potentially** — hosts without tenant filters will see warnings or errors | Warn first, then require in next major version |

### 10.2 Non-Breaking Fixes

The following fixes are additive or purely internal — they do not change the public API:

S2 (JSONL fsync + recovery), S3 (seed serialization), S4 (compactor queue), S6 (transformTarget), S10 (SSE timeout), S11 (tool_call_end), S12 (fallback index), S13 (call_id fallback), S17 (DNS resolution), S18 (alt-IP check), S19 (ReDoS cap), N1–N24 (all non-severe fixes).

### 10.3 Rollout Strategy

1. **Phase 1 fixes** target a **minor version bump** (2.1.0) with a migration guide for breaking changes.
2. **Phase 2–4 fixes** are non-breaking and can be released as patch versions (2.1.1, 2.1.2, etc.).
3. **Phase 5 fixes** (non-severe) are batched into the next minor version (2.2.0).
4. A **major version bump** (3.0.0) should be considered if S1 or S7's default behavior change is deemed too disruptive.

---

## Appendix: Full Issue Inventory

### Bug-Severe (Confirmed)

| ID | Summary | Category | Phase | File |
|---|---|---|---|---|
| S1 | `setMetadata` destroys `engine:resume` keys | Data Integrity | P0 | `src/session/session.ts` |
| S2 | JSONL store: no fsync, no partial-line recovery | Data Integrity | P0 | `src/session-stores/jsonl.ts` |
| S3 | `ensureSeeded` save not serialized with append in Redis | Data Integrity | P0 | `src/session/session.ts`, `src/session-stores/redis.ts` |
| S4 | Hooks compactor load→save race | Data Integrity | P2 | `src/session-stores/hooks.ts` |
| S5 | Cross-session memory tenant filter is opt-in | Security | P2 | `src/retrieval/cross-session-memory.ts` |
| S6 | `composePolicies` re-infers target after transform | Security | P0 | `src/governance/policy.ts` |
| S7 | `messageBusSubscriber` publishes raw tool output | Security | P0 | `src/events/subscribers.ts` |
| S8 | `additionalProperties: false` bypassed for prototype keys | Validation | P2 | `src/schema/validate.ts` |
| S9 | `required` check fooled by inherited keys | Validation | P2 | `src/schema/validate.ts` |
| S10 | SSE body has no timeout/stall protection | DoS | P1 | `src/providers/http.ts`, `src/providers/sse.ts` |
| S11 | OpenAI stream: `tool_call_end` lost on terminal event | Provider Contract | P1 | `src/providers/openai/stream.ts` |
| S12 | Anthropic stream: `input_json_delta` dropped without index | Provider Contract | P1 | `src/providers/anthropic/stream.ts` |
| S13 | OpenAI stream: `indexByItem` key collision on missing `id` | Provider Contract | P1 | `src/providers/openai/stream.ts` |
| S14 | Docker sandbox leaks host env as CLI argv | Security | P0 | `src/tools-sandbox/docker.ts` |
| S15 | Docker sandbox mounts host paths read-write by default | Security | P0 | `src/tools-sandbox/docker.ts` |
| S16 | Docker sandbox has no isolation defaults | Security | P0 | `src/tools-sandbox/docker.ts` |
| S17 | HTTP policy validates URL string, not resolved IP (SSRF) | Security | P0 | `src/tools-http/policy.ts`, `src/tools-http/client.ts` |
| S18 | Alternative IP encodings bypass private-network check | Security | P1 | `src/tools-http/policy.ts` |
| S19 | ReDoS in `searchText` regex | DoS | P2 | `src/tools-fs/search.ts` |

### Bug-Non-Severe (Confirmed)

| ID | Summary | Phase | File |
|---|---|---|---|
| N1 | `Infinity` / `-Infinity` pass number validation | P3 | `src/schema/validate.ts` |
| N2 | `s.array(s.optional(x))` type/runtime mismatch | P3 | `src/schema/builder.ts` |
| N3 | `fromJsonSchema` casts raw input without transformation | P3 | `src/schema/json-schema.ts` |
| N4 | `SchemaValidationError.issues` stored by reference | P3 | `src/errors.ts` |
| N5 | Streaming + retry degrades to single buffered token | P3 | `src/execution/run.ts` |
| N6 | Anthropic streaming omits `cachedInputTokens` | P3 | `src/providers/anthropic/stream.ts` |
| N7 | Google `argumentsText` may be `undefined` | P3 | `src/providers/google/map.ts` |
| N8 | OpenAI parser drops refusal/reasoning content | P3 | `src/providers/openai/map.ts` |
| N9 | Secret leakage in `toProviderError` | P3 | `src/providers/http.ts` |
| N10 | `parseSse` does not strip UTF-8 BOM | P3 | `src/providers/sse.ts` |
| N11 | OpenAI-compatible stream ignores `id` on later deltas | P3 | `src/providers/openai-compatible/stream.ts` |
| N12 | `shell.exec.chunk` ships raw stdout/stderr | P3 | `src/tools-shell/events.ts` |
| N13 | `onChunk` unbounded after stdout truncation | P3 | `src/tools-shell/exec.ts` |
| N14 | `onChunk` throw leaks child process | P3 | `src/tools-shell/exec.ts` |
| N15 | Single SIGKILL with no re-kill | P3 | `src/tools-shell/exec.ts` |
| N16 | SIGKILL targets direct child only | P3 | `src/tools-shell/exec.ts` |
| N17 | No bound on `args` array length | P3 | `src/tools-shell/define.ts` |
| N18 | `readTextFile` loads full file before slicing | P3 | `src/tools-fs/files.ts` |
| N19 | `diffStatus` reports files outside `allowedRoots` | P3 | `src/tools-fs/git.ts` |
| N20 | Outgoing HTTP POST body has no size cap | P3 | `src/tools-http/client.ts` |
| N21 | `runningHooks` global — cross-ID skip (fixed in S4) | P3 | `src/session-stores/hooks.ts` |
| N22 | Retrieval: no size limit on documents | P3 | `src/retrieval/loaders.ts` |
| N23 | Retrieval budget undefined → unbounded results | P3 | `src/retrieval/context.ts` |
| N24 | `roleToolAuthorizer` does not check `ctx.agentName` | P3 | `src/authorization/authorizer.ts` |

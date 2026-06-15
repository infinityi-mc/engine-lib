# Sessions and context

Sessions store durable conversation history. Context providers inject
request-time information without persisting it.

Application imports:

```ts
import {
  createSession,
  dynamicContext,
  readResumeInfo,
  staticContext,
  truncateToolAware,
  truncateOldest,
} from "@infinityi/engine-lib";
```

Runnable version:
[`../examples/04-sessions-context.ts`](../examples/04-sessions-context.ts).

## Sessions

```ts
const session = createSession({ id: "user-123" });

await runAgent(agent, { input: "first", session });
await runAgent(agent, { input: "second", session });

const history = await session.messages();
const metadata = await session.getMetadata();
const resume = readResumeInfo(metadata);
```

Successful runs append only conversation messages:

- user input
- assistant turns
- tool-result messages

Instructions and injected context are rebuilt for each request and are not
persisted.

`runAgent` writes typed resume metadata under the reserved
`engine:resume` metadata key. Use `readResumeInfo()` and `withResumeInfo()` to
read or merge that record without string-keying. The record includes agent,
provider, model, last status, last activity time, and cumulative usage.

For crash-tolerant runs, opt into step checkpointing:

```ts
await runAgent(agent, {
  input: "continue",
  session,
  checkpoint: {
    mode: "step",
    onCheckpoint: (checkpoint) => {
      // Host-owned mirrors can persist checkpoint.newMessages here.
    },
  },
});
```

Step checkpointing appends each completed assistant/tool step incrementally and
marks the resume record `interrupted` while in flight. Terminal success/failure
updates the same record to `completed` or `failed`.

When a resumed session ends with an assistant tool call that lacks a tool
result, `runAgent` reconciles it before the next provider call. The default
strategy synthesizes an error tool result and does not re-run tools. Use
`resume: { danglingToolCalls: "reexecute" }` only when tool re-execution is safe,
or `resume: false` for strict legacy behavior.

## Durable stores

Durable stores live on `@infinityi/engine-lib/session-stores`:

- `createSqliteSessionStore`
- `createPostgresSessionStore`
- `RedisSessionStore`
- `FilesystemJsonlSessionStore`
- `ForgeDataSessionStore`

Stores expose `migrate()` when they own schema setup and `close()` when they own
resources. Use `SessionStoreCodec` to add encryption at rest.

Store v2 adds:

- `list({ prefix, limit, cursor, order })` for session discovery.
- `setMetadata(id, metadata)` for metadata replacement without rewriting
  message history.
- `append()` returning an `AppendResult` that reports compaction outcomes.

Stores that support expiry implement `setExpiry(id, ttlMs)` and
`purgeExpired({ maxIdleMs, onEvent })`. Expiry is opt-in; engine-lib does not
start background timers.

Persisted summarization can be installed through the existing hook decorator:

```ts
import { summarizingCompactor, withSessionStoreHooks } from "@infinityi/engine-lib/session-stores";

const store = withSessionStoreHooks(baseStore, {
  compactor: summarizingCompactor({
    provider,
    model: "gpt-4.1-mini",
    keepRecentTurns: 6,
    shouldCompactAt: { messages: 80 },
  }),
});
```

The compactor replaces older turns with one pinned `system` summary message and
archives the removed messages when an archiver is configured.

## Context

```ts
await runAgent(agent, {
  input: "answer with account facts",
  context: [
    staticContext({ plan: "enterprise" }, "Account"),
    dynamicContext("clock", () => new Date().toISOString()),
  ],
});
```

Context providers resolve once per run before the first provider call.

## Context windows

Use `contextWindow` to trim the provider request view without mutating the
canonical session history:

```ts
await runAgent(agent, {
  input: "newest",
  messages: priorMessages,
  contextWindow: {
    maxTokens: 8_000,
    strategy: truncateToolAware(),
  },
});
```

`truncateToolAware()` drops whole turns and never separates a `tool_call` from
its matching `tool_result`. `summarizeOldest()` also splits at turn boundaries.

## Forking a session

`session.fork(options?)` (or the free function `forkSession(session, options?)`)
copies a prefix of one session's history into a new, independent session — the
substrate for "try again" / A-B exploration. The original is untouched.

```ts
const branch = await session.fork({ atIndex: 6 });
```

- The default fork point is all messages. `atIndex` is clamped and **snapped
  down to a turn boundary**, so a fork never splits an assistant `tool_call` from
  its `tool_result` messages.
- The fork copies the source `metadata` by default (pass `metadata: false` to
  drop it, or an object to override) and inherits the source `tenantId` — a fork
  cannot cross tenants.
- Forking works for every store via the `load`/`save` contract; both sessions
  are fully independent afterwards.

## Migration to 2.0.0

Custom `SessionStore` implementations must add `list()` and `setMetadata()`,
and change `append()` to resolve an `AppendResult` (`{}` is valid). Callers that
only awaited `append()` remain source-compatible.

SQL stores require `migrate()` to add `expires_at` and listing/expiry indexes.
The migration is additive and idempotent. Redis clients used with listing or
expiry must provide structural `scan` and `pExpire`/`pexpire` methods.

Resume reconciliation now defaults on, and model compatibility defaults to
`"warn"`. Hosts that need legacy behavior can set `resume: false` and
`modelCompatibility: "ignore"`.


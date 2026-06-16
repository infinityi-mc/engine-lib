# Sessions and context

## Goal

Persist conversation state, inject request-time context, and control how much
history is sent to the provider.

## Prerequisites

- You have read [Execution](./04-execution.md)
- You understand the basic run loop

## Step 1: Create a session

```ts
import { createSession, runAgent } from "@infinityi/engine-lib";

const session = createSession({ id: "user-123" });

await runAgent(agent, { input: "first", session });
await runAgent(agent, { input: "second", session });

const history = await session.messages();
```

A session stores durable conversation history and metadata. It is the main
primitive for multi-turn conversations.

## Step 2: Read resume metadata

```ts
import { readResumeInfo } from "@infinityi/engine-lib";

const metadata = await session.getMetadata();
const resume = readResumeInfo(metadata);
```

`runAgent(...)` writes structured resume metadata under a reserved metadata key.
Use the typed helpers instead of manually reading string keys.

Useful session exports include:

- `RESUME_METADATA_KEY`
- `RESUME_SCHEMA_VERSION`
- `withResumeInfo`
- `activeToolNames`
- `compareAgentResume`
- `assertAgentResumeCompatible`

## Step 3: Enable checkpointing

```ts
await runAgent(agent, {
  input: "continue",
  session,
  checkpoint: {
    mode: "step",
    onCheckpoint: (checkpoint) => {
      // Persist or mirror checkpoint.newMessages here.
    },
  },
});
```

Use checkpointing when you need crash tolerance, resumability, or host-owned
mirrors of step-by-step progress.

## Step 4: Inject request-time context

```ts
import { dynamicContext, staticContext } from "@infinityi/engine-lib";

await runAgent(agent, {
  input: "answer with account facts",
  context: [
    staticContext({ plan: "enterprise" }, "Account"),
    dynamicContext("clock", () => new Date().toISOString()),
  ],
});
```

Context is resolved once per run and is not persisted as conversation history.
Use it for dynamic facts, request-scoped metadata, or host-owned derived state.

## Step 5: Apply a context window

```ts
import { truncateToolAware } from "@infinityi/engine-lib";

await runAgent(agent, {
  input: "newest",
  messages: priorMessages,
  contextWindow: {
    maxTokens: 8_000,
    strategy: truncateToolAware(),
  },
});
```

Context-window strategies reduce the provider-visible history without mutating
the canonical session record.

Common helpers:

- `truncateOldest()`
- `truncateToolAware()`
- `summarizeOldest()`
- `estimateTokens()`
- `resolveContext()`
- `applyContextWindow()`

## Step 6: Fork a session

```ts
const branch = await session.fork({ atIndex: 6 });
```

Use session forking for "try again" flows, A/B exploration, or branchable
assistant workflows.

## Step 7: Move to durable stores when in-memory state is not enough

`@infinityi/engine-lib/session-stores` provides:

- `createSqliteSessionStore`
- `createPostgresSessionStore`
- `RedisSessionStore`
- `FilesystemJsonlSessionStore`
- `ForgeDataSessionStore`
- `withSessionStoreHooks`
- `summarizingCompactor`
- `jsonSessionStoreCodec`
- `tenantScopedStore`
- `migrateSessionStore`

Use these when you need persistence, compaction, expiry, tenant scoping, or
concurrency-aware append behavior.

## Result

You should now be able to:

- preserve multi-turn history
- resume safely after interrupted runs
- inject non-persistent context
- trim provider-visible history to fit model budgets
- choose a durable session store strategy

## Next steps

- Coordinate agents in [Multi-agent coordination](./06-multi-agent.md)
- Add retrieval in [Retrieval and memory](./08-retrieval-and-memory.md)

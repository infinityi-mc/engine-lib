# Sessions and context

Sessions store durable conversation history. Context providers inject
request-time information without persisting it.

Application imports:

```ts
import {
  createSession,
  dynamicContext,
  staticContext,
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
```

Successful runs append only conversation messages:

- user input
- assistant turns
- tool-result messages

Instructions and injected context are rebuilt for each request and are not
persisted.

## Durable stores

Durable stores live on `@infinityi/engine-lib/session-stores`:

- `createSqliteSessionStore`
- `createPostgresSessionStore`
- `RedisSessionStore`
- `FilesystemJsonlSessionStore`
- `ForgeDataSessionStore`

Stores expose `migrate()` when they own schema setup and `close()` when they own
resources. Use `SessionStoreCodec` to add encryption at rest.

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
    strategy: truncateOldest(),
  },
});
```


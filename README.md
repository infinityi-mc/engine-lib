# engine-lib

Agent infrastructure for TypeScript, built on [`@infinityi/forge`](https://github.com/tqcuong2k/forge).

## Installation

```bash
bun add @infinityi/engine-lib
```

For local development in this repository:

```bash
bun install
bun run check
bun test
bun run build
```

## Quick Start

```ts
import { defineAgent, runAgent } from "@infinityi/engine-lib";
import { mockProvider, textResult } from "@infinityi/engine-lib/testing";

const agent = defineAgent({
  name: "assistant",
  provider: mockProvider({ result: () => textResult("hello") }),
});

const result = await runAgent(agent, { input: "Say hello." });
console.log(result.output);
```

Use a real provider in production and `@infinityi/engine-lib/testing` for unit
and contract tests.

## Features

- provider-agnostic agent definitions for OpenAI, Anthropic, Google, and
  OpenAI-compatible APIs
- schema-validated tools with structured success and failure results
- provider-native execution with buffered and streaming run modes
- durable sessions, resume metadata, forking, and pluggable session stores
- request-time context injection and context-window management
- event subscribers, telemetry hooks, and append-only audit logging
- handoffs and sub-agents-as-tools for multi-agent coordination
- opt-in tool packs for shell, filesystem, HTTP, web, and sandboxed execution
- optional retrieval, approval, authorization, governance, and resilience
  modules
- network-free testing helpers and provider/session conformance utilities

## Usage

### Define an agent and run it

```ts
import { createOpenAI, defineAgent, runAgent } from "@infinityi/engine-lib";

const provider = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-5",
});

const agent = defineAgent({
  name: "assistant",
  provider,
  instructions: "Answer clearly and use tools when needed.",
});

const result = await runAgent(agent, {
  input: "Summarize the latest deployment status.",
});
```

### Add tools

```ts
import { defineAgent, defineTool, runAgent, s } from "@infinityi/engine-lib";

const lookupService = defineTool({
  name: "lookup_service",
  description: "Return the current status for a service.",
  parameters: s.object({
    service: s.enum(["api", "worker", "billing"]),
  }),
  execute: async ({ service }) => ({
    ok: true,
    content: { service, status: "healthy" },
  }),
});

const agent = defineAgent({
  name: "ops",
  provider,
  tools: [lookupService],
});

await runAgent(agent, { input: "Check billing." });
```

Use tool failures (`{ ok: false, error: ... }`) for recoverable domain errors.
Throw only for unexpected implementation failures.

### Persist session state

```ts
import { createSession, runAgent } from "@infinityi/engine-lib";

const session = createSession({ id: "user-123" });

await runAgent(agent, { input: "first", session });
await runAgent(agent, { input: "second", session });

const history = await session.messages();
```

Use `@infinityi/engine-lib/session-stores` when you need SQLite,
PostgreSQL, Redis, Forge SQL, or filesystem-backed persistence.

### Stream events

```ts
const handle = runAgent(agent, { input: "go", stream: true });

for await (const event of handle) {
  console.log(event.type);
}

const result = await handle.completed;
```

Use `subscribers` or `onEvent` when you want UI streaming, audit trails,
logging, or metrics.

## API Overview

### Root package

Use the root import for the stable application surface:

- schemas: `s`, `asSchema`, `fromJsonSchema`, `toJsonSchema`
- messages: `user`, `assistant`, `system`, `text`, `toolResult`
- providers: `createOpenAI`, `createAnthropic`, `createGoogle`,
  `createOpenAICompatible`
- tools: `defineTool`
- agents: `defineAgent`, `asTool`, `createAgentRegistry`
- execution: `runAgent`
- sessions: `createSession`, `forkSession`, `readResumeInfo`
- context: `staticContext`, `dynamicContext`, `truncateToolAware`
- events: `createEventHub`, `loggingSubscriber`, `messageBusSubscriber`
- approval: `askHumanTool`, `deferredHumanInputGateway`,
  `trustApprovalPolicy`
- authorization: `roleToolAuthorizer`
- resilience: `withProviderRetry`, `circuitBreaker`, rate limiters
- governance: `auditSubscriber`, `jsonlAuditLog`, `forgeDataAuditLog`

### Subpath modules

| Import                                      | Use when you need                                           |
| ------------------------------------------- | ----------------------------------------------------------- |
| `@infinityi/engine-lib/schema`              | schema building, JSON Schema conversion, validation helpers |
| `@infinityi/engine-lib/messages`            | provider-neutral messages and content parts                 |
| `@infinityi/engine-lib/errors`              | public error taxonomy                                       |
| `@infinityi/engine-lib/runtime`             | Forge secret and telemetry helpers                          |
| `@infinityi/engine-lib/providers`           | provider contracts, adapter helpers, HTTP/SSE plumbing      |
| `@infinityi/engine-lib/tools`               | tool-result mappers and provider-tool conversion            |
| `@infinityi/engine-lib/agent`               | registries, handoff helpers, and sub-agent tools            |
| `@infinityi/engine-lib/execution`           | run types, usage helpers, limits, run-id utilities          |
| `@infinityi/engine-lib/session`             | session handles and store contracts                         |
| `@infinityi/engine-lib/session-stores`      | durable stores, compaction, codecs, migrations              |
| `@infinityi/engine-lib/context`             | context providers, token estimation, window strategies      |
| `@infinityi/engine-lib/retrieval`           | document loading, chunking, embeddings, retrievers, memory  |
| `@infinityi/engine-lib/events`              | event projection and telemetry helpers                      |
| `@infinityi/engine-lib/approval`            | human-in-the-loop approval flows                            |
| `@infinityi/engine-lib/governance`          | audit sinks, redaction, policy composition                  |
| `@infinityi/engine-lib/resilience`          | retry, circuit breaker, rate limiting, budget enforcement   |
| `@infinityi/engine-lib/tools-shell`         | policy-gated shell tools                                    |
| `@infinityi/engine-lib/tools-fs`            | allowed-root filesystem tools                               |
| `@infinityi/engine-lib/tools-http`          | policy-gated HTTP tools and client                          |
| `@infinityi/engine-lib/tools-web`           | web search, fetch, readability, crawl helpers               |
| `@infinityi/engine-lib/tools-sandbox`       | local and container-backed tool sandboxes                   |
| `@infinityi/engine-lib/testing`             | mock providers, scripted providers, fetch doubles           |
| `@infinityi/engine-lib/testing/conformance` | provider conformance battery                                |
| `@infinityi/engine-lib/lifecycle`           | Forge lifecycle adapter                                     |

Detailed guides live in [`docs/`](./docs/guide/README.md).

## Configuration

Common provider configuration:

- OpenAI: `apiKey`, `model`
- Anthropic: `apiKey`, `model`
- Google: `apiKey`, `model`
- OpenAI-compatible: `baseUrl`, `model`, optional `apiKey`

Run-time controls are set through `runAgent(...)` options, including:

- `stream` for streaming mode
- `maxSteps` and `maxHandoffs` to bound execution
- `session` for durable history
- `context` and `contextWindow` for request shaping
- `subscribers`, `onEvent`, and `telemetry` for observability
- `checkpoint` and `resume` for crash-tolerant runs
- `signal` for cancellation

Optional modules add their own host-owned configuration, such as allowed roots,
allowed hosts, approval hooks, durable-store wiring, and retrieval backends.

## Contributing

```bash
bun install
bun run check
bun test
bun run build
bun run docs
```

When updating public APIs, keep the guides in `docs/` aligned with the current
source and regenerate TypeDoc if needed.

## License

MIT. See [`LICENSE`](./LICENSE).

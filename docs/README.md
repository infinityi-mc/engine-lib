# engine-lib documentation

Start with the repository [`README.md`](../README.md) for project goals,
constraints, and the fastest overview. Use these pages when you need runnable
examples, import-path details, or feature-specific behavior.

## Guides

| Guide                                               | Covers                                                     |
| --------------------------------------------------- | ---------------------------------------------------------- |
| [Getting started](./getting-started.md)             | installation, quickstart, examples, and API docs           |
| [Providers](./providers.md)                         | built-in provider factories, capabilities, custom adapters |
| [Tools and schemas](./tools.md)                     | `s`, `defineTool`, tool results, error recovery            |
| [Execution](./execution.md)                         | `runAgent`, streaming, cancellation, run failures          |
| [Sessions and context](./sessions-and-context.md)   | durable history, context injection, context windows        |
| [Events and telemetry](./events-and-telemetry.md)   | run events, subscribers, telemetry integration             |
| [Multi-agent](./multi-agent.md)                     | handoffs, registries, and sub-agents as tools              |
| [Optional tool packs](./optional-tool-packs.md)     | shell, filesystem, HTTP, and web tool safety               |
| [Testing and lifecycle](./testing-and-lifecycle.md) | test doubles, conformance, Forge lifecycle                 |

## API Reference

The full API reference is generated from source doc-comments with
[TypeDoc](https://typedoc.org):

```bash
bun run docs
```

Then open `docs/api/index.html`. The output is git-ignored; regenerate it
locally or publish it from CI.

The TypeDoc entry points are aligned with the public package exports:

| Import                                      | Module                                                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `@infinityi/engine-lib`                     | stable root barrel: schemas, messages, errors, provider factories, tools, agents, execution, sessions, context helpers, event subscribers |
| `@infinityi/engine-lib/schema`              | schema builder, JSON Schema export, and validation helpers                                                                                |
| `@infinityi/engine-lib/messages`            | provider-neutral message and content helpers                                                                                              |
| `@infinityi/engine-lib/errors`              | public error taxonomy                                                                                                                     |
| `@infinityi/engine-lib/runtime`             | Forge secret and telemetry integration helpers                                                                                            |
| `@infinityi/engine-lib/providers`           | provider contracts, built-in provider factories, and advanced adapter/HTTP/SSE helpers                                                    |
| `@infinityi/engine-lib/tools`               | tool definitions and tool-result mapping helpers                                                                                          |
| `@infinityi/engine-lib/tools-shell`         | optional policy-gated command execution tools                                                                                             |
| `@infinityi/engine-lib/tools-fs`            | optional allowed-root filesystem and workspace tools                                                                                      |
| `@infinityi/engine-lib/tools-http`          | optional policy-gated HTTP GET/POST tools and client                                                                                      |
| `@infinityi/engine-lib/tools-web`           | optional static web/search tools built on `tools-http`                                                                                    |
| `@infinityi/engine-lib/agent`               | agent definitions, registries, handoffs, and sub-agent-as-tool helpers                                                                    |
| `@infinityi/engine-lib/execution`           | `runAgent` and run result/event types                                                                                                     |
| `@infinityi/engine-lib/session`             | session handles and session store contract                                                                                                |
| `@infinityi/engine-lib/session-stores`      | optional durable session stores for Forge SQL, SQLite, PostgreSQL, Redis, and filesystem JSONL                                            |
| `@infinityi/engine-lib/context`             | context providers and context-window strategies                                                                                           |
| `@infinityi/engine-lib/retrieval`           | optional RAG primitives: document loaders, chunkers, embeddings, vector stores, retrievers, and retriever context providers               |
| `@infinityi/engine-lib/events`              | event hub, subscribers, event projection helpers, and telemetry bridge                                                                    |
| `@infinityi/engine-lib/lifecycle`           | Forge lifecycle adapter (`agentRuntimeComponent`)                                                                                         |
| `@infinityi/engine-lib/testing`             | network-free test doubles                                                                                                                 |
| `@infinityi/engine-lib/testing/conformance` | provider conformance battery                                                                                                              |

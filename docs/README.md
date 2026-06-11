# engine-lib documentation

- **Guide & concepts:** [`../README.md`](../README.md) - project goal, design principles, and annotated usage scenarios.
- **Runnable examples:** [`../examples/`](../examples/) - small, offline programs you can run with `bun`.

## API reference

The full API reference is generated from source doc-comments with
[TypeDoc](https://typedoc.org):

```bash
bun run docs   # writes HTML to docs/api/ (git-ignored)
```

Then open `docs/api/index.html`. Configuration lives in `typedoc.json` in the
source repository; the documented entry points are the public import surfaces:

| Import | Module |
| --- | --- |
| `@infinityi/engine-lib` | stable root barrel: schemas, messages, errors, provider factories, tools, agents, execution, sessions, context helpers, event subscribers |
| `@infinityi/engine-lib/schema` | schema builder, JSON Schema export, and validation helpers |
| `@infinityi/engine-lib/messages` | provider-neutral message and content helpers |
| `@infinityi/engine-lib/errors` | public error taxonomy |
| `@infinityi/engine-lib/runtime` | Forge secret and telemetry integration helpers |
| `@infinityi/engine-lib/providers` | provider contracts, built-in provider factories, and advanced adapter/HTTP/SSE helpers |
| `@infinityi/engine-lib/tools` | tool definitions and tool-result mapping helpers |
| `@infinityi/engine-lib/tools-shell` | optional policy-gated command execution tools |
| `@infinityi/engine-lib/tools-fs` | optional allowed-root filesystem and workspace tools |
| `@infinityi/engine-lib/tools-http` | optional policy-gated HTTP GET/POST tools and client |
| `@infinityi/engine-lib/tools-web` | optional static web/search tools built on `tools-http` |
| `@infinityi/engine-lib/agent` | agent definitions, registries, handoffs, and sub-agent-as-tool helpers |
| `@infinityi/engine-lib/execution` | `runAgent` and run result/event types |
| `@infinityi/engine-lib/session` | session handles and session store contract |
| `@infinityi/engine-lib/session-stores` | optional durable session stores for Forge SQL, SQLite, PostgreSQL, Redis, and filesystem JSONL |
| `@infinityi/engine-lib/context` | context providers and context-window strategies |
| `@infinityi/engine-lib/events` | event hub, subscribers, event projection helpers, and telemetry bridge |
| `@infinityi/engine-lib/lifecycle` | Forge lifecycle adapter (`agentRuntimeComponent`) |
| `@infinityi/engine-lib/testing` | network-free test doubles (`mockProvider`, `scriptedProvider`, `textResult`, `toolCallResult`, `jsonFetch`/`sseFetch`, `inMemorySessionStore`) |
| `@infinityi/engine-lib/testing/conformance` | the provider conformance battery (`runProviderConformance`) |

The output is intentionally not committed; regenerate it locally or in CI.

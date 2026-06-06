# engine-lib documentation

- **Guide & concepts:** [`../README.md`](../README.md) - project goal, design principles, and annotated usage scenarios.
- **Roadmap:** [`../ROADMAP.md`](../ROADMAP.md) - the eight delivery phases and their contracts.
- **Runnable examples:** [`../examples/`](../examples/) - small, offline programs you can run with `bun`.

## API reference

The full API reference is generated from source doc-comments with
[TypeDoc](https://typedoc.org):

```bash
bun run docs   # writes HTML to docs/api/ (git-ignored)
```

Then open `docs/api/index.html`. Configuration lives in
[`../typedoc.json`](../typedoc.json); the documented entry points are the public
import surfaces:

| Import | Module |
| --- | --- |
| `engine-lib` | stable root barrel: schemas, messages, errors, provider factories, tools, agents, execution, sessions, context helpers, event subscribers |
| `engine-lib/schema` | schema builder, JSON Schema export, and validation helpers |
| `engine-lib/messages` | provider-neutral message and content helpers |
| `engine-lib/errors` | public error taxonomy |
| `engine-lib/runtime` | Forge secret and telemetry integration helpers |
| `engine-lib/providers` | provider contracts, built-in provider factories, and advanced adapter/HTTP/SSE helpers |
| `engine-lib/tools` | tool definitions and tool-result mapping helpers |
| `engine-lib/agent` | agent definitions, registries, handoffs, and sub-agent-as-tool helpers |
| `engine-lib/execution` | `runAgent` and run result/event types |
| `engine-lib/session` | session handles and session store contract |
| `engine-lib/context` | context providers and context-window strategies |
| `engine-lib/events` | event hub, subscribers, event projection helpers, and telemetry bridge |
| `engine-lib/lifecycle` | Forge lifecycle adapter (`agentRuntimeComponent`) |
| `engine-lib/testing` | network-free test doubles (`mockProvider`, `scriptedProvider`, `textResult`, `toolCallResult`, `jsonFetch`/`sseFetch`, `inMemorySessionStore`) |
| `engine-lib/testing/conformance` | the provider conformance battery (`runProviderConformance`) |

The output is intentionally not committed; regenerate it locally or in CI.

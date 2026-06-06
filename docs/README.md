# engine-lib documentation

- **Guide & concepts:** [`../README.md`](../README.md) — project goal, design principles, and annotated usage scenarios.
- **Roadmap:** [`../ROADMAP.md`](../ROADMAP.md) — the eight delivery phases and their contracts.
- **Runnable examples:** [`../examples/`](../examples/) — small, offline programs you can run with `bun`.

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
| `engine-lib` | root barrel — schema, messages, errors, providers, tools, agents, execution, sessions, context, events |
| `engine-lib/lifecycle` | Forge lifecycle adapter (`agentRuntimeComponent`) |
| `engine-lib/testing` | network-free test doubles (`mockProvider`, `scriptedProvider`, `textResult`, `toolCallResult`, `jsonFetch`/`sseFetch`, `inMemorySessionStore`) |
| `engine-lib/testing/conformance` | the provider conformance battery (`runProviderConformance`) |

The output is intentionally not committed — regenerate it locally or in CI.

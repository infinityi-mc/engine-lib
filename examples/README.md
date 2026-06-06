# Examples

Small, self-contained programs demonstrating the engine-lib API. Each one runs
**offline** with `bun` — they use the network-free test doubles from
`engine-lib/testing` (scripted providers) so no API key is required.

```bash
bun examples/incident-analysis.ts   # context injection + a read-only tool
bun examples/terminal-coder.ts       # streaming tokens + a persisted session
bun examples/multi-agent.ts          # handoff/delegation + sub-agent-as-tool
bun examples/lifecycle.ts            # forge.boot with agentRuntimeComponent
```

| File | Demonstrates |
| --- | --- |
| [`incident-analysis.ts`](./incident-analysis.ts) | `defineAgent` + `defineTool`, `staticContext` injection, `onEvent` tool-call observation |
| [`terminal-coder.ts`](./terminal-coder.ts) | streaming (`stream: true`) `token` events, `createSession` history persistence |
| [`multi-agent.ts`](./multi-agent.ts) | Phase 7 — `handoffs` / `transfer_to_<name>` and `asTool(agent)` |
| [`lifecycle.ts`](./lifecycle.ts) | Phase 8 — `agentRuntimeComponent` start/healthcheck/stop under `forge.boot` |

> The examples import from `../src` so they run directly inside this repository.
> In your own application you would instead `import { ... } from "engine-lib"`
> and pass a real provider, e.g. `createOpenAI({ apiKey, model })` or
> `createAnthropic({ apiKey, model })`.

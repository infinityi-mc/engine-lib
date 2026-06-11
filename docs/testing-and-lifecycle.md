# Testing and lifecycle

## Testing helpers

Import:

```ts
import {
  mockProvider,
  scriptedProvider,
  textResult,
  toolCallResult,
} from "@infinityi/engine-lib/testing";
```

Use `mockProvider` for simple one-turn tests and request inspection. Use
`scriptedProvider` for multi-turn tests such as tool call followed by final
answer.

Runnable version:
[`../examples/08-testing-agent.ts`](../examples/08-testing-agent.ts).

Other helpers:

- `conversation`
- `collectProviderStream`
- `expectValid`
- `jsonFetch`
- `sseFetch`
- `inMemorySessionStore`

## Provider conformance

Adapter authors should use:

```ts
import { runProviderConformance } from "@infinityi/engine-lib/testing/conformance";
```

The battery checks buffered completion, streaming, tool calling, usage,
capability honesty, and error mapping through fake transports.

## Lifecycle

Import:

```ts
import { agentRuntimeComponent } from "@infinityi/engine-lib/lifecycle";
```

`agentRuntimeComponent` adapts providers and optional session stores to a Forge
lifecycle component:

- `start()` validates provider names and default models
- `probeOnStart` can fail boot when providers are unhealthy
- `healthcheck()` maps provider probes to Forge health results
- `stop()` runs a host shutdown hook, such as closing a durable store

Runnable version: [`../examples/13-lifecycle.ts`](../examples/13-lifecycle.ts).


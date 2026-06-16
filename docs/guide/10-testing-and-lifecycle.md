# Testing and lifecycle

## Goal

Test agents without a network, validate provider or session-store contracts, and
integrate the runtime into a Forge lifecycle.

## Prerequisites

- You have read the earlier core guides
- You want to harden or ship a real integration

## Step 1: Use testing doubles

```ts
import {
  mockProvider,
  scriptedProvider,
  textResult,
  toolCallResult,
} from "@infinityi/engine-lib/testing";
```

Use:

- `mockProvider` for simple one-turn tests and request inspection
- `scriptedProvider` for multi-turn flows
- `textResult` and `toolCallResult` to script provider behavior

## Step 2: Use test helpers for fixtures and assertions

The testing module also exports:

- `conversation`
- `collectProviderStream`
- `expectValid`
- `jsonFetch`
- `sseFetch`
- `inMemorySessionStore`
- `InMemorySessionStore`

These help you build deterministic unit tests around schemas, providers, HTTP
adapters, and session behavior.

## Step 3: Run conformance batteries

Use `@infinityi/engine-lib/testing/conformance` for provider conformance and
`runSessionStoreConformance` from `@infinityi/engine-lib/testing` for session
stores.

These batteries help adapter authors validate buffered completion, streaming,
tool calling, usage accounting, contract honesty, and store behavior.

## Step 4: Integrate with Forge lifecycle

```ts
import { agentRuntimeComponent } from "@infinityi/engine-lib/lifecycle";
```

Use `agentRuntimeComponent` when you want providers and optional session stores
to participate in Forge startup, health, and shutdown semantics.

Key lifecycle behavior includes:

- `start()` validating provider names and defaults
- optional provider probes on startup
- `healthcheck()` mapping provider health to Forge health results
- `stop()` closing owned resources such as durable stores

## Result

You should now know how to:

- test without a network
- script provider behavior deterministically
- validate custom providers and stores
- wire engine-lib into a Forge-managed runtime

## Next steps

- Add advanced runtime controls in [Approval, authorization, and resilience](./11-approval-authorization-and-resilience.md)
- Use the reference map in [API map](./12-api-map.md)

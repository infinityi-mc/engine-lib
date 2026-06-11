# Events and telemetry

The run loop emits typed events for UI streaming, audit logs, metrics, and
debugging.

Application imports:

```ts
import { createEventHub, loggingSubscriber, messageBusSubscriber } from "@infinityi/engine-lib/events";
```

Root imports expose the common subscriber factories.

Runnable version:
[`../examples/05-events-subscribers.ts`](../examples/05-events-subscribers.ts).

## Event delivery

Use `onEvent` for a single callback:

```ts
await runAgent(agent, {
  input: "go",
  onEvent: (event) => console.log(event.type),
});
```

Use `subscribers` for fan-out:

```ts
await runAgent(agent, {
  input: "go",
  subscribers: [loggingSubscriber(logger), messageBusSubscriber(messageBus)],
});
```

Subscribers are invoked in order and awaited. A failing subscriber is isolated
and does not abort the run or prevent later subscribers from receiving events.

## Event types

Core event variants:

- `run.start`
- `message`
- `token`
- `tool.call`
- `tool.result`
- `run.finish`
- `error`
- `agent.child`
- `agent.handoff`
- `custom`

Optional tool packs use `custom` events for policy decisions, approvals,
request starts/ends, command output chunks, and similar module-specific audit
data.

## Telemetry

Pass a Forge telemetry handle to `runAgent` to enable spans and metrics for:

- `agent.run`
- `agent.provider.call`
- `agent.tool.execute`

Advanced telemetry helpers are available from `@infinityi/engine-lib/events`.


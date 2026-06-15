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

## Durable audit trail

The event stream is transient. To persist a decision trail, register an
`auditSubscriber` — it maps tool / policy / approval / authorization events to
append-only `AuditEntry` records on an `AuditLog`. Two sinks ship built-in:
`jsonlAuditLog` (one JSON object per line) and `forgeDataAuditLog` (an
INSERT-only table).

```ts
import { runAgent } from "@infinityi/engine-lib/execution";
import { auditSubscriber, jsonlAuditLog } from "@infinityi/engine-lib/governance";

const log = jsonlAuditLog("./audit.jsonl");

await runAgent(agent, {
  input: "deploy the service",
  subscribers: [auditSubscriber(log)],
});

await log.close(); // flush pending appends
```

- Entries carry the `runId` (from the run's events), the active `agent` (picked
  up from `run.start`), an `action`, a `target`, and a redacted `detail`.
- Sensitive data is never written verbatim: tool arguments are persisted as a
  digest, and free-text reasons can be passed through a `redactDetail` filter.
- The subscriber is isolated by the event hub — a failing `record` is reported
  via `onSubscriberError` and never aborts the run.
- `forgeDataAuditLog({ db })` exposes a `migrate()` to create the table; it is
  INSERT-only, with no update/delete API.

## Telemetry

Pass a Forge telemetry handle to `runAgent` to enable spans and metrics for:

- `agent.run`
- `agent.provider.call`
- `agent.tool.execute`

Advanced telemetry helpers are available from `@infinityi/engine-lib/events`.


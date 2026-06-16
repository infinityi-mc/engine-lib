# Events, telemetry, and governance

## Goal

Observe runs, fan out events, emit telemetry, persist audit logs, and apply
redaction or policy composition.

## Prerequisites

- You have read [Execution](./04-execution.md)
- You understand sessions and optional tool packs

## Step 1: Subscribe to events directly

```ts
await runAgent(agent, {
  input: "go",
  onEvent: (event) => {
    console.log(event.type);
  },
});
```

Use `onEvent` when you need a single event sink.

## Step 2: Fan out to multiple subscribers

```ts
import {
  loggingSubscriber,
  messageBusSubscriber,
} from "@infinityi/engine-lib/events";

await runAgent(agent, {
  input: "go",
  subscribers: [
    loggingSubscriber(logger),
    messageBusSubscriber(messageBus),
  ],
});
```

Subscribers run in order and are isolated so one failing sink does not abort the
run.

## Step 3: Use the event hub and projection helpers

`@infinityi/engine-lib/events` also exports:

- `createEventHub`
- `eventFields`
- `eventPayload`
- `createRunTelemetry`
- `SPAN_RUN`
- `SPAN_PROVIDER`
- `SPAN_TOOL`

Use these when integrating with custom logging, message buses, or telemetry
pipelines.

## Step 4: Persist an audit trail

```ts
import { runAgent } from "@infinityi/engine-lib";
import { auditSubscriber, jsonlAuditLog } from "@infinityi/engine-lib/governance";

const log = jsonlAuditLog("./audit.jsonl");

await runAgent(agent, {
  input: "deploy the service",
  subscribers: [auditSubscriber(log)],
});

await log.close();
```

Use audit logging when your host needs append-only operational history for tools,
approvals, policy decisions, or safety-relevant actions.

## Step 5: Apply redaction and filtering

The governance module also exports:

- `applyFilters`
- `filterMessageText`
- `filterMessagesText`
- `regexRedactor`
- `schemaSensitiveRedactor`
- `defaultRedactionPatterns`
- `redactingCodec`
- `redactTextForPersistence`

Use these when messages, metadata, or persisted session content must be cleaned
before storage or downstream delivery.

## Step 6: Compose policy engines

`@infinityi/engine-lib/governance` includes policy helpers:

- `composePolicies`
- `approvalDecisionFromPolicy`
- `approvalRequestFromPolicy`
- `filesystemPolicySource`
- `httpPolicySource`
- `shellPolicySource`

Use this layer when your host needs centralized policy evaluation across
multiple tool families.

## Result

You should now be able to:

- subscribe to run events
- fan out events to multiple sinks
- enable structured telemetry
- persist audit logs
- redact content and compose policies

## Next steps

- Test integrations in [Testing and lifecycle](./10-testing-and-lifecycle.md)
- Add HITL and resilience in [Approval, authorization, and resilience](./11-approval-authorization-and-resilience.md)

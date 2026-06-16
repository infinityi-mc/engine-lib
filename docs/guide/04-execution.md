# Execution

## Goal

Understand how `runAgent` works in buffered and streaming mode, and learn the
key execution controls.

## Prerequisites

- You have read [Tools and schemas](./03-tools-and-schemas.md)
- You have an agent definition with a provider

## Step 1: Run in buffered mode

```ts
import { runAgent } from "@infinityi/engine-lib";

const result = await runAgent(agent, { input: "go" });
console.log(result.output);
```

This is the simplest mode. The entire run completes before control returns to
your code.

`RunResult` includes:

- `output`
- `finalMessage`
- `messages`
- `finishReason`
- `steps`
- `usage`
- `agent`
- `handoffs`

## Step 2: Run in streaming mode

```ts
const handle = runAgent(agent, { input: "go", stream: true });

for await (const event of handle) {
  console.log(event.type);
}

const result = await handle.completed;
```

Use streaming mode when you need incremental UI updates, token-level output, or
interactive operational telemetry.

## Step 3: Observe run events

The execution loop emits a typed event stream. Common events include:

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

Use `onEvent` for a single callback or `subscribers` for fan-out.

## Step 4: Bound the run

Use these controls to keep execution predictable:

- `maxSteps` to cap provider turns
- `maxHandoffs` to cap handoff loops
- `signal` to cancel the run

Advanced helpers from `@infinityi/engine-lib/execution` include:

- `DEFAULT_MAX_STEPS`
- `DEFAULT_MAX_HANDOFFS`
- `generateRunId`
- `addUsage`
- `emptyUsage`

These are useful when integrating the run loop into a larger host runtime.

## Step 5: Understand failure behavior

Recoverable tool failures include:

- schema validation failures for tool arguments
- unknown tool names
- thrown tool implementation errors

Terminal run failures include:

- provider failures
- context or session failures
- max-step exhaustion
- max-handoff exhaustion
- cancellation

This split matters: tool errors stay inside the conversation whenever possible,
while execution failures stop the run.

## Step 6: Use checkpointing and resume when needed

Long-running or crash-sensitive hosts can enable checkpointing and resume
controls through run options. These work together with the session layer to
persist progress incrementally between steps.

## Result

You should now know:

- when to use buffered vs streaming runs
- how to observe progress through events
- how to set execution limits and cancellation
- which failures are conversational vs terminal

## Next steps

- Add durable memory in [Sessions and context](./05-sessions-and-context.md)
- Coordinate multiple agents in [Multi-agent coordination](./06-multi-agent.md)

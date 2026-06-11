# Execution

`runAgent` drives provider-native tool calling. It sends messages and tool
schemas to the provider, validates tool calls, dispatches tools, feeds tool
results back, and repeats until the model returns a final answer or the run
fails.

Application import:

```ts
import { runAgent } from "@infinityi/engine-lib";
```

## Buffered mode

```ts
const result = await runAgent(agent, { input: "go" });
console.log(result.output);
```

`RunResult` includes:

- `output`
- `finalMessage`
- `messages`
- `finishReason`
- `steps`
- `usage`
- `agent`
- `handoffs`

## Streaming mode

```ts
const handle = runAgent(agent, { input: "go", stream: true });

for await (const event of handle) {
  console.log(event.type);
}

const result = await handle.completed;
```

Runnable version: [`../examples/03-streaming.ts`](../examples/03-streaming.ts).

## Events

Successful runs start with `run.start` and end with `run.finish`. Tool calls
emit `tool.call`, `tool.result`, and a tool-result message. Streaming text
arrives as `token` events before the accumulated assistant message.

## Failure behavior

Tool validation failures, unknown tools, and thrown tool implementations become
recoverable tool-result errors. Provider failures, context/session failures,
max-step limits, handoff limits, and cancellation fail the run.

Use:

- `maxSteps` to cap provider turns
- `maxHandoffs` to cap handoff loops
- `signal` to cancel a run


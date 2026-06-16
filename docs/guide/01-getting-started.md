# Getting started

## Goal

Create and run your first agent with the stable root package.

## Prerequisites

- Bun installed
- TypeScript project or this repository checked out
- Basic familiarity with async TypeScript

## Step 1: Install the package

```bash
bun add @infinityi/engine-lib
```

For local development in this repository:

```bash
bun install
bun run check
bun test
bun run build
```

## Step 2: Start with the root import

Use the root package for the stable application surface:

```ts
import { defineAgent, runAgent } from "@infinityi/engine-lib";
import { mockProvider, textResult } from "@infinityi/engine-lib/testing";
```

Use subpaths only when you need an advanced or optional module.

## Step 3: Define a minimal agent

```ts
const agent = defineAgent({
  name: "assistant",
  provider: mockProvider({ result: () => textResult("hello") }),
});
```

An `AgentDefinition` is the declarative unit of execution. It owns the provider,
optional instructions, tools, hooks, generation settings, and optional handoff
targets.

## Step 4: Run the agent

```ts
const result = await runAgent(agent, { input: "Say hello." });
console.log(result.output);
```

`runAgent` drives the provider-native execution loop. It sends the current
conversation to the provider, dispatches any tool calls, and returns the final
assistant output.

## Step 5: Switch to a real provider

```ts
import { createOpenAI, defineAgent, runAgent } from "@infinityi/engine-lib";

const provider = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-5",
});

const agent = defineAgent({
  name: "assistant",
  provider,
  instructions: "Answer clearly and keep responses concise.",
});

const result = await runAgent(agent, {
  input: "What does this library do?",
});
```

Use testing providers for unit tests and shipped provider factories for real
application traffic.

## Result

You should now understand the minimum mental model:

- define a provider
- define an agent
- call `runAgent(...)`
- inspect `result.output`

## Next steps

- Learn provider factories and capabilities in [Providers](./02-providers.md)
- Learn tool definitions in [Tools and schemas](./03-tools-and-schemas.md)
- Learn the run loop in [Execution](./04-execution.md)

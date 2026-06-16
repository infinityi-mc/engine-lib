# Tools and schemas

## Goal

Define schema-validated tools, return structured results, and understand the
schema utilities that power tool calling.

## Prerequisites

- You have read [Getting started](./01-getting-started.md)
- You know how to create an agent

## Step 1: Import the tool and schema helpers

```ts
import { defineTool, s } from "@infinityi/engine-lib";
```

Use the root import for common application code. Use
`@infinityi/engine-lib/tools` only when you need result-mapping helpers such as
`toProviderTool` or `toToolResultMessage`.

## Step 2: Define a tool

```ts
const lookupService = defineTool({
  name: "lookup_service",
  description: "Return status for an internal service.",
  parameters: s.object({
    service: s.enum(["api", "worker", "billing"]),
  }),
  execute: async ({ service }) => ({
    ok: true,
    content: { service, status: "healthy" },
  }),
});
```

A tool is a named capability the model may call. Its `parameters` schema
validates model-supplied arguments before the implementation runs.

## Step 3: Use the schema builder

Common schema helpers:

- `s.string()`
- `s.number()`
- `s.boolean()`
- `s.enum([...])`
- `s.array(item)`
- `s.object(shape)`
- `s.optional(inner)`

Objects are strict by default. Optional object properties are derived from
`s.optional(...)`.

Use `asSchema()` or `fromJsonSchema()` when you need to adapt an existing schema
source.

## Step 4: Return the right result shape

Return success for expected outputs:

```ts
return { ok: true, content: data };
```

Return failure for domain errors the model can recover from:

```ts
return { ok: false, error: "file not found" };
```

Throw only for unexpected implementation faults. The execution loop catches
thrown tool errors and turns them into tool-result failures instead of crashing
the entire run.

## Step 5: Attach tools to an agent

```ts
import { defineAgent } from "@infinityi/engine-lib";

const agent = defineAgent({
  name: "ops",
  provider,
  tools: [lookupService],
});
```

`runAgent(...)` converts tools to the provider's tool format, validates tool
calls, executes them, and feeds the results back into the conversation.

## Step 6: Reach for the advanced tools subpath when needed

`@infinityi/engine-lib/tools` also exports:

- `toProviderTool`
- `toToolResultMessage`
- `toFilteredToolResultMessage`
- `renderToolContent`

These are useful when you are building advanced integrations, custom auditing,
or lower-level execution flows.

## Result

You should now be able to:

- define tools with strict input validation
- return success and failure in a recoverable way
- attach tools to agents
- use advanced tool-result mapping helpers when necessary

## Next steps

- Learn the full run loop in [Execution](./04-execution.md)
- Learn durable sessions in [Sessions and context](./05-sessions-and-context.md)

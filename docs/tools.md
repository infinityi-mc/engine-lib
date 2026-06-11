# Tools and schemas

Tools are named capabilities the model may call. Schemas validate model-supplied
arguments before execution.

Application imports:

```ts
import { defineTool, s } from "@infinityi/engine-lib";
```

## Define a tool

```ts
const lookupService = defineTool({
  name: "lookup_service",
  description: "Return status for an internal service.",
  parameters: s.object({
    service: s.enum(["api", "worker", "billing"]),
  }),
  execute: ({ service }) => ({
    ok: true,
    content: { service, status: "healthy" },
  }),
});
```

Runnable version: [`../examples/02-custom-tool.ts`](../examples/02-custom-tool.ts).

## Schema builder

The `s` builder covers the JSON-Schema subset needed for provider tool
parameters and structured outputs:

- `s.string()`
- `s.number()`
- `s.boolean()`
- `s.enum([...])`
- `s.array(item)`
- `s.object(shape)`
- `s.optional(inner)`

Objects are strict by default and reject unknown properties. Optional object
fields are derived from `s.optional(...)`.

Use `asSchema()` or `fromJsonSchema()` when adapting an external schema library
or raw JSON Schema.

## Tool results

Return success for expected output:

```ts
return { ok: true, content: data };
```

Return failure for domain errors the model can recover from:

```ts
return { ok: false, error: "file not found" };
```

Throw only for unexpected implementation faults. `runAgent` catches thrown tool
errors and feeds them back as tool-result errors instead of crashing the entire
run.

Example test pattern:
[`../examples/08-testing-agent.ts`](../examples/08-testing-agent.ts).


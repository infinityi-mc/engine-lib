# Multi-agent coordination

## Goal

Compose multiple agents with either handoffs or sub-agents used as tools.

## Prerequisites

- You have read [Execution](./04-execution.md)
- You understand tools and sessions

## Step 1: Use handoffs for role transfer

```ts
import { defineAgent, runAgent } from "@infinityi/engine-lib";

const billing = defineAgent({
  name: "billing",
  provider,
  instructions: "Handle billing questions.",
});

const triage = defineAgent({
  name: "triage",
  provider,
  instructions: "Route the user to the correct specialist.",
  handoffs: [billing],
});

await runAgent(triage, { input: "I need a refund" });
```

A handoff transfers the active run to another agent while preserving the
conversation history.

## Step 2: Use registries for named handoff targets

```ts
import { createAgentRegistry, defineAgent, runAgent } from "@infinityi/engine-lib";

const registry = createAgentRegistry([billing]);

const triage = defineAgent({
  name: "triage",
  provider,
  handoffs: ["billing"],
});

await runAgent(triage, {
  input: "I need a refund",
  registry,
});
```

Use registries when handoff targets are resolved by name rather than by direct
object reference.

## Step 3: Wrap a child agent as a tool

```ts
import { asTool, defineAgent } from "@infinityi/engine-lib";

const researcher = defineAgent({ name: "researcher", provider });

const lead = defineAgent({
  name: "lead",
  provider,
  tools: [asTool(researcher)],
});
```

Use `asTool(...)` when the parent should remain in control and call a child only
when needed.

## Step 4: Reach for advanced agent helpers when needed

The `@infinityi/engine-lib/agent` subpath also exports:

- `createToolRegistry`
- `handoffProviderTools`
- `handoffToolName`
- `resolveHandoffTargets`

These are useful when you are building custom orchestration, registries, or
handoff-aware host behavior.

## Step 5: Bound coordination loops

Use `maxHandoffs` to cap routing loops and keep agent graphs predictable.

## Result

You should now know when to use:

- handoffs for ownership transfer
- agent registries for named routing
- `asTool(...)` for subordinate expert calls

## Next steps

- Add host capabilities with [Optional tool packs](./07-optional-tool-packs.md)
- Add retrieval-backed experts with [Retrieval and memory](./08-retrieval-and-memory.md)

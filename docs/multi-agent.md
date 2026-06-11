# Multi-agent coordination

engine-lib supports two composition patterns without a separate orchestrator:
handoffs and sub-agents as tools.

## Handoffs

A handoff transfers the active run to another agent. The conversation history is
preserved and the final result records the trail.

```ts
const billing = defineAgent({ name: "billing", provider, instructions: "Handle billing." });

const triage = defineAgent({
  name: "triage",
  provider,
  instructions: "Route the user.",
  handoffs: [billing],
});
```

Runnable version:
[`../examples/06-multi-agent-handoff.ts`](../examples/06-multi-agent-handoff.ts).

String-named handoff targets require a registry:

```ts
const registry = createAgentRegistry([billing]);
const triage = defineAgent({ name: "triage", provider, handoffs: ["billing"] });
await runAgent(triage, { input: "refund", registry });
```

Use `maxHandoffs` to bound routing loops.

## Sub-agent as tool

`asTool(agent)` wraps a child agent as a normal tool. The parent model decides
when to call it. The child output is fed back as the tool result, child usage is
folded into parent usage, and child events surface as `agent.child`.

```ts
const researcher = defineAgent({ name: "researcher", provider });
const lead = defineAgent({
  name: "lead",
  provider,
  tools: [asTool(researcher)],
});
```

Runnable version:
[`../examples/07-sub-agent-tool.ts`](../examples/07-sub-agent-tool.ts).


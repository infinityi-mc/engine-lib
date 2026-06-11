import { defineAgent, defineTool, runAgent, s } from "@infinityi/engine-lib";
import type { RunEvent } from "@infinityi/engine-lib/execution";
import { scriptedProvider, textResult, toolCallResult } from "@infinityi/engine-lib/testing";

const echo = defineTool({
  name: "echo",
  parameters: s.object({ value: s.string() }),
  execute: ({ value }) => ({ ok: true, content: value }),
});

const agent = defineAgent({
  name: "streamer",
  tools: [echo],
  provider: scriptedProvider([
    toolCallResult([{ id: "echo-1", name: "echo", arguments: { value: "checked" } }]),
    textResult("Streaming run completed."),
  ]),
});

const events: string[] = [];
const handle = runAgent(agent, { input: "Run with events.", stream: true });

for await (const event of handle) {
  events.push(describeEvent(event));
}

const result = await handle.completed;

console.log({
  events,
  output: result.output,
});

function describeEvent(event: RunEvent): string {
  switch (event.type) {
    case "token":
      return `token:${event.delta}`;
    case "tool.call":
      return `tool.call:${event.name}`;
    case "tool.result":
      return `tool.result:${event.name}:${event.result.ok ? "ok" : "error"}`;
    default:
      return event.type;
  }
}


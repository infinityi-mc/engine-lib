import { defineAgent, defineTool, runAgent, s } from "@infinityi/engine-lib";
import {
  scriptedProvider,
  textResult,
  toolCallResult,
} from "@infinityi/engine-lib/testing";

const double = defineTool({
  name: "double",
  parameters: s.object({ value: s.number({ int: true }) }),
  execute: ({ value }) => ({ ok: true, content: value * 2 }),
});

const agent = defineAgent({
  name: "testable",
  tools: [double],
  provider: scriptedProvider([
    toolCallResult([
      { id: "double-1", name: "double", arguments: { value: 21 } },
    ]),
    textResult("The answer is 42."),
  ]),
});

const result = await runAgent(agent, { input: "Double 21." });

if (result.output !== "The answer is 42.") {
  throw new Error(`unexpected output: ${result.output}`);
}

const usedTool = result.messages.some((message) => message.role === "tool");
if (!usedTool) {
  throw new Error("expected the agent to use the double tool");
}

console.log("agent test passed");

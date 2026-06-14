import { defineAgent, runAgent } from "@infinityi/engine-lib";
import { mockProvider, textResult } from "@infinityi/engine-lib/testing";

const agent = defineAgent({
  name: "assistant",
  provider: mockProvider({
    result: () => textResult("Hello from a local mock provider."),
  }),
  instructions: "Answer briefly.",
});

const result = await runAgent(agent, { input: "Say hello." });

console.log({
  output: result.output,
  steps: result.steps,
  finishReason: result.finishReason,
});

import { asTool, defineAgent, runAgent } from "@infinityi/engine-lib";
import {
  scriptedProvider,
  textResult,
  toolCallResult,
} from "@infinityi/engine-lib/testing";

const researcher = defineAgent({
  name: "researcher",
  instructions: "Research the request and return concise findings.",
  provider: scriptedProvider([
    textResult("Database latency increased after deploy 42."),
  ]),
});

const lead = defineAgent({
  name: "lead",
  instructions: "Delegate research when useful, then answer.",
  tools: [asTool(researcher)],
  provider: scriptedProvider([
    toolCallResult([
      { id: "research-1", name: "researcher", arguments: { input: "latency" } },
    ]),
    textResult("Likely cause: deploy 42 increased database latency."),
  ]),
});

const result = await runAgent(lead, { input: "Why did latency spike?" });

console.log({
  output: result.output,
  totalTokens: result.usage.totalTokens,
});

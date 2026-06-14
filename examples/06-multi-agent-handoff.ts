import { defineAgent, runAgent } from "@infinityi/engine-lib";
import { handoffToolName } from "@infinityi/engine-lib/agent";
import {
  scriptedProvider,
  textResult,
  toolCallResult,
} from "@infinityi/engine-lib/testing";

const billing = defineAgent({
  name: "billing",
  instructions: "Handle billing questions.",
  provider: scriptedProvider([textResult("Refund issued by billing.")]),
});

const triage = defineAgent({
  name: "triage",
  instructions: "Route to the right specialist.",
  handoffs: [billing],
  provider: scriptedProvider([
    toolCallResult([
      { id: "handoff-1", name: handoffToolName("billing"), arguments: {} },
    ]),
  ]),
});

const result = await runAgent(triage, { input: "I need a refund." });

console.log({
  output: result.output,
  finalAgent: result.agent,
  handoffs: result.handoffs,
});

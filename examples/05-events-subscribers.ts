import { defineAgent, runAgent } from "@infinityi/engine-lib";
import type { RunSubscriber } from "@infinityi/engine-lib/events";
import { scriptedProvider, textResult } from "@infinityi/engine-lib/testing";

const auditLog: string[] = [];
const afterFailingSink: string[] = [];

const auditSubscriber: RunSubscriber = async (event) => {
  auditLog.push(event.type);
};

const failingSubscriber: RunSubscriber = async () => {
  throw new Error("audit sink is unavailable");
};

const stillRunsSubscriber: RunSubscriber = async (event) => {
  afterFailingSink.push(event.type);
};

const agent = defineAgent({
  name: "observable",
  provider: scriptedProvider([textResult("done")]),
});

const result = await runAgent(agent, {
  input: "Emit events.",
  subscribers: [auditSubscriber, failingSubscriber, stillRunsSubscriber],
});

console.log({
  output: result.output,
  auditLog,
  afterFailingSink,
});

import {
  createSession,
  defineAgent,
  dynamicContext,
  runAgent,
  staticContext,
} from "@infinityi/engine-lib";
import { scriptedProvider, textResult } from "@infinityi/engine-lib/testing";

const session = createSession({ id: "example-user-1" });
const agent = defineAgent({
  name: "assistant",
  instructions: "Use injected context, but do not assume it is persistent.",
  provider: scriptedProvider([
    textResult("First turn recorded."),
    textResult("Second turn used prior session history."),
  ]),
});

await runAgent(agent, {
  input: "Remember this conversation.",
  session,
  context: [
    staticContext("Plan: enterprise", "Account"),
    dynamicContext("clock", () => "Today is 2026-06-11."),
  ],
});

const second = await runAgent(agent, {
  input: "What happened before?",
  session,
});

const persisted = await session.messages();

console.log({
  secondOutput: second.output,
  persistedRoles: persisted.map((message) => message.role),
});

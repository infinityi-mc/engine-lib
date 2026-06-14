import { createOpenAI, defineAgent, runAgent } from "@infinityi/engine-lib";

const apiKey = process.env.OPENAI_API_KEY;

if (apiKey === undefined || apiKey === "") {
  console.log("Set OPENAI_API_KEY to run the real OpenAI provider example.");
  process.exit(0);
}

const provider = createOpenAI({
  apiKey,
  model: process.env.OPENAI_MODEL ?? "gpt-5",
});

const agent = defineAgent({
  name: "openai-example",
  provider,
  instructions: "Answer in one sentence.",
});

const result = await runAgent(agent, { input: "What is engine-lib?" });

console.log(result.output);

/**
 * Example 2 — terminal coder.
 *
 * A coding terminal streams tokens to the screen, persists the conversation in a
 * session (so history carries across prompts), and lets the agent call
 * file/command tools. Mirrors README "Example 2".
 *
 * Run it:  `bun examples/terminal-coder.ts`
 *
 * Imports from `../src` and uses a scripted provider so it runs offline. In an
 * app you'd `import { ... } from "engine-lib"` with `createOpenAI({ apiKey, model })`.
 */

import { defineAgent } from "../src/agent/index";
import { runAgent } from "../src/execution/index";
import { createSession } from "../src/session/index";
import { defineTool } from "../src/tools/index";
import { s } from "../src/schema/index";
import { scriptedProvider, textResult, toolCallResult } from "../src/testing/index";

const readFile = defineTool({
  name: "read_file",
  description: "Read a file from the workspace.",
  parameters: s.object({ path: s.string() }),
  execute: ({ path }) => ({ ok: true, content: `// ${path}\nexport const answer = 42;\n` }),
});

const runCommand = defineTool({
  name: "run_command",
  description: "Run a shell command in the workspace.",
  parameters: s.object({ command: s.string() }),
  execute: ({ command }) => ({ ok: true, content: `$ ${command}\nok` }),
});

const provider = scriptedProvider([
  toolCallResult([{ id: "c1", name: "read_file", arguments: { path: "src/index.ts" } }]),
  textResult("`src/index.ts` exports `answer = 42`. Want me to add a test for it?"),
]);

const coder = defineAgent({
  name: "terminal-coder",
  provider,
  instructions: "You are a coding assistant operating inside the user's terminal.",
  tools: [readFile, runCommand],
});

// One terminal tab = one session, so history persists across prompts (backed by
// the built-in InMemorySessionStore here).
const session = createSession({ id: "tab-1" });

async function onUserPrompt(prompt: string) {
  process.stdout.write(`\n> ${prompt}\n`);
  const stream = runAgent(coder, { input: prompt, session, stream: true });
  for await (const event of stream) {
    if (event.type === "token") process.stdout.write(event.delta); // live output
    if (event.type === "tool.call") process.stdout.write(`\n  ↻ ${event.name}\n`); // tool spinner
  }
  const result = await stream.completed;
  process.stdout.write(`\n  (turn done — ${result.messages.length} messages persisted)\n`);
}

await onUserPrompt("What does src/index.ts export?");

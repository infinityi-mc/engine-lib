# Getting started

Install the package in an application:

```bash
bun add @infinityi/engine-lib
```

For local development in this repository:

```bash
bun install
bun run check
bun test
bun run build
```

## Minimal run

Use a real provider in production and the testing provider in examples or unit
tests:

```ts
import { defineAgent, runAgent } from "@infinityi/engine-lib";
import { mockProvider, textResult } from "@infinityi/engine-lib/testing";

const agent = defineAgent({
  name: "assistant",
  provider: mockProvider({ result: () => textResult("hello") }),
});

const result = await runAgent(agent, { input: "Say hello." });
console.log(result.output);
```

Runnable version: [`../examples/01-minimal-agent.ts`](../examples/01-minimal-agent.ts).

## Import paths

Prefer the root import for stable application wiring:

```ts
import { defineAgent, defineTool, runAgent, s } from "@infinityi/engine-lib";
```

Use subpaths for domain-specific or optional surfaces:

```ts
import { createOpenAI } from "@infinityi/engine-lib/providers";
import { filesystemTools } from "@infinityi/engine-lib/tools-fs";
import { createSqliteSessionStore } from "@infinityi/engine-lib/session-stores";
import { mockProvider } from "@infinityi/engine-lib/testing";
```

Optional tool packs may need optional peer dependencies from `package.json`
when consumed outside this repository.

## Examples and API docs

Run the offline examples:

```bash
bun run examples
```

Generate local API docs:

```bash
bun run docs
```

Then open `docs/api/index.html`.


# engine-lib

**Agent infrastructure for TypeScript, built on [`@infinityi/forge`](https://github.com/tqcuong2k/forge).**

[![Bun](https://img.shields.io/badge/bun-1.3%2B-orange.svg)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0.3%2B-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Project Goal

Every project that wants to "add an agent" ends up rebuilding the same scaffolding:
a provider client, a message/content model, a tool-calling loop, session state,
context injection, and a way to observe what the agent is doing. It is tedious,
error-prone, and almost never the interesting part of the product.

**engine-lib** is the reusable layer that owns that scaffolding once. It provides a
provider-agnostic way to define agents and tools, run them against any major LLM
provider, manage their conversation state, and observe their behavior — so that a
host application (a coding terminal, a server-management tool, an incident
responder) can import it and start shipping agent features without re-implementing
the plumbing.

It is built on **Forge**, inheriting its config, telemetry, resilience, and
lifecycle primitives rather than reinventing them. Where Forge is "the boring
infrastructure layer your business logic deserves," engine-lib is the boring
*agent* infrastructure layer your product deserves.

---

## Target Users

engine-lib is for **developers building agent-integrated products** — including
the author's own future projects. You are the audience if you are:

- Adding an agent to a **coding terminal / dev tool** that needs to read files, run
  commands, and stream responses.
- Building an **operations / server-management tool** that launches an agent to
  triage incidents, inspect logs, and propose remediations.
- Writing **any backend service** that wants LLM-driven behavior with structured
  tool calls, durable sessions, and first-class observability.

You are **not** the audience if you want a no-code agent builder, a hosted agent
runtime, or an opinionated framework that decides *what* your agent should do.
engine-lib gives you the contracts and the runtime; the behavior is yours.

---

## Core Concepts

| Concept | What it is |
| :--- | :--- |
| **Provider** | A normalized adapter over an LLM API (OpenAI, Anthropic, Google, OpenAI-compatible). It exposes one shape for chat completion, streaming, tool calling, and usage — and declares its capabilities so callers can degrade gracefully. |
| **Message & Content** | A provider-neutral representation of a conversation. Messages carry roles (`system`/`user`/`assistant`/`tool`) and typed content parts (text, tool calls, tool results, images), so history is portable across providers. |
| **Agent** | A declarative definition: which model/provider to use, system instructions, the tools it may call, default generation settings, and lifecycle hooks. An agent is *data*, not a class hierarchy — you describe it, the runtime executes it. |
| **Tool** | A named capability the model can invoke: a parameter schema (validated before execution), an `execute` function, and a typed, structured **tool result**. Tools are how the agent affects the world. |
| **Execution** | The provider-native run loop. The model decides when to call tools using the provider's own tool-calling protocol; the runtime dispatches the calls, validates arguments, feeds results back, and repeats until the model produces a final answer. No hand-rolled ReAct prompt. |
| **Session** | The durable home of a conversation: ordered message history plus metadata. A session can be in-memory (ephemeral) or backed by a store, and is responsible for staying within the model's context window. |
| **Context** | Information injected into a run at execution time — system facts, retrieved documents, environment state — supplied by **context providers** that the host wires in. engine-lib injects context; it does not decide *what* the context is. |
| **Event Emitter** | A typed stream of everything that happens during a run (`run.start`, `message`, `tool.call`, `tool.result`, `token`, `run.finish`, `error`). External subscribers use it for UI streaming, logging, metrics, and auditing without coupling to the runtime internals. |

---

## Design Principles

1. **Provider-native execution, no custom loop.** We do not invent a prompting
   strategy. We use each provider's first-class tool-calling / function-calling
   protocol and let the model drive. This keeps behavior aligned with how the
   model was trained and avoids brittle "Thought/Action/Observation" string
   parsing.
2. **Forge-backed, not reinvented.** Configuration and secrets come from
   `forge/config`, observability from `forge/telemetry`, provider-call hardening
   (timeout, retry, circuit breaking) from `forge/resilience`, and process
   wiring from `forge/lifecycle`. engine-lib adds the agent layer; Forge owns the
   infrastructure.
3. **Contracts over implementations.** `Provider`, `Tool`, `Agent`, `SessionStore`,
   and `ContextProvider` are interfaces first. Every interface ships with an
   in-memory double so consumers can test agents deterministically, mirroring
   Forge's "interfaces first" philosophy.
4. **Schema-validated boundaries, fail-fast.** Tool parameters and structured
   outputs are described by schemas and validated at the boundary. Bad arguments
   become a typed tool error fed back to the model — not an unhandled exception.
5. **Observable by default.** Every run, every provider call, and every tool
   invocation emits events and telemetry spans. You can reconstruct exactly what
   an agent did and why.
6. **Composable, not monolithic.** Use the provider layer without sessions. Use
   sessions without multi-agent coordination. There are no forced peer
   dependencies between sub-modules.
7. **Zero magic.** No global agent registry by default, no decorator-based DI, no
   hidden network calls. Wiring is explicit; the host stays in control.
8. **Developer ergonomics.** The common path (define a provider, define a tool,
   define an agent, run it) should be a handful of well-typed function calls with
   inferred types end-to-end.

---

## Constraints / What Is Not Shipped

To stay a *library* and not a framework, engine-lib explicitly does **not** include:

- **No UI or frontend.** No chat widgets, no terminal renderer. We emit events;
  rendering is the host's job.
- **No opinionated agent logic.** No built-in "researcher" or "coder" personas, no
  default system prompts. You define behavior.
- **No built-in tools.** No web search, no code execution, no file system access
  shipped in the box. Tools are yours to define (the library validates and runs
  them).
- **No prompt template engine.** No templating DSL or prompt library. Instructions
  are plain strings/functions you own.
- **No custom reasoning loop.** No ReAct/CoT/Tree-of-Thought framework — execution
  is provider-native tool calling.
- **No RAG / vector store / embeddings engine.** Context injection is a hook;
  retrieval, chunking, and embedding storage are out of scope. Plug your own in.
- **No model hosting or inference.** engine-lib calls external provider APIs; it
  does not run models.
- **No fine-tuning, training, or evaluation harness.** Out of scope.

If you need one of these, build it *on top of* engine-lib using the provided
contracts.

---

## Usage Examples

> The APIs below illustrate the intended surface. See [`ROADMAP.md`](./ROADMAP.md)
> for what is built in each phase.

### Example 1 — Server crash detected, agent launched to analyze the incident

A monitoring component detects a crash and asks an "incident analyst" agent to
investigate. Logs are injected as context, and the agent is given read-only tools.

```typescript
import { defineConfig, t } from "@infinityi/forge/config";
import { initTelemetry } from "@infinityi/forge/telemetry";
import { stdoutLogExporter } from "@infinityi/forge/telemetry/log/exporters/stdout";

import {
  anthropicProvider,
  defineTool,
  defineAgent,
  runAgent,
  staticContext,
} from "engine-lib";

// Secrets + observability come from Forge.
const config = defineConfig({
  anthropicApiKey: t.secret(t.string()),
});
const telemetry = initTelemetry({
  resource: { serviceName: "incident-responder", serviceVersion: "1.0.0" },
  log: { exporter: stdoutLogExporter(), level: "info" },
});

const provider = anthropicProvider({
  apiKey: config.anthropicApiKey,
  model: "claude-sonnet-4",
});

// A read-only tool the agent may call.
const fetchRecentLogs = defineTool({
  name: "fetch_recent_logs",
  description: "Fetch the last N log lines for a service.",
  parameters: t.object({
    service: t.string(),
    lines: t.number().default(200),
  }),
  execute: async ({ service, lines }) => {
    const logs = await logStore.tail(service, lines);
    return { ok: true, content: logs };
  },
});

const incidentAnalyst = defineAgent({
  name: "incident-analyst",
  provider,
  instructions:
    "You are an SRE assistant. Diagnose the likely root cause of the crash " +
    "and propose concrete next steps. Cite the log lines you relied on.",
  tools: [fetchRecentLogs],
});

// Triggered when a crash is detected.
async function onServerCrash(event: CrashEvent) {
  const result = await runAgent(incidentAnalyst, {
    input: `Service "${event.service}" crashed with exit code ${event.exitCode}.`,
    context: [
      staticContext({
        crashedAt: event.timestamp,
        stackTrace: event.stackTrace,
        deployedVersion: event.version,
      }),
    ],
    telemetry,
    onEvent: (e) => {
      if (e.type === "tool.call") telemetry.log?.info("agent tool call", { tool: e.name });
    },
  });

  await incidentChannel.post(result.output); // result.output: final analysis
}
```

### Example 2 — User sends a prompt in a coding terminal

The terminal streams tokens to the screen, persists the conversation in a session,
and lets the agent call file/command tools.

```typescript
import {
  openaiProvider,
  defineTool,
  defineAgent,
  runAgent,
  createSession,
} from "engine-lib";

const provider = openaiProvider({ apiKey: config.openaiApiKey, model: "gpt-5" });

const readFile = defineTool({
  name: "read_file",
  description: "Read a file from the workspace.",
  parameters: t.object({ path: t.string() }),
  execute: async ({ path }) => ({ ok: true, content: await workspace.read(path) }),
});

const runCommand = defineTool({
  name: "run_command",
  description: "Run a shell command in the workspace.",
  parameters: t.object({ command: t.string() }),
  execute: async ({ command }) => {
    const { stdout, stderr, code } = await workspace.exec(command);
    return code === 0
      ? { ok: true, content: stdout }
      : { ok: false, error: stderr };
  },
});

const coder = defineAgent({
  name: "terminal-coder",
  provider,
  instructions: "You are a coding assistant operating inside the user's terminal.",
  tools: [readFile, runCommand],
});

// One terminal tab = one session, so history persists across prompts.
const session = createSession({ id: terminalTabId });

async function onUserPrompt(prompt: string) {
  const stream = runAgent(coder, { input: prompt, session, stream: true });

  for await (const event of stream) {
    if (event.type === "token") terminal.write(event.delta);          // live output
    if (event.type === "tool.call") terminal.status(`↻ ${event.name}`); // tool spinner
  }
}
```

---

## Relationship to Forge

engine-lib depends on `@infinityi/forge` and reuses it directly:

| Need | Forge module |
| :--- | :--- |
| API keys, model config, fail-fast validation, redacted secrets | `forge/config` |
| Traces/metrics/logs for runs, provider calls, tool calls | `forge/telemetry` |
| Timeout / retry / circuit breaking around provider HTTP calls | `forge/resilience` |
| Booting the agent runtime as a managed component, graceful shutdown | `forge/lifecycle` |
| (Optional) durable session/event persistence | `forge/data`, `forge/messaging` |

---

## Status

Early development. The runtime and provider adapters are being built out in
phases — see [`ROADMAP.md`](./ROADMAP.md). APIs in the examples above describe the
intended surface and may change before a stable release.

---

## Getting Started

```bash
bun install      # install dependencies
bun run check    # type-check (tsc --noEmit)
bun test         # run the test suite
bun run build    # emit dist/ (JS + .d.ts)
```

Phases 1–5 (Foundation & Contracts, Provider Abstraction, Agent & Tool
Contracts, Execution Flow, Context & Session Management) are implemented. Public
entry points:

```ts
import { s, user, system, AgentError, defineTool, defineAgent, runAgent, createSession, staticContext } from "engine-lib";
// or via subpaths:
import { s } from "engine-lib/schema";
import { user } from "engine-lib/messages";
import { AgentError } from "engine-lib/errors";
import { resolveSecret } from "engine-lib/runtime";
import { createOpenAI } from "engine-lib/providers";
import { defineTool } from "engine-lib/tools";
import { defineAgent } from "engine-lib/agent";
import { runAgent } from "engine-lib/execution";
import { createSession } from "engine-lib/session";
import { staticContext, truncateOldest } from "engine-lib/context";
```

`runAgent` drives the provider-native tool-calling loop: it sends the
conversation + tool schemas to the provider, validates and dispatches tool calls
(in parallel, with per-call error isolation), feeds results back, and repeats
until a final answer, the step budget (`MaxStepsExceededError`), or cancellation
(`CancelledError`). It runs buffered (`await runAgent(agent, { input })` →
`RunResult`) or streaming (`runAgent(agent, { input, stream: true })` → an
async-iterable of `RunEvent`s).

Durable conversation state and run-time context injection are wired into the
loop. Pass `session` (from `createSession({ id })`, backed by a `SessionStore` —
`InMemorySessionStore` ships built-in) to resume a conversation: prior history is
read before the run and the new turn is appended after. Pass `context`
(`staticContext` / `dynamicContext` providers) to inject run-time facts into the
system layer — injected context and instructions are rebuilt every run and never
persisted. Pass `contextWindow: { maxTokens, strategy }` to keep the request
within budget via `truncateOldest()` or `summarizeOldest()`, raising
`ContextWindowError` only when history is irreducible; trimming never mutates the
persisted/returned history.

The full multi-subscriber event emitter + telemetry bridge and multi-agent
coordination follow in Phases 6–7 — see [`ROADMAP.md`](./ROADMAP.md). (An
optional `forge/data`-backed `SessionStore` is also deferred to a later change.)

## License

MIT — see [`LICENSE`](./LICENSE).

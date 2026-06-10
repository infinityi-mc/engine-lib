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
- **No root-level built-in tools.** The root package ships no web search, code
  execution, or file system access. Opt-in tool packs such as `tools-shell` and
  `tools-fs` live on explicit subpaths and require host configuration.
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

## Getting Started

```bash
bun install      # install dependencies
bun run check    # type-check (tsc --noEmit)
bun test         # run the test suite
bun run build    # emit dist/ (JS + .d.ts)
```

Public entry points:

```ts
import { s, user, system, AgentError, createOpenAI, defineTool, defineAgent, runAgent, createSession, staticContext, createAgentRegistry, asTool } from "@infinityi/engine-lib";
// or via subpaths:
import { s } from "@infinityi/engine-lib/schema";
import { user } from "@infinityi/engine-lib/messages";
import { AgentError } from "@infinityi/engine-lib/errors";
import { resolveSecret } from "@infinityi/engine-lib/runtime";
import { createOpenAI } from "@infinityi/engine-lib/providers";
import { defineTool } from "@infinityi/engine-lib/tools";
import { shellTools } from "@infinityi/engine-lib/tools-shell";
import { filesystemTools } from "@infinityi/engine-lib/tools-fs";
import { defineAgent, createAgentRegistry, asTool } from "@infinityi/engine-lib/agent";
import { runAgent } from "@infinityi/engine-lib/execution";
import { createSession } from "@infinityi/engine-lib/session";
import { staticContext, truncateOldest } from "@infinityi/engine-lib/context";
import { createEventHub, loggingSubscriber, messageBusSubscriber } from "@infinityi/engine-lib/events";
import { agentRuntimeComponent } from "@infinityi/engine-lib/lifecycle";
// test-only doubles + the cross-provider conformance battery:
import { mockProvider, scriptedProvider, textResult, toolCallResult } from "@infinityi/engine-lib/testing";
import { runProviderConformance } from "@infinityi/engine-lib/testing/conformance";
```

### Stable public API

For application code, prefer the root import or the domain subpaths above. The
root barrel is intentionally focused on the stable, ergonomic surface:

- schema, message, and error helpers (`s`, `user`, `system`, `AgentError`, ...)
- provider factories (`createOpenAI`, `createAnthropic`, `createGoogle`,
  `createOpenAICompatible`)
- agent/tool/run/session/context helpers (`defineTool`, `defineAgent`,
  `runAgent`, `createSession`, `staticContext`, `dynamicContext`)
- multi-agent helpers (`createAgentRegistry`, `asTool`)
- run-event subscribers (`createEventHub`, `loggingSubscriber`,
  `messageBusSubscriber`)

Advanced adapter plumbing remains available from subpaths for custom providers
and tests. For example, `@infinityi/engine-lib/providers` exports `createProvider`,
`createProviderHttp`, `parseSse`, and stream accumulation helpers, while
`@infinityi/engine-lib/events` exports event projection and telemetry helpers. Treat those
as lower-level extension APIs rather than the common application surface.

### Providers

Use the built-in factories for application code:

```ts
const openai = createOpenAI({ apiKey: config.openaiApiKey, model: "gpt-5" });
const anthropic = createAnthropic({ apiKey: config.anthropicApiKey, model: "claude-opus-4-7" });
const google = createGoogle({ apiKey: config.googleApiKey, model: "gemini-2.5-pro" });
const local = createOpenAICompatible({ baseUrl: "http://localhost:1234/v1", model: "local-model" });
```

Provider API keys accept raw strings or Forge `Secret<string>` values. Factory
`model` options become the provider's `defaultModel`; `CompletionRequest.model`
can override the model per request.

The stable provider contract is `Provider`, `CompletionRequest`,
`CompletionResult`, `StreamEvent`, `Usage`, `ProviderCapabilities`, and the
factory option types. `CompletionRequest` contains normalized generation fields
(`temperature`, `topP`, `maxOutputTokens`, `stopSequences`), tool fields
(`tools`, `toolChoice`, `responseSchema`), optional `metadata`, and
`providerOptions` for vendor-specific request body fields that are not yet
first-classed.

`CompletionResult.raw` intentionally remains `unknown`: engine-lib keeps the
portable normalized fields stable, while adapter-aware consumers may narrow the
native response themselves. `ProviderCapabilities` should be treated as adapter
truth; callers can degrade based on those flags, and the conformance suite
checks the built-in adapters for capability honesty.

`@infinityi/engine-lib/providers` also exports advanced extension helpers such as
`createProvider`, `AdapterSpec`, HTTP/SSE utilities, `StreamAccumulator`, and
`collectStream`. Use those for custom adapters and conformance tests, not for
ordinary application wiring.

Runnable, offline examples live in [`examples/`](./examples/) (`bun examples/incident-analysis.ts`),
and the generated API reference is described in [`docs/`](./docs/README.md) (`bun run docs`).

`runAgent` drives the provider-native tool-calling loop: it sends the
conversation + tool schemas to the provider, validates and dispatches tool calls
(in parallel, with per-call error isolation), feeds results back, and repeats
until a final answer, the step budget (`MaxStepsExceededError`), or cancellation
(`CancelledError`). It runs buffered (`await runAgent(agent, { input })` →
`RunResult`) or streaming (`runAgent(agent, { input, stream: true })` → an
async-iterable of `RunEvent`s).

`runAgent` has three stable call shapes:

```ts
const result = await runAgent(agent, { input: "go" });
// Promise<RunResult>

const handle = runAgent(agent, { input: "go", stream: true });
// RunHandle: AsyncIterable<RunEvent> & { completed: Promise<RunResult> }

const maybeStream: boolean = shouldStream();
const resultOrHandle = runAgent(agent, { input: "go", stream: maybeStream });
// Promise<RunResult> | RunHandle
```

Streaming consumers should either drain the async iterable or await
`handle.completed`. Successful streams emit a final `run.finish` event and then
`completed` resolves with the same `RunResult`. If iteration throws,
`completed` rejects with the same error; if iteration is abandoned early,
`completed` rejects with `CancelledError`.

Run events are ordered. Every run starts with `run.start`. Provider assistant
turns are emitted as `message`; streaming text arrives as `token` before the
assistant `message` that contains the accumulated text. Tool calls emit
`tool.call`, then `tool.result`, then the tool-result `message`. Successful runs
end with `run.finish`; failed runs emit `error` and then reject or throw the same
`AgentError`. Tool validation failures, unknown tools, and thrown tool
implementations are isolated as `{ ok: false }` tool results so the model can
recover; provider failures, context/session failures, max-step/max-handoff
limits, and cancellation fail the run.

### Tools and schemas

Use `defineTool()` for application tools. It infers the `execute(args)` type from
the parameter schema and keeps the definition shape stable for future releases:

```ts
const readFile = defineTool({
  name: "read_file",
  description: "Read a file from the workspace.",
  parameters: s.object({
    path: s.string(),
    maxBytes: s.optional(s.number({ int: true })),
  }),
  execute: async ({ path, maxBytes }) => {
    const content = await workspace.read(path, { maxBytes });
    return { ok: true, content };
  },
});
```

Tool results are deliberately small: return `{ ok: true, content }` for success
and `{ ok: false, error }` for expected/domain failures such as missing files or
permission denials. Throw only for unexpected implementation faults; `runAgent`
catches thrown tool errors and feeds them back to the model as recoverable
tool-result errors.

Tool content is rendered predictably for the model. Strings pass through,
`null`/`undefined` become empty text, and non-string values are JSON-encoded.
`error` is a string in the stable contract; use clear, user-actionable messages.

The built-in `s` schema builder covers the JSON-Schema subset engine-lib
validates and providers need for tool parameters. `s.object()` is strict by
default (`additionalProperties: false`), required keys are derived from the
shape, and `s.optional(...)` makes an object key optional in both TypeScript and
runtime validation. Use `asSchema()` / `fromJsonSchema()` when adapting an
external schema library or raw JSON Schema.

Optional prebuilt tools are available from explicit subpaths. `tools-shell`
provides policy-gated command execution; `tools-fs` provides allowed-root
filesystem and workspace tools such as `repo_map`, `find_files`, `search_text`,
`read`, edit tools, patch application, and git diff/status:

```ts
const fs = filesystemTools({ allowedRoots: [process.cwd()] });
const shell = shellTools({ allowedCwds: [process.cwd()] });

const coder = defineAgent({
  name: "coder",
  provider,
  tools: [fs.repoMap, fs.searchText, fs.read, fs.editReplace, shell.runCommand],
});
```

### Agents and composition

Use `defineAgent()` for application agents. An agent definition is plain data:
the provider to call, optional instructions, tools, default generation settings,
hooks, and optional handoff targets. Construction validates the agent name and
duplicate tool names, but does not call the provider or resolve handoff targets.

Instructions may be a string or a function:

```ts
const coder = defineAgent({
  name: "coder",
  provider,
  instructions: (ctx) => `You are ${ctx.agent.name}. Be precise.`,
  tools: [readFile],
  generation: { temperature: 0.2 },
});
```

Resolved instructions are injected into the provider request as system context.
They are rebuilt every run and are not persisted to sessions.

Hooks are awaited and receive the shared engine context. Public run events are
emitted before the corresponding hook is invoked. Hook failures fail the run and
flow through `onError`; if `onError` throws, the original run failure is
preserved.

Agent registries are explicit and host-owned. There is no global registry.
String-named handoff targets require passing `registry` to `runAgent`; direct
`AgentDefinition` handoff targets do not. Each handoff target is advertised as a
synthetic `transfer_to_<agent>` tool, and a real tool with the same name is a
configuration error.

`asTool(agent)` wraps a child agent as a normal tool. The child runs to
completion, its output is returned as the tool result, its usage is folded into
the parent run, and its events surface as `agent.child` events. A failing child
run becomes a tool error so the parent model can recover.

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

### Sessions and context

`createSession()` is synchronous. If no `id` is supplied it generates one; if an
`id` is supplied with a shared store, the session resumes that history lazily on
first use. Seed `messages` are written once and only when the backing store has
no existing history for that id. `messages()` returns a snapshot, `append()`
adds to the tail, and `clear()` deletes the history and prevents the seed from
being re-applied.

`SessionStore` is the durable persistence contract: `load`, `append`, `save`,
and `delete`. Store implementations must preserve message order, treat
`append()` as an atomic tail add, and avoid exposing mutable internal arrays by
reference.

Successful runs append only conversation messages: user input, assistant turns,
and tool-result messages. Instructions, injected context, and handoff-injected
instructions are request-time system messages and are never persisted. Failed
runs do not append new messages.

Context providers resolve once per run before the first provider call.
`staticContext()` injects fixed content; `dynamicContext()` computes content from
the engine context. All provider output is folded into a system message for that
request only and is never persisted.

`contextWindow` applies only to the provider request view. It never mutates the
canonical history returned from `runAgent` or stored in the session.
`truncateOldest()` is the default stable strategy and drops oldest non-system
messages while retaining system messages. `summarizeOldest()` is public, but it
performs an additional provider call and should be chosen deliberately.

### Events, subscribers, and telemetry

Use `onEvent` for a single callback and `subscribers` for fan-out:

```ts
await runAgent(agent, {
  input: "go",
  onEvent: (event) => ui.observe(event),
  subscribers: [loggingSubscriber(logger), messageBusSubscriber(messageBus)],
});
```

`onEvent` is registered first, followed by `subscribers` in array order. Each
subscriber may be sync or async; subscribers are awaited in order, so slow sinks
apply back-pressure. Subscriber failures are isolated: a thrown/rejected
subscriber is reported to the hub's error reporter/logger and does not abort the
run or prevent later subscribers from seeing the event. Undefined subscriber
slots are ignored.

`loggingSubscriber()` writes compact fields from `eventFields()`.
`messageBusSubscriber()` publishes a serializable `eventPayload()` projection.
Those projection helpers are stable on `@infinityi/engine-lib/events` for custom
subscribers, but they are intentionally not root exports.

For telemetry, the stable application path is passing a Forge telemetry handle
to `runAgent`. That enables `agent.run`, `agent.provider.call`, and
`agent.tool.execute` spans plus `agent.run.duration`, `agent.tool.duration`,
`agent.tokens`, and `agent.runs` metrics. `createRunTelemetry()` and the span
constants are available from `@infinityi/engine-lib/events` for advanced integrations and
tests.

### Multi-agent coordination

Compose agents in two complementary ways. Both reuse the same `runAgent` loop —
no separate orchestrator.

**Handoff / delegation.** Declare `handoffs` on an agent and each target becomes
a synthetic `transfer_to_<name>` tool the model can call to transfer the running
conversation to a specialist. The message history is preserved across the switch;
the new agent's instructions are injected as an additional system message. The
`RunResult` reports the agent that produced the final answer (`result.agent`) and
the ordered `result.handoffs` trail. A `maxHandoffs` cap (default 8) bounds
triage↔specialist ping-pong with `MaxHandoffsExceededError`. Targets may be given
directly as an `AgentDefinition`, or by name as a `string` resolved through an
`AgentRegistry` passed in `RunOptions.registry`.

```ts
import { defineAgent, runAgent, createAgentRegistry } from "@infinityi/engine-lib";

const billing = defineAgent({ name: "billing", provider, instructions: "Handle billing." });
const triage = defineAgent({
  name: "triage",
  provider,
  instructions: "Route the user to the right specialist.",
  handoffs: [billing], // → exposes a `transfer_to_billing` tool
});

const result = await runAgent(triage, { input: "I want a refund" });
result.agent;    // "billing" — the specialist answered
result.handoffs; // ["billing"] — the transfer trail

// String-named targets resolve via a registry (no global state):
const registry = createAgentRegistry([billing]);
const router = defineAgent({ name: "router", provider, handoffs: ["billing"] });
await runAgent(router, { input: "…", registry });
```

**Sub-agent-as-tool.** Wrap an agent as a `ToolDefinition` with `asTool(agent)`
so a parent invokes it through the normal tool-calling path. The child runs to
completion and its output is fed back as the tool result; the child's token usage
is folded into the parent's total and its events surface to the parent as
`agent.child` events (with `depth` tracking nesting).

```ts
import { asTool, defineAgent } from "@infinityi/engine-lib";

const researcher = defineAgent({ name: "researcher", provider, instructions: "Research deeply." });
const lead = defineAgent({
  name: "lead",
  provider,
  tools: [asTool(researcher, { description: "Delegate research to a specialist." })],
});
// lead's model calls the "researcher" tool → child run executes → output fed back.
```

### Developer experience & conformance

Three things make the library trustworthy to adopt:

- **Provider conformance suite** — a fixture-driven battery, shipped from
  `@infinityi/engine-lib/testing/conformance`, that every adapter must pass (buffered
  completion, streaming, tool calling, usage, capability honesty, error
  mapping). Each adapter supplies its native wire fixtures plus the canonical
  normalized values; the battery drives the public `Provider` seam through an
  injected fake `fetch`, so third-party adapters can prove parity with the
  in-house ones. Pass Bun's `{ describe, expect, it }` as `testApi` when
  registering the battery. All four built-in adapters are wired through it.
- **Lifecycle adapter** — `agentRuntimeComponent()` (from `@infinityi/engine-lib/lifecycle`)
  adapts the runtime to a `forge/lifecycle` `Component`: `start()` fail-fast
  validates providers (and optionally probes them so a bad deploy rolls back in
  `forge.boot`), `healthcheck()` maps provider probes to a forge `HealthResult`,
  and `stop()` runs an `onStop` hook (e.g. flush/close a durable session store).
- **Test doubles & examples** — network-free helpers in `@infinityi/engine-lib/testing`
  (`mockProvider`, `scriptedProvider`, `textResult`/`toolCallResult`,
  `jsonFetch`/`sseFetch`, `inMemorySessionStore`) let consumers unit-test agents
  deterministically, and [`examples/`](./examples/) holds runnable versions of
  the scenarios above.

```ts
import { boot } from "@infinityi/forge/lifecycle";
import { agentRuntimeComponent } from "@infinityi/engine-lib/lifecycle";

const app = await boot({
  components: [agentRuntimeComponent({ providers: [provider], sessionStore, probeOnStart: true })],
});
// app.ready === true; app.stop() drains it (running the optional onStop hook).
```

(An optional `forge/data`-backed `SessionStore` is deferred to a later change.)

## License

MIT — see [`LICENSE`](./LICENSE).

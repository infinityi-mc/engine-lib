# Roadmap

This roadmap breaks the implementation of **engine-lib** into sequential phases.
Each phase delivers one coherent layer of the library and builds on the phases
before it. The ordering is dependency-driven: earlier phases define contracts that
later phases consume.

Guiding rules for every phase:

- Each contract is an **interface first**, shipped with an **in-memory double** for
  testing (mirroring Forge's "interfaces first" principle).
- Each phase reuses Forge (`config`, `telemetry`, `resilience`, `lifecycle`)
  instead of reinventing infrastructure.
- A phase is "done" when its deliverables are exported, typed, tested against their
  in-memory doubles, and documented with a usage snippet.

---

## Phase 1 — Foundation & Contracts

**Goal:** Establish the project skeleton and the shared types every other layer
depends on, and wire in Forge.

**Deliverables**

- Package/build setup (Bun + TypeScript strict, subpath exports), Forge added as a
  peer/dependency.
- Forge integration surface: helpers to source provider config/secrets from
  `forge/config` and a `telemetry` handle convention passed through the library.
- **Message & content model** — provider-neutral `Message` (roles) and `Content`
  parts (text, tool-call, tool-result, image), plus normalization helpers.
- **Error taxonomy** — an `AgentError` base with subclasses
  (`ProviderError`, `ToolError`, `ToolValidationError`, `ExecutionError`,
  `MaxStepsExceededError`, `CancelledError`, `ContextWindowError`), modeled on
  Forge's per-module error hierarchies.
- **Schema utility** — the schema abstraction used to describe tool parameters and
  structured outputs, with a JSON-Schema export (providers require JSON Schema for
  tool definitions) and a runtime validator.

**Dependencies:** none (foundation).

---

## Phase 2 — Provider Abstraction

**Goal:** A single, normalized interface over the supported LLM APIs.

**Deliverables**

- **`Provider` interface** — `complete()` (single turn) and `stream()` (token /
  tool-call deltas), accepting the Phase 1 message model and tool schemas, and
  returning normalized assistant messages + **usage** (token counts).
- **Capability model** — each provider declares support for tools, streaming,
  multimodal input, parallel tool calls, and structured/JSON output, so callers can
  detect and degrade gracefully.
- **Adapters:** OpenAI, Anthropic, Google, and a generic **OpenAI-compatible**
  adapter (configurable base URL) for self-hosted / third-party gateways.
- **Streaming normalization** — a uniform delta stream across providers (text
  deltas, tool-call deltas, finish reason, usage).
- **Resilience integration** — provider HTTP calls wrapped with `forge/resilience`
  (timeout, retry with backoff, circuit breaker) and traced via `forge/telemetry`.

**Dependencies:** Phase 1 (message model, errors, schema/JSON-Schema export).

---

## Phase 3 — Agent & Tool Contracts

**Goal:** Declarative definitions for agents and tools, plus the tool-result schema.

**Deliverables**

- **`ToolDefinition`** — `name`, `description`, a Phase 1 parameter schema, and a
  typed `execute(args, ctx)` function with inferred argument types.
- **`ToolResult` schema** — a structured result discriminating success vs. error
  (`{ ok: true, content } | { ok: false, error }`), with support for text and
  structured/JSON content, normalized into a tool-result message.
- **`AgentDefinition`** — `name`, `provider`, `instructions` (string or function of
  context), `tools`, default generation settings, and **lifecycle hook** slots
  (`onStart`, `onStep`, `onToolCall`, `onToolResult`, `onFinish`, `onError`).
- **Tool registry** — per-agent tool lookup with name-collision detection, and
  JSON-Schema generation of the toolset for the provider.

**Dependencies:** Phase 1 (schema, messages, errors), Phase 2 (`Provider` referenced
by an agent).

---

## Phase 4 — Execution Flow

**Goal:** Run an agent to completion using the provider-native tool-calling loop.

**Deliverables**

- **`runAgent()`** — the run loop: send messages + tool schemas to the provider,
  receive tool calls, **validate arguments** (Phase 1 schema), dispatch tool
  `execute`, append tool results, and repeat until a final answer or a step limit.
- **Provider-native tool calling** — driven entirely by the provider's
  function-/tool-calling protocol; no custom ReAct/CoT prompt parsing.
- **Parallel tool calls** — execute independent tool calls from a single turn
  concurrently, with per-call error isolation (a failing tool yields a tool error,
  not a crashed run).
- **Streaming mode** — `runAgent(..., { stream: true })` yields the unified event
  stream (tokens + tool lifecycle) while still producing a final result.
- **Cancellation** — `AbortSignal` support that halts the loop and in-flight
  provider/tool calls, surfacing `CancelledError`.
- **Usage aggregation** — accumulate token usage across all steps in the run result.

**Dependencies:** Phase 2 (provider streaming/completion), Phase 3 (agent + tool
contracts, hooks).

---

## Phase 5 — Context & Session Management

**Goal:** Durable conversation state and the mechanism for injecting context.

**Deliverables**

- **`SessionStore` interface** — load/append/save ordered message history keyed by
  session id; an in-memory implementation plus an optional `forge/data`-backed
  store.
- **Session lifecycle** — `createSession()` / resume-by-id so a run continues an
  existing conversation; history is read before a run and updated after.
- **Context-window management** — token budgeting with pluggable strategies
  (truncate-oldest, summarize/compact) to keep history within the model's window;
  emits `ContextWindowError` only when irreducible.
- **Context injection** — a **`ContextProvider`** contract and built-in helpers
  (e.g. `staticContext`) whose output is merged into the system/instruction layer at
  run time. The library injects; the host decides the content (no RAG engine).

**Dependencies:** Phase 1 (messages), Phase 4 (runs read/write sessions and consume
injected context).

---

## Phase 6 — Event System & Lifecycle Hooks

**Goal:** Make every run fully observable to external subscribers.

**Deliverables**

- **Typed event emitter** — a strongly-typed run event union (`run.start`,
  `message`, `token`, `tool.call`, `tool.result`, `run.finish`, `error`) exposed
  both as an `onEvent` callback and an async-iterable stream.
- **Lifecycle hooks** — concrete wiring of the Phase 3 agent hooks into the
  execution loop, with clear ordering guarantees.
- **External subscribers** — multiple independent subscribers (UI streaming,
  audit log, metrics) without coupling to runtime internals; optional bridge that
  republishes run events onto a `forge/messaging` bus.
- **Telemetry bridge** — automatic `forge/telemetry` spans per run, per provider
  call, and per tool call, plus usage/latency metrics.

**Dependencies:** Phase 4 (the loop that produces events), Phase 5 (session/context
events included).

---

## Phase 7 — Multi-Agent Coordination & Registry

**Goal:** Compose multiple agents and let them delegate work.

**Deliverables**

- **Agent registry** — an opt-in named-lookup registry for discovering and
  resolving agents by name (off by default, to preserve "no global state").
- **Handoff / delegation** — a mechanism for one agent to transfer control to
  another (e.g. a triage agent handing off to a specialist), preserving session and
  context.
- **Sub-agent-as-tool** — wrap an agent as a `ToolDefinition` so a parent agent can
  invoke it through the normal tool-calling path, with usage and events propagated
  to the parent run.

**Dependencies:** Phase 3 (tool contract), Phase 4 (execution), Phase 6 (event
propagation across agents).

---

## Phase 8 — Developer Experience & Conformance

**Goal:** Make the library pleasant to adopt and trustworthy across providers.

**Deliverables**

- **Ergonomic, fully-typed APIs** — argument types inferred from tool schemas;
  `defineTool` / `defineAgent` / `runAgent` as the primary surface; minimal
  boilerplate for the common path.
- **In-memory test doubles** — a mock `Provider` (scriptable responses/tool calls)
  and in-memory session store so consumers can unit-test agents deterministically
  with `bun:test`.
- **Provider conformance suite** — a shared test battery every adapter must pass
  (completion, streaming, tool calling, usage reporting, capability honesty) to
  guarantee cross-provider parity.
- **Lifecycle adapter** — an `agentRuntimeComponent` for `forge/lifecycle` so the
  runtime boots and shuts down cleanly inside a Forge app.
- **Documentation & examples** — runnable versions of the README scenarios
  (incident analysis, terminal coder) and an API reference.

**Dependencies:** all prior phases.

---

## Dependency Summary

```
Phase 1  Foundation & Contracts
  └─> Phase 2  Provider Abstraction
        └─> Phase 3  Agent & Tool Contracts
              └─> Phase 4  Execution Flow
                    ├─> Phase 5  Context & Session
                    │     └─> Phase 6  Event System & Hooks
                    │           └─> Phase 7  Multi-Agent & Registry
                    └────────────────────────> Phase 8  DX & Conformance
```

Phases are intended to be implemented in order. Phases 5 and 6 may overlap once the
execution loop (Phase 4) is stable; Phase 8 is cross-cutting and should be advanced
incrementally alongside every phase rather than left entirely to the end.

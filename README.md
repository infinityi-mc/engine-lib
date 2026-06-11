# engine-lib

**Agent infrastructure for TypeScript, built on [`@infinityi/forge`](https://github.com/tqcuong2k/forge).**

[![Bun](https://img.shields.io/badge/bun-1.3%2B-orange.svg)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0.3%2B-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Project Goal

Every project that wants to add an agent ends up rebuilding the same
scaffolding: a provider client, a message/content model, a tool-calling loop,
session state, context injection, and a way to observe what the agent is doing.
It is tedious, error-prone, and rarely the interesting part of the product.

`engine-lib` is the reusable layer that owns that scaffolding once. It provides
a provider-agnostic way to define agents and tools, run them against major LLM
providers, manage conversation state, and observe behavior so a host
application can ship agent features without re-implementing the plumbing.

It is built on `@infinityi/forge`, inheriting its configuration, telemetry,
resilience, and lifecycle primitives rather than rebuilding those concerns.
Where Forge is the infrastructure layer for application services, `engine-lib`
is the agent infrastructure layer for products that need agent behavior.

## Target Users

`engine-lib` is for developers building agent-integrated products, including:

- coding terminals and developer tools that need file access, command execution,
  streaming, and tool-calling behavior
- operations and server-management tools that need incident triage, log
  inspection, and remediation workflows
- backend services that need LLM-driven behavior with structured tools, durable
  sessions, and observability

It is not intended to be a no-code agent builder, hosted runtime, UI framework,
prompt template system, RAG engine, vector store, model host, or evaluation
platform.

## Core Concepts

| Concept | Description |
| --- | --- |
| Provider | A normalized adapter over an LLM API. Built-in adapters cover OpenAI, Anthropic, Google, and OpenAI-compatible APIs. |
| Message and content | A provider-neutral conversation model with typed content parts for text, tool calls, tool results, and images. |
| Agent | A declarative definition containing provider, instructions, tools, generation defaults, hooks, and optional handoff targets. |
| Tool | A schema-validated capability the model can invoke. Tools return structured success or failure results. |
| Execution | The provider-native run loop that dispatches tool calls and repeats until a final answer, cancellation, or budget failure. |
| Session | Durable conversation state: ordered message history plus metadata behind a pluggable store. |
| Context | Request-time information injected by host-provided context providers and never persisted as conversation history. |
| Events | A typed event stream for UI streaming, logs, metrics, auditing, telemetry, and optional tool-pack audit data. |

## Design Principles

1. Provider-native execution, no custom reasoning loop.
2. Forge-backed configuration, telemetry, resilience, and lifecycle integration.
3. Contracts over implementations for providers, tools, sessions, context, and
   events.
4. Schema-validated boundaries with fail-fast validation.
5. Observable behavior by default.
6. Composable modules instead of a monolithic framework.
7. Explicit wiring and no hidden global runtime.
8. Strong TypeScript ergonomics for common application paths.

## Scope

The root package exports the stable application surface:

- schema, message, and error helpers
- provider factories
- tool and agent definition helpers
- execution, session, and context helpers
- multi-agent helpers
- event subscribers and telemetry integration hooks

Optional subpaths provide advanced or opt-in features:

- provider adapter plumbing
- durable session stores
- shell, filesystem, HTTP, and web tool packs
- testing doubles and provider conformance helpers
- Forge lifecycle integration

The root barrel intentionally does not expose shell execution, filesystem
access, HTTP access, web crawling, browser automation, hosted retrieval, or UI
components. Those capabilities are either explicit opt-in subpaths or outside
the library's scope.

## Documentation

Consumer documentation lives in [`docs/`](./docs/README.md). The docs cover
installation, public import paths, providers, tools, execution, sessions,
context, events, multi-agent coordination, optional tool packs, testing, and
lifecycle integration.

API reference is generated with TypeDoc:

```bash
bun run docs
```

Generated API output is written to `docs/api/`.

## Development

```bash
bun install
bun run check
bun test
bun run build
```

Useful scripts:

- `bun run check` - type-check the repository
- `bun test` - run the test suite
- `bun run build` - emit JavaScript and declaration files to `dist/`
- `bun run docs` - generate TypeDoc API reference

## License

MIT - see [`LICENSE`](./LICENSE).

# Guide: engine-lib from basic to advanced

This folder is the recommended learning path for `@infinityi/engine-lib`.

## Reading order

1. [Getting started](./01-getting-started.md)
2. [Providers](./02-providers.md)
3. [Tools and schemas](./03-tools-and-schemas.md)
4. [Execution](./04-execution.md)
5. [Sessions and context](./05-sessions-and-context.md)
6. [Multi-agent coordination](./06-multi-agent.md)
7. [Optional tool packs](./07-optional-tool-packs.md)
8. [Retrieval and memory](./08-retrieval-and-memory.md)
9. [Events, telemetry, and governance](./09-events-telemetry-and-governance.md)
10. [Testing and lifecycle](./10-testing-and-lifecycle.md)
11. [Approval, authorization, and resilience](./11-approval-authorization-and-resilience.md)
12. [API map](./12-api-map.md)

## What this guide set covers

These guides cover the full public feature set exposed by the root package and
published subpaths:

- core agent definition and execution
- provider integrations and adapter primitives
- schema-validated tools and tool-result mapping
- sessions, context, checkpointing, and durable stores
- multi-agent handoffs and sub-agent tools
- shell, filesystem, HTTP, web, and sandbox tool packs
- retrieval, embeddings, vector stores, and cross-session memory
- events, telemetry, audit logging, redaction, and policy composition
- testing doubles, conformance utilities, and Forge lifecycle integration
- approval, authorization, retry, circuit breakers, budgets, and rate limiting

For generated API reference, run `bun run docs` and open `docs/api/index.html`.

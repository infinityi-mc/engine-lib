# API map

## Goal

Use this page as a final reference for where each public feature lives.

## Root package

Import from `@infinityi/engine-lib` for the stable application surface:

- errors: `AgentError`, `ProviderError`, `ToolError`, `SchemaValidationError`,
  `SessionAgentMismatchError`, `SessionModelMismatchError`, and more
- schema: `s`, `asSchema`, `fromJsonSchema`, `toJsonSchema`, `validateJsonSchema`
- messages: `user`, `assistant`, `system`, `text`, `toolResult`, `normalizeContent`
- runtime: `isSecret`, `resolveSecret`
- providers: `createOpenAI`, `createAnthropic`, `createGoogle`, `createOpenAICompatible`
- tools: `defineTool`
- agents: `defineAgent`, `asTool`, `createAgentRegistry`
- execution: `runAgent`
- sessions: `createSession`, `forkSession`, `readResumeInfo`, `withResumeInfo`
- context: `staticContext`, `dynamicContext`, `truncateOldest`, `truncateToolAware`, `summarizeOldest`
- events: `createEventHub`, `loggingSubscriber`, `messageBusSubscriber`
- approval: `askHumanTool`, `deferredHumanInputGateway`, `trustApprovalPolicy`
- authorization: `roleToolAuthorizer`
- resilience: `evaluateBudget`, `withProviderRetry`, `circuitBreaker`, rate limiters
- governance: `auditSubscriber`, `jsonlAuditLog`, `forgeDataAuditLog`, redaction helpers

## Subpaths and when to use them

| Import | Use when you need |
| --- | --- |
| `@infinityi/engine-lib/schema` | schema conversion or validation beyond root-level usage |
| `@infinityi/engine-lib/messages` | direct message/content-part construction |
| `@infinityi/engine-lib/errors` | explicit error taxonomy integration |
| `@infinityi/engine-lib/runtime` | Forge secret or telemetry interop |
| `@infinityi/engine-lib/providers` | custom adapters, HTTP/SSE plumbing, stream accumulation |
| `@infinityi/engine-lib/tools` | provider-tool mapping and tool-result rendering |
| `@infinityi/engine-lib/agent` | advanced registries and handoff helpers |
| `@infinityi/engine-lib/execution` | run types, limits, usage helpers, run-id helpers |
| `@infinityi/engine-lib/session` | direct session contract access |
| `@infinityi/engine-lib/session-stores` | durable stores, codecs, compaction, migrations |
| `@infinityi/engine-lib/context` | token estimation and context-window internals |
| `@infinityi/engine-lib/retrieval` | indexing, retrieval, vector stores, memory |
| `@infinityi/engine-lib/events` | event projections and telemetry helpers |
| `@infinityi/engine-lib/approval` | human input and approval policy flows |
| `@infinityi/engine-lib/governance` | audit sinks, policy composition, redaction |
| `@infinityi/engine-lib/resilience` | budgets, retries, circuit breakers, rate limiting |
| `@infinityi/engine-lib/tools-shell` | command execution tools |
| `@infinityi/engine-lib/tools-fs` | filesystem and workspace tools |
| `@infinityi/engine-lib/tools-http` | controlled outbound HTTP tools |
| `@infinityi/engine-lib/tools-web` | static web/search tools |
| `@infinityi/engine-lib/tools-sandbox` | command isolation adapters |
| `@infinityi/engine-lib/testing` | mock providers, result builders, fetch doubles |
| `@infinityi/engine-lib/testing/conformance` | provider conformance battery |
| `@infinityi/engine-lib/lifecycle` | Forge lifecycle adapter |

## Suggested reading paths

- **Application developer**: 01 → 05 → 09 → 10
- **Coding-agent builder**: 01 → 03 → 04 → 07 → 09 → 11
- **Adapter author**: 02 → 04 → 09 → 10 → 12
- **Production platform team**: 05 → 09 → 10 → 11 → 12

## Result

You now have a guide-based map of the full public library surface from basic use
through advanced operational controls.

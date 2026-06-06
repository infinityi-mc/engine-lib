/**
 * `engine-lib` — agent infrastructure for TypeScript, built on
 * `@infinityi/forge`.
 *
 * This root barrel re-exports the full public surface: the schema contract,
 * conversation model, error taxonomy, forge integration surface, providers,
 * tools, agents, multi-agent coordination, the execution loop, sessions,
 * context strategies, and events/telemetry.
 *
 * Every domain is also importable from its own subpath for tree-shaking:
 * `engine-lib/schema`, `engine-lib/messages`, `engine-lib/errors`,
 * `engine-lib/runtime`, `engine-lib/providers`, `engine-lib/tools`,
 * `engine-lib/agent`, `engine-lib/execution`, `engine-lib/session`,
 * `engine-lib/context`, `engine-lib/events`, and `engine-lib/lifecycle`
 * (forge lifecycle adapter). Test-only helpers live on `engine-lib/testing`,
 * and the fixture-driven provider battery on `engine-lib/testing/conformance`
 * (the only subpath that imports a test runner).
 *
 * @module
 */

// Errors
export {
  AgentError,
  CancelledError,
  ContextWindowError,
  ExecutionError,
  MaxHandoffsExceededError,
  MaxStepsExceededError,
  ProviderError,
  SchemaValidationError,
  ToolError,
  ToolValidationError,
} from "./errors";
export type { SchemaIssue } from "./errors";

// Schema
export { asSchema, fromJsonSchema, s, toJsonSchema, validateJsonSchema } from "./schema/index";
export type { Infer, JsonSchema, SafeParseResult, Schema } from "./schema/index";

// Messages
export {
  assistant,
  normalizeContent,
  system,
  text,
  toolResult,
  user,
} from "./messages/index";
export type {
  ContentPart,
  ImagePart,
  Message,
  Role,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "./messages/index";

// Runtime (forge integration)
export { isSecret, resolveSecret, Secret } from "./runtime/index";
export type { EngineContext, TelemetryHandle } from "./runtime/index";

// Providers (Phase 2)
export {
  collectStream,
  createAnthropic,
  createGoogle,
  createOpenAI,
  createOpenAICompatible,
  createProvider,
  createProviderHttp,
  defaultProviderResilience,
  openSseStream,
  parseSse,
  StreamAccumulator,
  toProviderError,
} from "./providers/index";
export type {
  AdapterSpec,
  AnthropicOptions,
  CompletionRequest,
  CompletionResult,
  FinishReason,
  GoogleOptions,
  OpenAICompatibleOptions,
  OpenAIOptions,
  Provider,
  ProviderCapabilities,
  ProviderHttpOptions,
  ProviderTool,
  ResponseSchema,
  SseMessage,
  StreamEvent,
  ToolCall,
  ToolChoice,
  Usage,
} from "./providers/index";

// Tools (Phase 3)
export { defineTool, renderToolContent, toProviderTool, toToolResultMessage } from "./tools/index";
export type {
  ToolContext,
  ToolDefinition,
  ToolFailure,
  ToolResult,
  ToolSpec,
  ToolSuccess,
} from "./tools/index";

// Agent (Phase 3)
export { createToolRegistry, defineAgent } from "./agent/index";
export type {
  AgentDefinition,
  AgentHooks,
  GenerationSettings,
  InstructionContext,
  Instructions,
  ToolRegistry,
} from "./agent/index";

// Multi-agent coordination (Phase 7)
export { asTool, createAgentRegistry } from "./agent/index";
export { handoffProviderTools, handoffToolName, resolveHandoffTargets } from "./agent/index";
export type { AgentRegistry, AsToolOptions } from "./agent/index";

// Execution (Phase 4)
export { addUsage, DEFAULT_MAX_HANDOFFS, DEFAULT_MAX_STEPS, emptyUsage, runAgent } from "./execution/index";
export type {
  RunBridge,
  RunEvent,
  RunHandle,
  RunInput,
  RunOptions,
  RunResult,
} from "./execution/index";

// Session (Phase 5)
export { createSession, InMemorySessionStore } from "./session/index";
export type {
  CreateSessionOptions,
  Session,
  SessionState,
  SessionStore,
} from "./session/index";

// Context (Phase 5)
export {
  applyContextWindow,
  dynamicContext,
  estimateTokens,
  resolveContext,
  staticContext,
  summarizeOldest,
  truncateOldest,
} from "./context/index";
export type {
  ContextItem,
  ContextProvider,
  ContextStrategy,
  ContextStrategyContext,
  ContextWindowOptions,
  TokenCounter,
} from "./context/index";

// Events & telemetry (Phase 6)
export {
  createEventHub,
  createRunTelemetry,
  eventFields,
  eventPayload,
  loggingSubscriber,
  messageBusSubscriber,
  SPAN_PROVIDER,
  SPAN_RUN,
  SPAN_TOOL,
} from "./events/index";
export type {
  Attrs,
  EventHub,
  EventHubOptions,
  LoggingSubscriberOptions,
  LogLevel,
  MessageBusSubscriberOptions,
  RunSubscriber,
  RunTelemetry,
  SpanHandle,
} from "./events/index";

/**
 * `@infinityi/engine-lib` — agent infrastructure for TypeScript, built on
 * `@infinityi/forge`.
 *
 * This root barrel re-exports the stable, ergonomic public surface: schemas,
 * messages, errors, provider factories, tools, agents, multi-agent helpers, the
 * execution loop, sessions, context helpers, and event subscribers.
 *
 * Lower-level adapter and transport helpers are intentionally kept off the root
 * import. Every domain is importable from its own subpath for tree-shaking and
 * for advanced integrations:
 * `@infinityi/engine-lib/schema`, `@infinityi/engine-lib/messages`, `@infinityi/engine-lib/errors`,
 * `@infinityi/engine-lib/runtime`, `@infinityi/engine-lib/providers`, `@infinityi/engine-lib/tools`,
 * `@infinityi/engine-lib/agent`, `@infinityi/engine-lib/execution`, `@infinityi/engine-lib/session`,
 * `@infinityi/engine-lib/context`, `@infinityi/engine-lib/events`, and `@infinityi/engine-lib/lifecycle`
 * (forge lifecycle adapter). Test-only helpers live on `@infinityi/engine-lib/testing`,
 * and the fixture-driven provider battery on `@infinityi/engine-lib/testing/conformance`
 * (the only subpath that imports a test runner).
 *
 * @module
 */

// Errors
export {
  AgentError,
  BudgetExceededError,
  CancelledError,
  ContextWindowError,
  ExecutionError,
  FilesystemPolicyError,
  MaxHandoffsExceededError,
  MaxStepsExceededError,
  ProviderError,
  SchemaValidationError,
  SessionModelMismatchError,
  ToolError,
  ToolValidationError,
} from "./errors";
export type { SchemaIssue } from "./errors";

// Schema
export {
  asSchema,
  fromJsonSchema,
  s,
  toJsonSchema,
  validateJsonSchema,
} from "./schema/index";
export type {
  Infer,
  JsonSchema,
  SafeParseResult,
  Schema,
} from "./schema/index";

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
  createAnthropic,
  createGoogle,
  createOpenAI,
  createOpenAICompatible,
} from "./providers/index";
export type {
  AnthropicOptions,
  CompletionRequest,
  CompletionResult,
  FinishReason,
  GoogleOptions,
  OpenAICompatibleOptions,
  OpenAIOptions,
  Provider,
  ProviderCapabilities,
  ProviderTool,
  ResponseSchema,
  StreamEvent,
  ToolCall,
  ToolChoice,
  Usage,
} from "./providers/index";

// Tools (Phase 3)
export { defineTool } from "./tools/index";
export type {
  ToolContext,
  ToolDefinition,
  ToolFailure,
  ToolResult,
  ToolSpec,
  ToolSuccess,
} from "./tools/index";

// Agent (Phase 3)
export { defineAgent } from "./agent/index";
export type {
  AgentDefinition,
  AgentHooks,
  GenerationSettings,
  InstructionContext,
  Instructions,
} from "./agent/index";

// Multi-agent coordination (Phase 7)
export { asTool, createAgentRegistry } from "./agent/index";
export type { AgentRegistry, AsToolOptions } from "./agent/index";

// Execution (Phase 4)
export { runAgent } from "./execution/index";
export type {
  AnyRunOptions,
  BufferedRunOptions,
  CheckpointPolicy,
  ResumeOptions,
  RunBridge,
  RunCheckpoint,
  RunEvent,
  RunHandle,
  RunInput,
  RunOptions,
  RunResult,
  StreamingRunOptions,
} from "./execution/index";

// Session (Phase 5)
export {
  RESUME_METADATA_KEY,
  RESUME_SCHEMA_VERSION,
  createSession,
  InMemorySessionStore,
  readResumeInfo,
  withResumeInfo,
} from "./session/index";
export type {
  AppendResult,
  CreateSessionOptions,
  Session,
  SessionListItem,
  SessionListOptions,
  SessionListOrder,
  SessionListPage,
  SessionModelIdentity,
  SessionResumeInfo,
  SessionRunStatus,
  SessionState,
  SessionStore,
  SessionUsage,
} from "./session/index";

// Context (Phase 5)
export {
  dynamicContext,
  staticContext,
  summarizeOldest,
  truncateOldest,
  truncateToolAware,
} from "./context/index";
export type {
  ContextItem,
  ContextProvider,
  ContextResolveContext,
  ContextStrategy,
  ContextStrategyContext,
  ContextWindowOptions,
  TokenCounter,
} from "./context/index";

// Events & telemetry (Phase 6)
export {
  createEventHub,
  loggingSubscriber,
  messageBusSubscriber,
} from "./events/index";
export type {
  EventHub,
  EventHubOptions,
  LoggingSubscriberOptions,
  LogLevel,
  MessageBusSubscriberOptions,
  RunSubscriber,
} from "./events/index";

// Approval / HITL
export {
  TRUST_METADATA_KEY,
  askHumanTool,
  compareTrust,
  deferredHumanInputGateway,
  trustApprovalPolicy,
} from "./approval/index";
export type {
  ApprovalDecision,
  ApprovalGrant,
  ApprovalPendingCall,
  ApprovalPolicy,
  ApprovalRequest,
  AskHumanConfig,
  DeferredHumanInputGateway,
  HumanInputGateway,
  HumanInputRequest,
  TrustApprovalOptions,
  TrustLevel,
  TrustState,
} from "./approval/index";

// Resilience
export {
  circuitBreaker,
  evaluateBudget,
  fixedWindowRateLimiter,
  isTokenRateLimiter,
  slidingWindowRateLimiter,
  tokenBucketRateLimiter,
  withProviderRetry,
} from "./resilience/index";
export type {
  BudgetBreach,
  BudgetField,
  CircuitBreakerOptions,
  ProviderRetryEvent,
  RateLimitAcquireContext,
  RateLimiter,
  RetryPolicy,
  RunBudget,
  TokenRateLimiter,
} from "./resilience/index";

// Governance / DLP
export {
  applyFilters,
  defaultRedactionPatterns,
  filterMessageText,
  filterMessagesText,
  redactTextForPersistence,
  redactingCodec,
  regexRedactor,
  schemaSensitiveRedactor,
} from "./governance/index";
export type {
  ContentFilter,
  ContentFilterConfig,
  FilterContext,
  FilterStage,
  RedactionPattern,
} from "./governance/index";

/**
 * `engine-lib` — agent infrastructure for TypeScript, built on
 * `@infinityi/forge`.
 *
 * Phase 1 (Foundation & Contracts) exposes the shared building blocks the
 * rest of the library is built on: the schema contract, the conversation
 * model, the error taxonomy, and the forge integration surface. Provider,
 * agent, tool, execution, session, and event APIs follow in later phases
 * (see `ROADMAP.md`).
 *
 * Sub-paths are also available: `engine-lib/schema`, `engine-lib/messages`,
 * `engine-lib/errors`, `engine-lib/runtime`, `engine-lib/providers`,
 * `engine-lib/testing`.
 *
 * @module
 */

// Errors
export {
  AgentError,
  CancelledError,
  ContextWindowError,
  ExecutionError,
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

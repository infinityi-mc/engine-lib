/**
 * `@infinityi/engine-lib/providers` — the unified LLM provider surface.
 *
 * Re-exports the normalized {@link Provider} contract, the streaming model, the
 * four shipped adapters ({@link createOpenAI}, {@link createAnthropic},
 * {@link createGoogle}, {@link createOpenAICompatible}), and advanced adapter
 * plumbing.
 *
 * Most applications should import provider factories from the root package or
 * from this subpath. `createProvider`, HTTP/SSE helpers, and stream
 * accumulation utilities are for custom provider adapters and conformance
 * tests; they are intentionally not re-exported from the root barrel.
 *
 * @module
 */

export type {
  CompletionRequest,
  CompletionResult,
  FinishReason,
  Provider,
  ProviderCapabilities,
  ProviderTool,
  ResponseSchema,
  ToolCall,
  ToolChoice,
  Usage,
} from "./types";

export type { StreamEvent } from "./stream";
export { collectStream, StreamAccumulator } from "./stream";

export {
  createProviderHttp,
  defaultProviderResilience,
  openSseStream,
  toProviderError,
  DEFAULT_TIMEOUT_MS,
} from "./http";
export type { ProviderHttpOptions, SseRequest } from "./http";

export { DEFAULT_SSE_IDLE_TIMEOUT_MS, parseSse } from "./sse";
export type { SseMessage, SseParseOptions } from "./sse";

export { createProvider } from "./adapter";
export type { AdapterSpec } from "./adapter";

export { createOpenAI } from "./openai/index";
export type { OpenAIOptions } from "./openai/index";

export { createAnthropic } from "./anthropic/index";
export type { AnthropicOptions } from "./anthropic/index";

export { createGoogle } from "./google/index";
export type { GoogleOptions } from "./google/index";

export { createOpenAICompatible } from "./openai-compatible/index";
export type { OpenAICompatibleOptions } from "./openai-compatible/index";

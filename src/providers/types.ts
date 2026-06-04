/**
 * The normalized LLM provider contract.
 *
 * A {@link Provider} hides each vendor's wire format behind two methods —
 * {@link Provider.complete} (one buffered turn) and {@link Provider.stream}
 * (a unified delta stream) — both speaking the Phase-1 {@link Message} model
 * and {@link JsonSchema} tool/output schemas. Adapters translate to/from the
 * provider's native shape; nothing above this layer knows which vendor is in
 * use.
 *
 * @module
 */

import type { Message } from "../messages/types";
import type { EngineContext } from "../runtime/types";
import type { JsonSchema } from "../schema/types";
import type { StreamEvent } from "./stream";

/** A tool advertised to the model: a name plus JSON-Schema parameters. */
export interface ProviderTool {
  readonly name: string;
  readonly description?: string;
  /** JSON Schema for the arguments object (from a Phase-1 `Schema.jsonSchema`). */
  readonly parameters: JsonSchema;
}

/** How the model is allowed to use tools this turn. */
export type ToolChoice = "auto" | "none" | "required" | { readonly name: string };

/** Request a structured (JSON-Schema-constrained) response. */
export interface ResponseSchema {
  readonly name: string;
  readonly schema: JsonSchema;
  /** Enforce exact schema conformance where the provider supports it. Default `true`. */
  readonly strict?: boolean;
}

/** A provider-neutral request for a single model turn. */
export interface CompletionRequest {
  /** Model id; falls back to the provider's `defaultModel` when omitted. */
  readonly model?: string;
  /** Conversation so far (Phase-1 model); adapters extract any system message. */
  readonly messages: Message[];
  readonly tools?: ProviderTool[];
  readonly toolChoice?: ToolChoice;
  readonly responseSchema?: ResponseSchema;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stopSequences?: readonly string[];
  /** Vendor-neutral request metadata (e.g. an end-user id). */
  readonly metadata?: Record<string, string>;
  /**
   * Escape hatch merged into the provider request body, for features not yet
   * first-classed here (reasoning/thinking knobs, server-side built-in tools,
   * safety settings, stateful conversation ids, …).
   */
  readonly providerOptions?: Record<string, unknown>;
}

/** Token accounting, normalized across providers. */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** Reasoning/thinking tokens, when the provider reports them separately. */
  readonly reasoningTokens?: number;
  /** Prompt tokens served from cache, when reported. */
  readonly cachedInputTokens?: number;
}

/** Why the model stopped generating, normalized across providers. */
export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "error"
  | "other";

/** A tool call the model requested. `arguments` is parsed JSON when possible. */
export interface ToolCall {
  /** Correlation id (OpenAI `call_id` / Anthropic `tool_use.id` / Gemini `functionCall.id`). */
  readonly id: string;
  readonly name: string;
  /** Parsed arguments object, or `undefined` if the raw text was not valid JSON. */
  readonly arguments: unknown;
  /** Raw arguments text as emitted by the model (always preserved). */
  readonly argumentsText?: string;
}

/** The normalized result of a single completion. */
export interface CompletionResult {
  /** Assistant message in the Phase-1 model (text + tool-call parts). */
  readonly message: Message;
  /** Tool calls surfaced from the message, for convenience. */
  readonly toolCalls: ToolCall[];
  readonly finishReason: FinishReason;
  readonly usage?: Usage;
  /** The model id that produced this result. */
  readonly model: string;
  /** The provider-native response object (lossless escape hatch). */
  readonly raw: unknown;
}

/** Declared, queryable provider capabilities so callers can degrade gracefully. */
export interface ProviderCapabilities {
  readonly tools: boolean;
  readonly streaming: boolean;
  readonly multimodalInput: boolean;
  readonly parallelToolCalls: boolean;
  readonly structuredOutput: boolean;
}

/** The normalized LLM provider contract. */
export interface Provider {
  /** Stable provider id, e.g. `"openai"`, `"anthropic"`, `"google"`. */
  readonly name: string;
  /** Model used when a {@link CompletionRequest} omits `model`. */
  readonly defaultModel: string;
  readonly capabilities: ProviderCapabilities;
  /** Run one turn and return the buffered, normalized result. */
  complete(req: CompletionRequest, ctx?: EngineContext): Promise<CompletionResult>;
  /** Run one turn, yielding a unified stream of {@link StreamEvent}s. */
  stream(req: CompletionRequest, ctx?: EngineContext): AsyncIterable<StreamEvent>;
}

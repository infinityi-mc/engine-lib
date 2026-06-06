/**
 * The normalized LLM provider contract.
 *
 * A {@link Provider} hides each vendor's wire format behind two methods —
 * {@link Provider.complete} (one buffered turn) and {@link Provider.stream}
 * (a unified delta stream) — both speaking the Phase-1 {@link Message} model
 * and {@link JsonSchema} tool/output schemas. Adapters translate to/from the
 * provider's native shape; nothing above this layer knows which vendor is in
 * use. The stable application surface is the {@link Provider} contract, request
 * / result / stream types, capabilities, and the built-in provider factories.
 * Adapter scaffolding lives on `engine-lib/providers` as an advanced extension
 * surface.
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

/**
 * A provider-neutral request for a single model turn.
 *
 * `model` overrides the provider's `defaultModel` for this request only.
 * Generation knobs are normalized across providers. `providerOptions` is the
 * sanctioned escape hatch for vendor-specific fields that are not yet
 * first-classed in this interface.
 */
export interface CompletionRequest {
  /** Model id; falls back to the provider's `defaultModel` when omitted. */
  readonly model?: string;
  /** Conversation so far (Phase-1 model); adapters extract any system message. */
  readonly messages: Message[];
  /** Provider-facing tool declarations for this turn. */
  readonly tools?: ProviderTool[];
  /** How the model may use tools this turn. */
  readonly toolChoice?: ToolChoice;
  /** Optional structured-output schema for providers that support it. */
  readonly responseSchema?: ResponseSchema;
  /** Maximum tokens the model may generate in the response. */
  readonly maxOutputTokens?: number;
  /** Sampling temperature, provider-normalized where possible. */
  readonly temperature?: number;
  /** Nucleus sampling value, provider-normalized where possible. */
  readonly topP?: number;
  /** Stop sequences passed through when supported. */
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
  /**
   * The provider-native response object. This intentionally remains `unknown`:
   * consumers may narrow it when they know the adapter, while engine-lib keeps
   * the normalized result portable.
   */
  readonly raw: unknown;
}

/**
 * Declared, queryable provider capabilities so callers can degrade gracefully.
 *
 * Adapter authors should treat these as capability truth: the conformance suite
 * validates that built-in adapters are honest about supported features.
 */
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

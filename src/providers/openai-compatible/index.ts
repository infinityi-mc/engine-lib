/**
 * Generic OpenAI-compatible provider adapter — the **Chat Completions** API
 * (`POST {baseUrl}/chat/completions`). Targets vLLM, Together, Groq,
 * OpenRouter, LM Studio, and anything else speaking that wire format.
 *
 * @module
 */

import type { Secret } from "@infinityi/forge/config";
import type { FetchLike, PipelineLike } from "@infinityi/forge/http/client";
import { resolveSecret } from "../../runtime/secret";
import { createProvider } from "../adapter";
import type { Provider, ProviderCapabilities } from "../types";
import { buildChatBody, parseChatResponse } from "./map";
import { translateChatStream } from "./stream";

/** Construction options for the OpenAI-compatible adapter. */
export interface OpenAICompatibleOptions {
  /** Required base URL for the OpenAI-compatible server (e.g. `https://api.together.xyz/v1`). */
  readonly baseUrl: string;
  /** API key (raw string or a forge `Secret`). Optional for keyless local servers. */
  readonly apiKey?: string | Secret<string>;
  /** Adapter name, surfaced on the {@link Provider} and in errors. Default `"openai-compatible"`. */
  readonly name?: string;
  /** Model used when a request omits `model`. */
  readonly model: string;
  readonly timeoutMs?: number;
  readonly resilience?: PipelineLike;
  readonly fetch?: FetchLike;
  readonly defaultHeaders?: Record<string, string>;
  /** Override the declared capabilities (servers vary in tool/stream support). */
  readonly capabilities?: Partial<ProviderCapabilities>;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  tools: true,
  streaming: true,
  multimodalInput: true,
  parallelToolCalls: true,
  structuredOutput: true,
};

/**
 * Create a generic OpenAI-compatible (Chat Completions) {@link Provider}.
 *
 * `apiKey` may be omitted for local/keyless servers or supplied as a raw string
 * or Forge `Secret`. `model` becomes the provider's `defaultModel`; callers can
 * still override `CompletionRequest.model` per request. Use `capabilities` to
 * honestly describe the target server when it lacks tool, stream, multimodal,
 * parallel-tool, or structured-output support.
 */
export function createOpenAICompatible(opts: OpenAICompatibleOptions): Provider {
  const headers: Record<string, string> = { ...opts.defaultHeaders };
  if (opts.apiKey !== undefined) headers["authorization"] = `Bearer ${resolveSecret(opts.apiKey)}`;
  return createProvider({
    name: opts.name ?? "openai-compatible",
    defaultModel: opts.model,
    capabilities: { ...DEFAULT_CAPABILITIES, ...opts.capabilities },
    http: {
      baseUrl: opts.baseUrl,
      headers,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.resilience !== undefined ? { resilience: opts.resilience } : {}),
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    },
    completePath: () => "chat/completions",
    streamPath: () => "chat/completions",
    buildBody: buildChatBody,
    parseResponse: parseChatResponse,
    translateStream: translateChatStream,
  });
}

/**
 * OpenAI provider adapter — the **Responses** API
 * (`POST {baseUrl}/responses`).
 *
 * @module
 */

import { resolveSecret } from "../../runtime/secret";
import type { Secret } from "@infinityi/forge/config";
import { createProvider } from "../adapter";
import type { PipelineLike, FetchLike } from "@infinityi/forge/http/client";
import type { Provider, ProviderCapabilities } from "../types";
import { buildOpenAIBody, parseOpenAIResponse } from "./map";
import { translateOpenAIStream } from "./stream";

/** Construction options shared by the OpenAI adapter. */
export interface OpenAIOptions {
  /** API key (raw string or a forge `Secret`). */
  readonly apiKey: string | Secret<string>;
  /** Model used when a request omits `model`. Default `"gpt-5"`. */
  readonly model?: string;
  /** Override the API base URL. Default `"https://api.openai.com/v1"`. */
  readonly baseUrl?: string;
  /** Per-request timeout (ms). */
  readonly timeoutMs?: number;
  /** Override the resilience pipeline. */
  readonly resilience?: PipelineLike;
  /** Inject a `fetch` implementation (tests). */
  readonly fetch?: FetchLike;
  /** Extra headers merged into every request. */
  readonly defaultHeaders?: Record<string, string>;
}

const CAPABILITIES: ProviderCapabilities = {
  tools: true,
  streaming: true,
  multimodalInput: true,
  parallelToolCalls: true,
  structuredOutput: true,
};

/** Create an OpenAI (Responses API) {@link Provider}. */
export function createOpenAI(opts: OpenAIOptions): Provider {
  const apiKey = resolveSecret(opts.apiKey);
  return createProvider({
    name: "openai",
    defaultModel: opts.model ?? "gpt-5",
    capabilities: CAPABILITIES,
    http: {
      baseUrl: opts.baseUrl ?? "https://api.openai.com/v1",
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...opts.defaultHeaders,
      },
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.resilience !== undefined ? { resilience: opts.resilience } : {}),
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    },
    completePath: () => "responses",
    streamPath: () => "responses",
    buildBody: buildOpenAIBody,
    parseResponse: parseOpenAIResponse,
    translateStream: translateOpenAIStream,
  });
}

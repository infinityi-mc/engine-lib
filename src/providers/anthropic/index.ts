/**
 * Anthropic provider adapter — the **Messages** API
 * (`POST {baseUrl}/messages`).
 *
 * @module
 */

import type { Secret } from "@infinityi/forge/config";
import type { FetchLike, PipelineLike } from "@infinityi/forge/http/client";
import { resolveSecret } from "../../runtime/secret";
import { createProvider } from "../adapter";
import type { Provider, ProviderCapabilities } from "../types";
import { buildAnthropicBody, parseAnthropicResponse } from "./map";
import { translateAnthropicStream } from "./stream";

const DEFAULT_VERSION = "2023-06-01";

/** Construction options for the Anthropic adapter. */
export interface AnthropicOptions {
  readonly apiKey: string | Secret<string>;
  /** Model used when a request omits `model`. Default `"claude-opus-4-7"`. */
  readonly model?: string;
  /** Override the API base URL. Default `"https://api.anthropic.com/v1"`. */
  readonly baseUrl?: string;
  /** `anthropic-version` header. Default `"2023-06-01"`. */
  readonly version?: string;
  readonly timeoutMs?: number;
  readonly resilience?: PipelineLike;
  readonly fetch?: FetchLike;
  readonly defaultHeaders?: Record<string, string>;
}

const CAPABILITIES: ProviderCapabilities = {
  tools: true,
  streaming: true,
  multimodalInput: true,
  parallelToolCalls: true,
  structuredOutput: true,
};

/** Create an Anthropic (Messages API) {@link Provider}. */
export function createAnthropic(opts: AnthropicOptions): Provider {
  const apiKey = resolveSecret(opts.apiKey);
  return createProvider({
    name: "anthropic",
    defaultModel: opts.model ?? "claude-opus-4-7",
    capabilities: CAPABILITIES,
    http: {
      baseUrl: opts.baseUrl ?? "https://api.anthropic.com/v1",
      headers: {
        ...opts.defaultHeaders,
        "x-api-key": apiKey,
        "anthropic-version": opts.version ?? DEFAULT_VERSION,
      },
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.resilience !== undefined ? { resilience: opts.resilience } : {}),
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    },
    completePath: () => "messages",
    streamPath: () => "messages",
    buildBody: buildAnthropicBody,
    parseResponse: parseAnthropicResponse,
    translateStream: translateAnthropicStream,
  });
}

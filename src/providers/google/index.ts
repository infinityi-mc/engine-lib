/**
 * Google Gemini provider adapter — the **generateContent** API
 * (`POST {baseUrl}/models/{model}:generateContent`).
 *
 * @module
 */

import type { Secret } from "@infinityi/forge/config";
import type { FetchLike, PipelineLike } from "@infinityi/forge/http/client";
import { resolveSecret } from "../../runtime/secret";
import { createProvider } from "../adapter";
import type { Provider, ProviderCapabilities } from "../types";
import { buildGoogleBody, parseGoogleResponse } from "./map";
import { translateGoogleStream } from "./stream";

/** Construction options for the Google Gemini adapter. */
export interface GoogleOptions {
  readonly apiKey: string | Secret<string>;
  /** Model used when a request omits `model`. Default `"gemini-2.5-pro"`. */
  readonly model?: string;
  /** Override the API base URL. Default `"https://generativelanguage.googleapis.com/v1beta"`. */
  readonly baseUrl?: string;
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

/** Create a Google Gemini (generateContent API) {@link Provider}. */
export function createGoogle(opts: GoogleOptions): Provider {
  const apiKey = resolveSecret(opts.apiKey);
  return createProvider({
    name: "google",
    defaultModel: opts.model ?? "gemini-2.5-pro",
    capabilities: CAPABILITIES,
    http: {
      baseUrl: opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta",
      headers: {
        ...opts.defaultHeaders,
        "x-goog-api-key": apiKey,
      },
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.resilience !== undefined ? { resilience: opts.resilience } : {}),
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    },
    completePath: (model) => `models/${model}:generateContent`,
    streamPath: (model) => `models/${model}:streamGenerateContent?alt=sse`,
    buildBody: buildGoogleBody,
    parseResponse: parseGoogleResponse,
    translateStream: translateGoogleStream,
  });
}

/**
 * Shared adapter scaffolding.
 *
 * {@link createProvider} turns a small per-vendor {@link AdapterSpec} (how to
 * build the request body, where to POST it, how to parse the response, and how
 * to translate the SSE stream) into a full {@link Provider}, centralizing the
 * forge HTTP/resilience plumbing so each adapter stays focused on mapping.
 *
 * @module
 */

import type { EngineContext } from "../runtime/types";
import { createProviderHttp, openSseStream, toProviderError } from "./http";
import type { ProviderHttpOptions } from "./http";
import { parseSse } from "./sse";
import type { SseMessage } from "./sse";
import type { StreamEvent } from "./stream";
import type {
  CompletionRequest,
  CompletionResult,
  Provider,
  ProviderCapabilities,
} from "./types";

/** Per-vendor behavior consumed by {@link createProvider}. */
export interface AdapterSpec {
  readonly name: string;
  readonly defaultModel: string;
  readonly capabilities: ProviderCapabilities;
  /** Base transport options (baseUrl, headers, timeout, resilience, fetch). */
  readonly http: ProviderHttpOptions;
  /** Path for a buffered completion, resolved against `baseUrl`. */
  completePath(model: string, req: CompletionRequest): string;
  /** Path for a streaming completion, resolved against `baseUrl`. */
  streamPath(model: string, req: CompletionRequest): string;
  /** Build the provider-native request body. */
  buildBody(req: CompletionRequest, model: string, stream: boolean): unknown;
  /** Parse a buffered provider response into the normalized result. */
  parseResponse(raw: unknown, model: string): CompletionResult;
  /** Translate the provider's SSE messages into unified {@link StreamEvent}s. */
  translateStream(messages: AsyncIterable<SseMessage>, model: string): AsyncIterable<StreamEvent>;
}

/** Build a {@link Provider} from an {@link AdapterSpec}. */
export function createProvider(spec: AdapterSpec): Provider {
  return {
    name: spec.name,
    defaultModel: spec.defaultModel,
    capabilities: spec.capabilities,

    async complete(req: CompletionRequest, ctx?: EngineContext): Promise<CompletionResult> {
      const model = req.model ?? spec.defaultModel;
      const http = createProviderHttp(spec.http, ctx);
      const body = spec.buildBody(req, model, false);
      try {
        const res = await http.post<unknown>(spec.completePath(model, req), body, {
          signal: ctx?.signal,
        });
        return spec.parseResponse(res.body, model);
      } catch (error) {
        throw toProviderError(spec.name, error);
      }
    },

    async *stream(req: CompletionRequest, ctx?: EngineContext): AsyncIterable<StreamEvent> {
      const model = req.model ?? spec.defaultModel;
      const body = spec.buildBody(req, model, true);
      const stream = await openSseStream(
        spec.name,
        spec.http,
        { path: spec.streamPath(model, req), body, signal: ctx?.signal },
        ctx,
      );
      yield* spec.translateStream(parseSse(stream, ctx?.signal), model);
    },
  };
}

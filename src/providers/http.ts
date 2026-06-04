/**
 * Provider HTTP transport, built on `forge/http/client` + `forge/resilience`.
 *
 * Adapters call {@link createProviderHttp} to get a `fetch` wrapper that is
 * resilient (retry + timeout) and traced (via the {@link EngineContext}
 * telemetry handle) by composition — exactly the forge pattern. Non-2xx
 * responses are parsed into errors and re-thrown as {@link ProviderError} by
 * {@link toProviderError}.
 *
 * @module
 */

import { createHttpClient } from "@infinityi/forge/http/client";
import type {
  FetchLike,
  HttpClient,
  PipelineLike,
} from "@infinityi/forge/http/client";
import {
  combine,
  exponentialBackoff,
  retry,
  timeout,
} from "@infinityi/forge/resilience";
import { tracedFetch } from "@infinityi/forge/telemetry/instrumentation/fetch";

import { ProviderError } from "../errors";
import type { EngineContext } from "../runtime/types";

/** Default per-request timeout for provider calls. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Construction options for a provider's HTTP transport. */
export interface ProviderHttpOptions {
  /** Provider base URL (e.g. `https://api.openai.com/v1`). */
  readonly baseUrl: string;
  /** Headers merged into every request (auth + version), already resolved. */
  readonly headers: Record<string, string>;
  /** Per-request timeout. Default {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Override the default resilience pipeline. */
  readonly resilience?: PipelineLike;
  /** Inject a `fetch` implementation (tests / pre-wrapped fetch). */
  readonly fetch?: FetchLike;
  /** Allow request URLs to resolve to a different origin than `baseUrl`. */
  readonly allowAbsoluteUrls?: boolean;
}

/** Read an HTTP status code off a structurally-typed error, if present. */
function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

/** Best-effort human-readable detail from a thrown value. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

/** Retry transient failures: 429, any 5xx, and network errors (no status). */
function isTransient(error: unknown): boolean {
  // User/engine cancellation is terminal — never retry it.
  if (error instanceof DOMException && error.name === "AbortError")
    return false;
  const status = statusOf(error);
  if (status === undefined) return true; // network / abort-less failure
  return status === 429 || status >= 500;
}

/**
 * The default provider resilience pipeline: up to 3 attempts with exponential
 * backoff, each bounded by `timeoutMs`. Only transient failures are retried.
 */
export function defaultProviderResilience(timeoutMs: number): PipelineLike {
  return combine(
    retry({
      maxAttempts: 3,
      backoff: exponentialBackoff({ initial: 250, max: 10_000 }),
      shouldRetry: isTransient,
    }),
    timeout({ ms: timeoutMs }),
  );
}

/**
 * Build a forge {@link HttpClient} for a provider, wiring telemetry/logger from
 * the {@link EngineContext} and a default resilience pipeline.
 */
export function createProviderHttp(
  opts: ProviderHttpOptions,
  ctx?: EngineContext,
): HttpClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const telemetry = ctx?.telemetry;
  return createHttpClient({
    // Trailing slash so relative paths resolve *under* the base path (keeping
    // e.g. the `/v1` segment) rather than replacing its last segment.
    baseUrl: opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`,
    defaultHeaders: opts.headers,
    // The default resilience pipeline already applies timeoutMs per attempt.
    // Passing timeoutMs to forge's HttpClient too would arm a second deadline.
    timeoutMs: opts.resilience === undefined ? undefined : timeoutMs,
    resilience: opts.resilience ?? defaultProviderResilience(timeoutMs),
    telemetry: telemetry
      ? { meter: telemetry.meter, tracer: telemetry.tracer }
      : undefined,
    logger: ctx?.logger ?? telemetry?.log,
    fetch: opts.fetch,
    allowAbsoluteUrls: opts.allowAbsoluteUrls,
    // Surface non-2xx as thrown errors so adapters map them uniformly.
    throwOnError: true,
  });
}

/** Join a base URL and a path, tolerating a trailing/leading slash. */
function joinUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Combine the resilience signal with the caller's cancellation signal. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function combineSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

/** A streaming request the adapter wants to open. */
export interface SseRequest {
  /** Request path, resolved against `baseUrl`. */
  readonly path: string;
  /** JSON request body (serialized here). */
  readonly body: unknown;
  /** Caller cancellation signal. */
  readonly signal?: AbortSignal;
}

/**
 * Open a streaming (SSE) provider request and return the raw body stream.
 *
 * The connection attempt is wrapped in the resilience pipeline (retry +
 * timeout bound *time-to-headers*; once the response resolves the timeout is
 * settled and never aborts the in-flight body). Non-2xx responses are mapped
 * to {@link ProviderError}.
 */
export async function openSseStream(
  provider: string,
  opts: ProviderHttpOptions,
  req: SseRequest,
  ctx?: EngineContext,
): Promise<ReadableStream<Uint8Array>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pipeline = opts.resilience ?? defaultProviderResilience(timeoutMs);
  const telemetry = ctx?.telemetry;
  const baseFetch: FetchLike =
    opts.fetch ?? ((input, init) => fetch(input, init));
  const fetchImpl: FetchLike = telemetry?.tracer
    ? tracedFetch({ tracer: telemetry.tracer, fetch: baseFetch })
    : baseFetch;
  const durationHistogram = telemetry?.meter?.createHistogram(
    "http.client.request.duration",
    { description: "Duration of outbound HTTP client requests.", unit: "s" },
  );
  const url = joinUrl(opts.baseUrl, req.path);
  const serverAddress = hostOf(url);
  const headers = {
    "content-type": "application/json",
    accept: "text/event-stream",
    ...opts.headers,
  };

  const startedAt = performance.now();
  let statusLabel: string | undefined;
  try {
    const response = await pipeline.execute(async (pctx) => {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(req.body),
        signal: combineSignals(pctx.signal, req.signal, ctx?.signal),
      });
      statusLabel = String(response.status);
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw Object.assign(new Error(detail || response.statusText), {
          status: response.status,
        });
      }
      return response;
    });
    if (response.body === null) {
      throw new ProviderError(`${provider} streaming response had no body`, {
        provider,
      });
    }
    return response.body;
  } catch (error) {
    statusLabel ??= statusOf(error)?.toString() ?? "error";
    throw toProviderError(provider, error);
  } finally {
    const attributes: Record<string, string | number | boolean> = {
      "http.request.method": "POST",
      "server.address": serverAddress,
    };
    if (statusLabel !== undefined) {
      attributes["http.response.status_code"] = statusLabel;
    }
    durationHistogram?.record(
      (performance.now() - startedAt) / 1000,
      attributes,
    );
  }
}

/** Wrap any thrown HTTP/transport error as a {@link ProviderError}. */
export function toProviderError(
  provider: string,
  error: unknown,
): ProviderError {
  if (error instanceof ProviderError) return error;
  const status = statusOf(error);
  const detail = messageOf(error);
  const message =
    status !== undefined
      ? `${provider} request failed (HTTP ${status}): ${detail}`
      : `${provider} request failed: ${detail}`;
  return new ProviderError(message, { provider, cause: error });
}

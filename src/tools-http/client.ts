/**
 * Low-level HTTP client for `tools-http`.
 *
 * It performs policy checks before every request and redirect target, follows
 * redirects manually, uses Forge resilience for retry/timeout, and returns a
 * compact parsed response.
 *
 * @module
 */

import {
  combine,
  exponentialBackoff,
  retry,
  timeout,
} from "@infinityi/forge/resilience";

import type { ToolContext } from "../tools/types";
import {
  emitHttpPolicy,
  emitHttpRequestEnd,
  emitHttpRequestStart,
} from "./events";
import {
  HttpPolicyError,
  allowedResponseHeaders,
  assertUrlAllowed,
  buildRequestHeaders,
  clamp,
  normalizeHttpConfig,
  type NormalizedHttpConfig,
} from "./policy";
import type {
  HeaderEntry,
  HttpClientRequest,
  HttpRequestResult,
  HttpToolClient,
  HttpToolsConfig,
} from "./types";

class RetryableHttpStatusError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`retryable HTTP status ${status}`);
    this.name = "RetryableHttpStatusError";
    this.status = status;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function combineSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const present = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

function timeoutFor(
  config: NormalizedHttpConfig,
  requested: number | undefined,
): number {
  if (requested === undefined || requested <= 0) return config.defaultTimeoutMs;
  return clamp(requested, config.minTimeoutMs, config.maxTimeoutMs);
}

function bytesFor(
  config: NormalizedHttpConfig,
  requested: number | undefined,
): number {
  if (requested === undefined || requested <= 0) return config.maxResponseBytes;
  return clamp(requested, 1, config.maxResponseBytes);
}

function charsFor(
  config: NormalizedHttpConfig,
  requested: number | undefined,
): number {
  if (requested === undefined || requested <= 0) return config.maxBodyChars;
  return clamp(requested, 1, config.maxBodyChars);
}

function shouldRetryMethod(
  config: NormalizedHttpConfig,
  method: string,
): boolean {
  return method === "GET" || config.retryUnsafeMethods;
}

function isTransient(error: unknown): boolean {
  if (isAbort(error)) return false;
  const status = statusOf(error);
  if (status === undefined) return true;
  return retryableStatus(status);
}

function redirectedMethod(
  method: "GET" | "POST",
  status: number,
): "GET" | "POST" {
  if (status === 303) return "GET";
  if ((status === 301 || status === 302) && method === "POST") return "GET";
  return method;
}

function bodyFor(
  req: HttpClientRequest,
  method: "GET" | "POST",
): { body?: string; contentType?: string } {
  if (method === "GET") return {};
  if (req.body !== undefined && req.bodyJson !== undefined) {
    throw new HttpPolicyError("body and bodyJson cannot both be supplied");
  }
  if (req.bodyJson !== undefined) {
    return {
      body: JSON.stringify(req.bodyJson),
      contentType: req.contentType ?? "application/json",
    };
  }
  if (req.body !== undefined) {
    return { body: req.body, contentType: req.contentType };
  }
  return {};
}

function contentKind(
  contentType: string | undefined,
): "json" | "text" | "binary" {
  const type = (contentType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  if (type === "application/json" || type.endsWith("+json")) return "json";
  if (type.startsWith("text/")) return "text";
  if (
    type === "application/xhtml+xml" ||
    type === "application/xml" ||
    type.endsWith("+xml")
  )
    return "text";
  return "binary";
}

function truncateChars(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

async function readBytes(
  response: Response,
  maxBytes: number,
): Promise<{
  bytes: Uint8Array;
  truncated: boolean;
}> {
  if (response.body === null)
    return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const value = next.value;
      if (received + value.byteLength > maxBytes) {
        const remaining = Math.max(0, maxBytes - received);
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        received = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      received += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: out, truncated };
}

function parseBody(
  bytes: Uint8Array,
  responseBytesTruncated: boolean,
  contentType: string | undefined,
  maxBodyChars: number,
): Pick<
  HttpRequestResult,
  "body" | "bodyJson" | "bodyOmitted" | "bodyTruncated"
> {
  const kind = contentKind(contentType);
  if (kind === "binary") {
    return { bodyOmitted: true, bodyTruncated: responseBytesTruncated };
  }

  const decoded = new TextDecoder().decode(bytes);
  const truncated = truncateChars(decoded, maxBodyChars);
  if (kind === "json" && !responseBytesTruncated && !truncated.truncated) {
    try {
      return {
        bodyJson: decoded.length === 0 ? null : JSON.parse(decoded),
        bodyOmitted: false,
        bodyTruncated: false,
      };
    } catch (error) {
      throw new Error(`failed to parse JSON response: ${messageOf(error)}`);
    }
  }
  return {
    body: truncated.text,
    bodyOmitted: false,
    bodyTruncated: responseBytesTruncated || truncated.truncated,
  };
}

function validateUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch (error) {
    throw new HttpPolicyError(`invalid URL: ${messageOf(error)}`);
  }
}

function checkUrl(
  url: URL,
  config: NormalizedHttpConfig,
  ctx: ToolContext | undefined,
): void {
  try {
    assertUrlAllowed(url, config);
    emitHttpPolicy(ctx, "allow", url.href);
  } catch (error) {
    const message = messageOf(error);
    emitHttpPolicy(ctx, "deny", url.href, message);
    throw error;
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup before retrying.
  }
}

/** Create a policy-gated HTTP client. */
export function createHttpToolClient(config: HttpToolsConfig): HttpToolClient {
  const normalized = normalizeHttpConfig(config);

  async function perform(
    req: HttpClientRequest,
    ctx?: ToolContext,
  ): Promise<HttpRequestResult> {
      let method = req.method;
      let url = validateUrl(req.url);
      checkUrl(url, normalized, ctx);
      if (config.policy !== undefined) {
        const decision = await config.policy.evaluate(
          {
            tool: method === "GET" ? "http_get" : "http_post",
            operation: "network",
            target: url.href,
            arguments: req,
          },
          {
            agentName: ctx?.agentName ?? "unknown",
            ...(ctx?.tenantId !== undefined ? { tenantId: ctx.tenantId } : {}),
            ...(ctx?.principal !== undefined
              ? { principal: ctx.principal }
              : {}),
            messages: [],
          },
        );
        if (!decision.allowed) {
          throw new HttpPolicyError(decision.reason);
        }
      }


    const timeoutMs = timeoutFor(normalized, req.timeoutMs);
    const maxBytes = bytesFor(normalized, req.maxBytes);
    const maxBodyChars = charsFor(normalized, req.maxBodyChars);

    const started = performance.now();
    const redirects: string[] = [];
    const initialOrigin = url.origin;
    emitHttpRequestStart(ctx, method, url.href, timeoutMs);

    try {
      for (
        let redirectCount = 0;
        redirectCount <= normalized.maxRedirects;
        redirectCount += 1
      ) {
        const currentMethod = method;
        const currentUrl = url;
        const { body, contentType } = bodyFor(req, currentMethod);
        const requestHeaders = buildRequestHeaders(
          normalized,
          req.headers,
          contentType,
          {
            includeConfiguredHeaders: currentUrl.origin === initialOrigin,
          },
        );
        const retryEnabled = shouldRetryMethod(normalized, currentMethod);
        const maxAttempts = retryEnabled ? normalized.retryMaxAttempts : 1;
        const pipeline = combine(
          retry({
            maxAttempts,
            backoff: exponentialBackoff({
              initial: normalized.retryInitialDelayMs,
              max: normalized.retryMaxDelayMs,
            }),
            shouldRetry: (error) => {
              if (ctx?.signal?.aborted) return false;
              return retryEnabled && isTransient(error);
            },
          }),
          timeout({ ms: timeoutMs }),
        );

        const response = await pipeline.execute(async (rctx) => {
          const fetched = await normalized.fetch(currentUrl.href, {
            method: currentMethod,
            headers: requestHeaders,
            body: currentMethod === "GET" ? undefined : body,
            redirect: "manual",
            signal: combineSignals(rctx.signal, ctx?.signal),
          });
          if (
            retryEnabled &&
            retryableStatus(fetched.status) &&
            rctx.attempt < maxAttempts
          ) {
            await cancelBody(fetched);
            throw new RetryableHttpStatusError(fetched.status);
          }
          return fetched;
        });

        const location = response.headers.get("location");
        if (
          response.status >= 300 &&
          response.status < 400 &&
          location !== null
        ) {
          if (redirectCount >= normalized.maxRedirects) {
            await cancelBody(response);
            throw new HttpPolicyError(
              `too many redirects (max ${normalized.maxRedirects})`,
            );
          }
          const next = new URL(location, currentUrl);
          await cancelBody(response);
          checkUrl(next, normalized, ctx);
          redirects.push(next.href);
          method = redirectedMethod(method, response.status);
          url = next;
          continue;
        }

        const contentTypeHeader =
          response.headers.get("content-type") ?? undefined;
        const { bytes, truncated } = await readBytes(response, maxBytes);
        const parsed = parseBody(
          bytes,
          truncated,
          contentTypeHeader,
          maxBodyChars,
        );
        const result: HttpRequestResult = {
          url: req.url,
          finalUrl: currentUrl.href,
          redirected: redirects.length > 0,
          redirects,
          status: response.status,
          statusText: response.statusText,
          ...(contentTypeHeader !== undefined
            ? { contentType: contentTypeHeader }
            : {}),
          headers: allowedResponseHeaders(
            response.headers,
            normalized.responseHeaderAllowlist,
          ),
          ...parsed,
          responseBytes: bytes.byteLength,
          responseBytesTruncated: truncated,
          elapsedMs: Math.round(performance.now() - started),
        };
        emitHttpRequestEnd(ctx, req.method, req.url, result);
        return result;
      }
      throw new HttpPolicyError(
        `too many redirects (max ${normalized.maxRedirects})`,
      );
    } catch (error) {
      const message = messageOf(error);
      emitHttpRequestEnd(ctx, req.method, req.url, undefined, message);
      throw error;
    }
  }

  return {
    request: perform,
    get(
      url: string,
      options?: Omit<
        HttpClientRequest,
        "method" | "url" | "body" | "bodyJson" | "contentType"
      >,
      ctx?: ToolContext,
    ) {
      return perform({ method: "GET", url, ...(options ?? {}) }, ctx);
    },
    post(
      url: string,
      options?: Omit<HttpClientRequest, "method" | "url">,
      ctx?: ToolContext,
    ) {
      return perform({ method: "POST", url, ...(options ?? {}) }, ctx);
    },
  };
}

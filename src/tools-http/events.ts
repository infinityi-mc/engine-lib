/**
 * Custom run events emitted by `@infinityi/engine-lib/tools-http`.
 *
 * Emission is a no-op outside `runAgent`, matching the other optional tool
 * packs. Events are intentionally compact and avoid response bodies.
 *
 * @module
 */

import type { ToolContext } from "../tools/types";
import type { HttpRequestResult } from "./types";

/** Event names emitted by the HTTP tool module. */
export const HTTP_EVENT = {
  policy: "http.policy",
  requestStart: "http.request.start",
  requestEnd: "http.request.end",
} as const;

function emit(ctx: ToolContext | undefined, name: string, data: Record<string, unknown>): void {
  ctx?.run?.emit({ type: "custom", name, data });
}

/** Surface a URL policy decision. */
export function emitHttpPolicy(
  ctx: ToolContext | undefined,
  decision: "allow" | "deny",
  url: string,
  reason?: string,
): void {
  emit(ctx, HTTP_EVENT.policy, {
    decision,
    url,
    ...(reason !== undefined ? { reason } : {}),
  });
}

/** Surface the beginning of a logical HTTP request. */
export function emitHttpRequestStart(
  ctx: ToolContext | undefined,
  method: string,
  url: string,
  timeoutMs: number,
): void {
  emit(ctx, HTTP_EVENT.requestStart, { method, url, timeoutMs });
}

/** Surface the end of a logical HTTP request or a transport failure. */
export function emitHttpRequestEnd(
  ctx: ToolContext | undefined,
  method: string,
  url: string,
  result: HttpRequestResult | undefined,
  error?: string,
): void {
  emit(ctx, HTTP_EVENT.requestEnd, {
    method,
    url,
    ...(result !== undefined
      ? {
        finalUrl: result.finalUrl,
        status: result.status,
        elapsedMs: result.elapsedMs,
        responseBytes: result.responseBytes,
        responseBytesTruncated: result.responseBytesTruncated,
        bodyTruncated: result.bodyTruncated,
      }
      : {}),
    ...(error !== undefined ? { error } : {}),
  });
}

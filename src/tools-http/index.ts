/**
 * `@infinityi/engine-lib/tools-http` - optional, policy-gated HTTP tools.
 *
 * This subpath is intentionally absent from the root barrel. Hosts must opt in
 * and provide explicit network scope with either `allowedHosts` or
 * `allowPublicInternet: true`.
 *
 * @example
 * ```ts
 * import { httpTools } from "@infinityi/engine-lib/tools-http";
 *
 * const http = httpTools({
 *   allowedHosts: ["api.example.com"],
 *   defaultHeaders: [{ name: "accept", value: "application/json" }],
 * });
 * ```
 *
 * @module
 */

export { createHttpToolClient } from "./client";
export { httpTools } from "./define";
export { HTTP_EVENT } from "./events";
export { HttpPolicyError } from "./policy";

export type {
  HeaderEntry,
  HostPattern,
  HttpClientRequest,
  HttpPolicy,
  HttpRequestResult,
  HttpRetryOptions,
  HttpToolClient,
  HttpTools,
  HttpToolsConfig,
} from "./types";

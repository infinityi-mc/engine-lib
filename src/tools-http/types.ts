/**
 * Public types for `@infinityi/engine-lib/tools-http`.
 *
 * The module is opt-in and host-configured: network scope, default headers,
 * timeout limits, and response caps are all supplied by the application, not by
 * the model. Per-call failures are returned as tool errors by the ready-made
 * tools; the lower-level client throws ordinary errors for callers to handle.
 *
 * @module
 */

import type { ToolDefinition } from "../tools/types";
import type { PolicyEngine } from "../governance/policy";

/** A hostname policy entry. Strings support exact hosts, `host:port`, `*`, and `*.example.com`. */
export type HostPattern = string | RegExp;

/** A normalized HTTP header entry. */
export interface HeaderEntry {
  readonly name: string;
  readonly value: string;
}

/** Host-side network policy for low-level HTTP access. */
export interface HttpPolicy {
  /**
   * Hosts the tools may contact. Required unless
   * {@link HttpToolsConfig.allowPublicInternet} is true.
   */
  readonly allowedHosts?: readonly HostPattern[];
  /** Hosts denied even when otherwise allowed. Deny wins over allow. */
  readonly deniedHosts?: readonly HostPattern[];
  /** Allowed URL protocols. Defaults to `["https:", "http:"]`. */
  readonly allowedProtocols?: readonly string[];
  /** Allow private, loopback, link-local, multicast, and localhost targets. Defaults to false. */
  readonly allowPrivateNetwork?: boolean;
  /** Allow URLs with embedded username/password credentials. Defaults to false. */
  readonly allowCredentialedUrls?: boolean;
}

/** Retry behavior for the HTTP client. */
export interface HttpRetryOptions {
  /** Maximum attempts for retry-enabled methods. Defaults to 3. */
  readonly maxAttempts?: number;
  /** Initial exponential backoff delay in ms. Defaults to 100. */
  readonly initialDelayMs?: number;
  /** Maximum exponential backoff delay in ms. Defaults to 2_000. */
  readonly maxDelayMs?: number;
  /** Retry POST/other unsafe methods too. Defaults to false. */
  readonly retryUnsafeMethods?: boolean;
}

/** Configuration for {@link httpTools} and {@link createHttpToolClient}. */
export interface HttpToolsConfig extends HttpPolicy {
  /**
   * Permit any public host. At least one of this or `allowedHosts` is required
   * so hosts opt into network scope explicitly.
   */
  readonly allowPublicInternet?: boolean;
  /** Headers supplied by the host on every request. */
  readonly defaultHeaders?:
    | readonly HeaderEntry[]
    | Readonly<Record<string, string>>;
  /** Model-supplied request headers accepted by name. Defaults to none. */
  readonly allowedRequestHeaders?: readonly string[];
  /** Response headers exposed in results. Defaults to a compact safe allowlist. */
  readonly responseHeaderAllowlist?: readonly string[];
  /** Default per-attempt timeout. Defaults to 10_000ms. */
  readonly defaultTimeoutMs?: number;
  /** Minimum accepted timeout after clamping. Defaults to 100ms. */
  readonly minTimeoutMs?: number;
  /** Maximum accepted timeout after clamping. Defaults to 60_000ms. */
  readonly maxTimeoutMs?: number;
  /** Maximum bytes accepted for a request body. Defaults to 1_000_000. */
  readonly maxRequestBytes?: number;
  /** Maximum bytes read from a response body. Defaults to 1_000_000. */
  readonly maxResponseBytes?: number;
  /** Maximum characters returned for parsed text bodies. Defaults to 20_000. */
  readonly maxBodyChars?: number;
  /** Maximum followed redirects. Defaults to 5. */
  readonly maxRedirects?: number;
  /** Retry configuration. GET retries are enabled by default. */
  readonly retry?: HttpRetryOptions;
  /** Optional unified policy engine evaluated after native HTTP policy. */
  readonly policy?: PolicyEngine;
  /** Inject a fetch implementation for tests or custom transports. */
  readonly fetch?: typeof fetch;
}

/** A client request after tool argument mapping. */
export interface HttpClientRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers?: readonly HeaderEntry[];
  readonly body?: string;
  readonly bodyJson?: unknown;
  readonly contentType?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxBodyChars?: number;
}

/** Compact metadata and parsed body for a received HTTP response. */
export interface HttpRequestResult {
  readonly url: string;
  readonly finalUrl: string;
  readonly redirected: boolean;
  readonly redirects: readonly string[];
  readonly status: number;
  readonly statusText: string;
  readonly contentType?: string;
  readonly headers: readonly HeaderEntry[];
  readonly body?: string;
  readonly bodyJson?: unknown;
  readonly bodyOmitted: boolean;
  readonly bodyTruncated: boolean;
  readonly responseBytes: number;
  readonly responseBytesTruncated: boolean;
  readonly elapsedMs: number;
}

/** Low-level HTTP client backing both the HTTP and web tool packs. */
export interface HttpToolClient {
  request(
    req: HttpClientRequest,
    ctx?: import("../tools/types").ToolContext,
  ): Promise<HttpRequestResult>;
  get(
    url: string,
    options?: Omit<
      HttpClientRequest,
      "method" | "url" | "body" | "bodyJson" | "contentType"
    >,
    ctx?: import("../tools/types").ToolContext,
  ): Promise<HttpRequestResult>;
  post(
    url: string,
    options?: Omit<HttpClientRequest, "method" | "url">,
    ctx?: import("../tools/types").ToolContext,
  ): Promise<HttpRequestResult>;
}

/** The ready-made HTTP tool definitions. */
export interface HttpTools {
  readonly httpGet: ToolDefinition;
  readonly httpPost: ToolDefinition;
}

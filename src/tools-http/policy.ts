/**
 * Pure policy helpers for `tools-http`.
 *
 * Host configuration is normalized eagerly by the factory/client. Per-request
 * denials throw {@link HttpPolicyError}; ready-made tools catch these and
 * return `{ ok: false, error }`.
 *
 * @module
 */

import type { HeaderEntry, HostPattern, HttpToolsConfig } from "./types";

const DEFAULT_PROTOCOLS = ["https:", "http:"] as const;
const DEFAULT_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "cache-control",
  "etag",
  "last-modified",
  "location",
  "retry-after",
] as const;

/** Host-side HTTP policy/configuration error. */
export class HttpPolicyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HttpPolicyError";
  }
}

export interface NormalizedHttpConfig {
  readonly allowPublicInternet: boolean;
  readonly allowedHosts: readonly HostPattern[];
  readonly deniedHosts: readonly HostPattern[];
  readonly allowedProtocols: readonly string[];
  readonly allowPrivateNetwork: boolean;
  readonly allowCredentialedUrls: boolean;
  readonly defaultHeaders: readonly HeaderEntry[];
  readonly allowedRequestHeaders: ReadonlySet<string>;
  readonly responseHeaderAllowlist: ReadonlySet<string>;
  readonly defaultTimeoutMs: number;
  readonly minTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxBodyChars: number;
  readonly maxRedirects: number;
  readonly retryMaxAttempts: number;
  readonly retryInitialDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly retryUnsafeMethods: boolean;
  readonly fetch: typeof fetch;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new HttpPolicyError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new HttpPolicyError(`${name} must be a non-negative integer`);
  }
}

function normalizeProtocol(protocol: string): string {
  const trimmed = protocol.trim().toLowerCase();
  return trimmed.endsWith(":") ? trimmed : `${trimmed}:`;
}

function normalizeHeaderName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (trimmed === "")
    throw new HttpPolicyError("header name must be non-empty");
  if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(trimmed)) {
    throw new HttpPolicyError(`invalid header name ${JSON.stringify(name)}`);
  }
  return trimmed;
}

function headerEntries(
  headers:
    | readonly HeaderEntry[]
    | Readonly<Record<string, string>>
    | undefined,
): HeaderEntry[] {
  if (headers === undefined) return [];
  const entries = Array.isArray(headers)
    ? headers
    : Object.entries(headers).map(([name, value]) => ({ name, value }));
  return entries.map((entry) => {
    const name = normalizeHeaderName(entry.name);
    if (typeof entry.value !== "string") {
      throw new HttpPolicyError(
        `header ${JSON.stringify(entry.name)} value must be a string`,
      );
    }
    if (/[\r\n]/.test(entry.value)) {
      throw new HttpPolicyError(
        `header ${JSON.stringify(entry.name)} value contains a newline`,
      );
    }
    return { name, value: entry.value };
  });
}

/** Normalize and validate host configuration. */
export function normalizeHttpConfig(
  config: HttpToolsConfig,
): NormalizedHttpConfig {
  const allowedHosts = config.allowedHosts ?? [];
  const allowPublicInternet = config.allowPublicInternet ?? false;
  if (!allowPublicInternet && allowedHosts.length === 0) {
    throw new HttpPolicyError(
      "tools-http requires allowedHosts or allowPublicInternet: true",
    );
  }

  const allowedProtocols = (config.allowedProtocols ?? DEFAULT_PROTOCOLS).map(
    normalizeProtocol,
  );
  if (allowedProtocols.length === 0) {
    throw new HttpPolicyError(
      "allowedProtocols must contain at least one protocol",
    );
  }

  const minTimeoutMs = config.minTimeoutMs ?? 100;
  const defaultTimeoutMs = config.defaultTimeoutMs ?? 10_000;
  const maxTimeoutMs = config.maxTimeoutMs ?? 60_000;
  const maxResponseBytes = config.maxResponseBytes ?? 1_000_000;
  const maxBodyChars = config.maxBodyChars ?? 20_000;
  const maxRedirects = config.maxRedirects ?? 5;
  const retryMaxAttempts = config.retry?.maxAttempts ?? 3;
  const retryInitialDelayMs = config.retry?.initialDelayMs ?? 100;
  const retryMaxDelayMs = config.retry?.maxDelayMs ?? 2_000;

  assertPositiveInteger("minTimeoutMs", minTimeoutMs);
  assertPositiveInteger("defaultTimeoutMs", defaultTimeoutMs);
  assertPositiveInteger("maxTimeoutMs", maxTimeoutMs);
  if (minTimeoutMs > maxTimeoutMs) {
    throw new HttpPolicyError("minTimeoutMs must be <= maxTimeoutMs");
  }
  assertPositiveInteger("maxResponseBytes", maxResponseBytes);
  assertPositiveInteger("maxBodyChars", maxBodyChars);
  assertNonNegativeInteger("maxRedirects", maxRedirects);
  assertPositiveInteger("retry.maxAttempts", retryMaxAttempts);
  assertNonNegativeInteger("retry.initialDelayMs", retryInitialDelayMs);
  assertNonNegativeInteger("retry.maxDelayMs", retryMaxDelayMs);

  return {
    allowPublicInternet,
    allowedHosts,
    deniedHosts: config.deniedHosts ?? [],
    allowedProtocols,
    allowPrivateNetwork: config.allowPrivateNetwork ?? false,
    allowCredentialedUrls: config.allowCredentialedUrls ?? false,
    defaultHeaders: headerEntries(config.defaultHeaders),
    allowedRequestHeaders: new Set(
      (config.allowedRequestHeaders ?? []).map(normalizeHeaderName),
    ),
    responseHeaderAllowlist: new Set(
      (config.responseHeaderAllowlist ?? DEFAULT_RESPONSE_HEADERS).map(
        normalizeHeaderName,
      ),
    ),
    defaultTimeoutMs: clamp(defaultTimeoutMs, minTimeoutMs, maxTimeoutMs),
    minTimeoutMs,
    maxTimeoutMs,
    maxResponseBytes,
    maxBodyChars,
    maxRedirects,
    retryMaxAttempts,
    retryInitialDelayMs,
    retryMaxDelayMs,
    retryUnsafeMethods: config.retry?.retryUnsafeMethods ?? false,
    fetch: config.fetch ?? fetch,
  };
}

/** Clamp a caller/model-supplied number into a host-approved range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function cleanHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
}

function cleanHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

function parsePatternHost(pattern: string): string {
  const trimmed = pattern.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(trimmed)) {
    return new URL(trimmed).host.toLowerCase();
  }
  return trimmed.replace(/\.$/, "");
}

/** Match a URL against a host policy pattern. */
export function matchesHost(url: URL, pattern: HostPattern): boolean {
  const hostname = cleanHostname(url.hostname);
  const host = cleanHost(url.host);
  if (pattern instanceof RegExp) {
    pattern.lastIndex = 0;
    return pattern.test(hostname) || pattern.test(host);
  }
  const value = parsePatternHost(pattern);
  if (value === "*") return true;
  if (value.startsWith("*.")) {
    const suffix = value.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return value.includes(":") ? host === value : hostname === value;
}

function parseIPv4(hostname: string): readonly number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => {
    if (!/^\d+$/.test(part)) return Number.NaN;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : Number.NaN;
  });
  return numbers.every((n) => Number.isInteger(n)) ? numbers : null;
}

function isPrivateIPv4(parts: readonly number[]): boolean {
  const [a = 0, b = 0] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIPv6(hostname: string): boolean {
  const value = hostname.toLowerCase();
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(value)) return true;
  if (value.startsWith("ff")) return true;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1] !== undefined) {
    const ipv4 = parseIPv4(mapped[1]);
    return ipv4 !== null && isPrivateIPv4(ipv4);
  }
  return false;
}

/** Whether a hostname is an explicit private/local target. */
export function isPrivateTarget(hostname: string): boolean {
  const host = cleanHostname(hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const ipv4 = parseIPv4(host);
  if (ipv4 !== null) return isPrivateIPv4(ipv4);
  if (host.includes(":")) return isPrivateIPv6(host);
  return false;
}

/** Validate one URL against the host-side HTTP policy. */
export function assertUrlAllowed(url: URL, config: NormalizedHttpConfig): void {
  if (!config.allowedProtocols.includes(url.protocol.toLowerCase())) {
    throw new HttpPolicyError(`protocol ${url.protocol} is not allowed`);
  }
  if (
    !config.allowCredentialedUrls &&
    (url.username !== "" || url.password !== "")
  ) {
    throw new HttpPolicyError("credentialed URLs are not allowed");
  }
  if (!config.allowPrivateNetwork && isPrivateTarget(url.hostname)) {
    throw new HttpPolicyError(
      `private or localhost target ${url.hostname} is not allowed`,
    );
  }
  if (config.deniedHosts.some((pattern) => matchesHost(url, pattern))) {
    throw new HttpPolicyError(`host ${url.host} is denied by policy`);
  }
  if (
    !config.allowPublicInternet &&
    !config.allowedHosts.some((pattern) => matchesHost(url, pattern))
  ) {
    throw new HttpPolicyError(`host ${url.host} is not in allowedHosts`);
  }
}

/** Convert model-supplied headers into the subset permitted by config. */
export function buildRequestHeaders(
  config: NormalizedHttpConfig,
  modelHeaders: readonly HeaderEntry[] | undefined,
  contentType?: string,
  options?: { includeConfiguredHeaders?: boolean },
): Headers {
  const headers = new Headers();
  if (options?.includeConfiguredHeaders ?? true) {
    for (const entry of config.defaultHeaders)
      headers.set(entry.name, entry.value);
    for (const entry of modelHeaders ?? []) {
      const name = normalizeHeaderName(entry.name);
      if (!config.allowedRequestHeaders.has(name)) continue;
      if (/[\r\n]/.test(entry.value)) {
        throw new HttpPolicyError(
          `header ${JSON.stringify(entry.name)} value contains a newline`,
        );
      }
      headers.set(name, entry.value);
    }
  }
  if (contentType !== undefined && !headers.has("content-type")) {
    headers.set("content-type", contentType);
  }
  return headers;
}

/** Return response headers filtered through the configured allowlist. */
export function allowedResponseHeaders(
  headers: Headers,
  allowlist: ReadonlySet<string>,
): readonly HeaderEntry[] {
  const entries: HeaderEntry[] = [];
  for (const [name, value] of headers.entries()) {
    if (allowlist.has(name.toLowerCase())) entries.push({ name, value });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

import { CancelledError, ProviderError } from "../errors";
import type { Provider } from "../providers/types";
import type { EngineContext } from "../runtime/types";

export interface RetryPolicy {
  readonly maxRetries?: number;
  readonly retryableStatusCodes?: readonly number[];
  readonly backoffMs?: number | ((attempt: number) => number);
  readonly retryable?: (error: unknown) => boolean;
}

export interface ProviderRetryEvent {
  readonly attempt: number;
  readonly delayMs: number;
  readonly status?: number;
}

export interface CircuitBreakerOptions {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly halfOpenMax?: number;
}

const DEFAULT_RETRYABLE_STATUS: readonly number[] = [429, 500, 502, 503, 504];

function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  return DEFAULT_RETRYABLE_STATUS.includes(status);
}

function statusOf(error: unknown): number | undefined {
  return error instanceof ProviderError ? error.status : undefined;
}

function isRetryable(error: unknown, policy: RetryPolicy): boolean {
  if (error instanceof CancelledError) return false;
  if (policy.retryable?.(error) === true) return true;
  if (error instanceof ProviderError) {
    if (error.retryable !== undefined) return error.retryable;
    if (policy.retryableStatusCodes !== undefined) {
      return policy.retryableStatusCodes.includes(error.status ?? -1);
    }
    return isRetryableStatus(error.status);
  }
  return false;
}

function shouldCountBreakerFailure(error: unknown): boolean {
  if (error instanceof CancelledError) return false;
  if (error instanceof ProviderError) {
    if (error.retryable !== undefined) return error.retryable;
    return isRetryableStatus(error.status);
  }
  return true;
}

function baseDelay(attempt: number, policy: RetryPolicy): number {
  const configured = policy.backoffMs;
  if (typeof configured === "function") return configured(attempt);
  if (configured !== undefined) return configured;
  return Math.min(100 * 2 ** (attempt - 1), 2_000);
}

function delayWithJitter(attempt: number, policy: RetryPolicy): number {
  const base = Math.max(0, baseDelay(attempt, policy));
  if (base === 0) return 0;
  return Math.round(base + Math.random() * base * 0.2);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(new CancelledError("retry cancelled"));
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError("retry cancelled"));
    };
    function done(): void {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withProviderRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  ctx: EngineContext = {},
  onRetry?: (event: ProviderRetryEvent) => void,
): Promise<T> {
  const maxRetries = policy.maxRetries ?? 2;
  let attempt = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (ctx.signal?.aborted) throw new CancelledError("retry cancelled");
      if (attempt >= maxRetries || !isRetryable(error, policy)) throw error;
      attempt += 1;
      const delayMs = delayWithJitter(attempt, policy);
      const event: ProviderRetryEvent = {
        attempt,
        delayMs,
        ...(statusOf(error) !== undefined ? { status: statusOf(error) } : {}),
      };
      onRetry?.(event);
      await sleep(delayMs, ctx.signal);
    }
  }
}

export function circuitBreaker(
  provider: Provider,
  opts: CircuitBreakerOptions,
): Provider {
  if (opts.failureThreshold <= 0) {
    throw new TypeError("failureThreshold must be greater than zero");
  }
  if (opts.cooldownMs <= 0) {
    throw new TypeError("cooldownMs must be greater than zero");
  }
  if (
    opts.halfOpenMax !== undefined &&
    (!Number.isInteger(opts.halfOpenMax) || opts.halfOpenMax <= 0)
  ) {
    throw new TypeError("halfOpenMax must be a positive integer");
  }

  let failures = 0;
  let openedAt = 0;
  let halfOpenInFlight = 0;
  const halfOpenMax = opts.halfOpenMax ?? 1;

  const state = () => {
    if (failures < opts.failureThreshold) return "closed" as const;
    return Date.now() - openedAt >= opts.cooldownMs
      ? ("half-open" as const)
      : ("open" as const);
  };

  type Admission =
    | { readonly state: "closed" }
    | { readonly state: "half-open"; readonly openedAt: number };

  const before = (): Admission => {
    const current = state();
    if (current === "open") {
      throw new ProviderError("provider circuit breaker is open", {
        provider: provider.name,
        retryable: false,
      });
    }
    if (current === "half-open") {
      if (halfOpenInFlight >= halfOpenMax) {
        throw new ProviderError("provider circuit breaker is half-open", {
          provider: provider.name,
          retryable: false,
        });
      }
      halfOpenInFlight += 1;
      return { state: "half-open", openedAt };
    }
    return { state: "closed" };
  };

  const releaseProbe = (admission: Admission) => {
    if (admission.state === "half-open") {
      halfOpenInFlight = Math.max(0, halfOpenInFlight - 1);
    }
  };
  const success = (admission: Admission) => {
    releaseProbe(admission);
    if (admission.state === "half-open" && openedAt !== admission.openedAt) {
      return;
    }
    failures = 0;
    openedAt = 0;
  };
  const failure = (admission: Admission) => {
    releaseProbe(admission);
    failures += 1;
    if (failures >= opts.failureThreshold) openedAt = Date.now();
  };

  return {
    ...provider,
    async complete(req, ctx) {
      const admission = before();
      try {
        const result = await provider.complete(req, ctx);
        success(admission);
        return result;
      } catch (error) {
        if (shouldCountBreakerFailure(error)) failure(admission);
        else releaseProbe(admission);
        throw error;
      }
    },
    async *stream(req, ctx) {
      const admission = before();
      try {
        for await (const event of provider.stream(req, ctx)) yield event;
        success(admission);
      } catch (error) {
        if (shouldCountBreakerFailure(error)) failure(admission);
        else releaseProbe(admission);
        throw error;
      }
    },
  };
}

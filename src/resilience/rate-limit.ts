import { CancelledError } from "../errors";

export interface RateLimitAcquireContext {
  readonly signal?: AbortSignal;
}

export interface RateLimiter {
  acquire(weight?: number, ctx?: RateLimitAcquireContext): Promise<void>;
  report?(headers: Record<string, string>): void;
}

export interface TokenRateLimiter extends RateLimiter {
  acquireForTokens(
    estimatedInputTokens: number,
    estimatedOutputTokens: number,
    ctx?: RateLimitAcquireContext,
  ): Promise<void>;
}

export function isTokenRateLimiter(
  limiter: RateLimiter,
): limiter is TokenRateLimiter {
  return (
    typeof (limiter as { readonly acquireForTokens?: unknown })
      .acquireForTokens === "function"
  );
}

function validatePositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError("rate limit wait cancelled");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError("rate limit wait cancelled"));
    };
    function done(): void {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function fixedWindowRateLimiter(opts: {
  readonly limit: number;
  readonly windowMs: number;
}): RateLimiter {
  validatePositive("limit", opts.limit);
  validatePositive("windowMs", opts.windowMs);
  let windowStart = Date.now();
  let used = 0;
  return {
    async acquire(weight = 1, ctx = {}) {
      validatePositive("weight", weight);
      for (;;) {
        throwIfAborted(ctx.signal);
        const now = Date.now();
        if (now - windowStart >= opts.windowMs) {
          windowStart = now;
          used = 0;
        }
        if (used + weight <= opts.limit) {
          used += weight;
          return;
        }
        await sleep(opts.windowMs - (now - windowStart), ctx.signal);
      }
    },
  };
}

export function slidingWindowRateLimiter(opts: {
  readonly limit: number;
  readonly windowMs: number;
}): RateLimiter {
  validatePositive("limit", opts.limit);
  validatePositive("windowMs", opts.windowMs);
  let entries: Array<{ readonly at: number; readonly weight: number }> = [];
  let head = 0;
  let used = 0;

  const prune = (now: number) => {
    while (head < entries.length && now - entries[head]!.at >= opts.windowMs) {
      used -= entries[head]!.weight;
      head += 1;
    }
    if (head > 1024 && head * 2 >= entries.length) {
      entries = entries.slice(head);
      head = 0;
    }
  };

  return {
    async acquire(weight = 1, ctx = {}) {
      validatePositive("weight", weight);
      if (weight > opts.limit)
        throw new TypeError("weight must not exceed limit");
      for (;;) {
        throwIfAborted(ctx.signal);
        const now = Date.now();
        prune(now);
        if (used + weight <= opts.limit) {
          entries.push({ at: now, weight });
          used += weight;
          return;
        }
        const waitMs = opts.windowMs - (now - entries[head]!.at);
        await sleep(waitMs, ctx.signal);
      }
    },
  };
}

export function tokenBucketRateLimiter(opts: {
  readonly capacity: number;
  readonly refillPerSec: number;
}): RateLimiter {
  validatePositive("capacity", opts.capacity);
  validatePositive("refillPerSec", opts.refillPerSec);
  let tokens = opts.capacity;
  let lastRefill = Date.now();
  const refill = () => {
    const now = Date.now();
    const elapsedSec = (now - lastRefill) / 1000;
    if (elapsedSec > 0) {
      tokens = Math.min(opts.capacity, tokens + elapsedSec * opts.refillPerSec);
      lastRefill = now;
    }
  };
  return {
    async acquire(weight = 1, ctx = {}) {
      validatePositive("weight", weight);
      for (;;) {
        throwIfAborted(ctx.signal);
        refill();
        if (tokens >= weight) {
          tokens -= weight;
          return;
        }
        const missing = weight - tokens;
        await sleep((missing / opts.refillPerSec) * 1000, ctx.signal);
      }
    },
  };
}

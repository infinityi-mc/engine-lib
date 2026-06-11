import { CancelledError } from "../errors";
import type { EngineContext } from "../runtime/types";

interface EngineContextHolder {
  readonly engine?: EngineContext;
}

/** Throw when retrieval work should stop because the caller aborted the run. */
export function throwIfAborted(ctx?: EngineContext | EngineContextHolder): void {
  if (ctx === undefined) return;
  const signal = (ctx as EngineContextHolder).engine?.signal ?? (ctx as EngineContext).signal;
  if (signal?.aborted) throw new CancelledError("retrieval cancelled");
}

/** Assert that an optional numeric option is a positive integer when present. */
export function assertPositiveInteger(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

/** Assert that a numeric option is a non-negative integer. */
export function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

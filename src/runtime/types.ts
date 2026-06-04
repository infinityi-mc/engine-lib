/**
 * Forge integration conventions threaded through engine-lib.
 *
 * Observability is expressed entirely in terms of forge's `Telemetry`
 * handle and `Logger`, so engine-lib never invents its own logging or
 * metrics surface.
 *
 * @module
 */

import type { Telemetry } from "@infinityi/forge/telemetry";
import type { Logger } from "@infinityi/forge/telemetry/log";

/** The unit of observability threaded through engine-lib (forge's `Telemetry` handle). */
export type TelemetryHandle = Telemetry;

/**
 * Options common to every engine-lib entry point (provider calls in
 * Phase 2, agent runs in Phase 4). All fields are optional so the library
 * is usable with zero observability wiring.
 */
export interface EngineContext {
  /** Forge telemetry handle for traces / metrics / logs. */
  readonly telemetry?: TelemetryHandle;
  /** Structured logger (defaults to `telemetry.log` when omitted). */
  readonly logger?: Logger;
  /** Cancellation signal honored by long-running operations (Phase 4). */
  readonly signal?: AbortSignal;
}

export type { Logger, Telemetry };

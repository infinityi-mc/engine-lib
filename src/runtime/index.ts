/**
 * `@infinityi/engine-lib/runtime` — the forge integration surface.
 *
 * Re-exports forge's `Secret` helpers so hosts wiring config-sourced
 * credentials don't need to dual-import from `@infinityi/forge/config`.
 *
 * @module
 */

export { resolveSecret } from "./secret";
export type { EngineContext, Logger, Telemetry, TelemetryHandle } from "./types";

export { isSecret, Secret } from "@infinityi/forge/config";

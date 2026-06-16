/**
 * `@infinityi/engine-lib/events` — the event system & telemetry bridge (Phase 6).
 *
 * The run loop already emits a typed run-event stream (Phase 4). This
 * module adds:
 *
 * - {@link createEventHub} — fan a single run's events out to **multiple
 *   independent subscribers** with ordered, isolated delivery.
 * - {@link loggingSubscriber} / {@link messageBusSubscriber} — ready-made sinks
 *   for forge `Logger` and `MessageBus`.
 * - {@link createRunTelemetry} — automatic `forge/telemetry` spans + metrics for
 *   runs, provider calls, and tool calls.
 *
 * Wire subscribers via `RunOptions.subscribers`; telemetry is enabled
 * automatically whenever a `RunOptions.telemetry` handle is supplied.
 * The root package exports subscriber factories, while this subpath also
 * exposes event projection and telemetry helpers for integrations.
 *
 * @module
 */

export { createEventHub } from "./hub";
export type { EventHub, EventHubOptions, RunSubscriber } from "./types";

export {
  eventFields,
  eventPayload,
  loggingSubscriber,
  messageBusSubscriber,
} from "./subscribers";
export type {
  LoggingSubscriberOptions,
  LogLevel,
  MessageBusSubscriberOptions,
} from "./subscribers";

export {
  createRunTelemetry,
  SPAN_PROVIDER,
  SPAN_RUN,
  SPAN_TOOL,
} from "./telemetry";
export type { Attrs, RunTelemetry, SpanHandle } from "./telemetry";

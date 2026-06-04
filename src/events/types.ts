/**
 * Event-system contracts (Phase 6).
 *
 * A run already emits a {@link RunEvent} stream (Phase 4). Phase 6 adds the
 * ability to attach **multiple independent subscribers** — UI streaming, an
 * audit log, a metrics sink, a `forge/messaging` bridge — to a single run
 * without coupling them to the runtime internals or to each other.
 *
 * A {@link RunSubscriber} is just a function of a {@link RunEvent}. Subscribers
 * are dispatched by an {@link EventHub} (see {@link createEventHub}) in
 * declaration order, awaited, and isolated: a subscriber that throws or rejects
 * is reported but never aborts the run nor starves the other subscribers.
 *
 * @module
 */

import type { RunEvent } from "../execution/types";

/**
 * An external observer of a run. May be sync or async; the hub awaits it so a
 * slow subscriber applies back-pressure to the run (offload heavy work yourself
 * if you don't want that).
 */
export type RunSubscriber = (event: RunEvent) => void | Promise<void>;

/** Fans one {@link RunEvent} out to every registered {@link RunSubscriber}. */
export interface EventHub {
  /** Deliver `event` to all subscribers, in order, awaiting each. */
  emit(event: RunEvent): Promise<void>;
}

/** Options for {@link createEventHub}. */
export interface EventHubOptions {
  /** Subscribers, dispatched in array order. `undefined` entries are ignored. */
  readonly subscribers?: ReadonlyArray<RunSubscriber | undefined>;
  /** Invoked when a subscriber throws/rejects (the run continues regardless). */
  readonly onSubscriberError?: (error: unknown, event: RunEvent, index: number) => void;
}

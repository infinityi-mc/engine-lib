/**
 * {@link createEventHub} — the multi-subscriber fan-out used by the run loop.
 *
 * Dispatch is **ordered and awaited**: each subscriber sees every event in the
 * order they were registered, and the next event is not delivered until the
 * current one has been handed to every subscriber. Each subscriber is
 * **isolated**: a throw/rejection is routed to `onSubscriberError` and
 * swallowed, so one misbehaving subscriber can neither abort the run nor
 * prevent the others from observing the event.
 *
 * @module
 */

import type { EventHub, EventHubOptions, RunSubscriber } from "./types";

/** Build an {@link EventHub} from a fixed list of subscribers. */
export function createEventHub(opts: EventHubOptions = {}): EventHub {
  const subscribers: RunSubscriber[] = (opts.subscribers ?? []).filter(
    (s): s is RunSubscriber => s !== undefined,
  );
  const onSubscriberError = opts.onSubscriberError;

  return {
    async emit(event) {
      for (let i = 0; i < subscribers.length; i++) {
        try {
          await subscribers[i]!(event);
        } catch (error) {
          // The error reporter must never break isolation: a throwing
          // `onSubscriberError` (or logger) cannot abort the run nor starve the
          // remaining subscribers.
          try {
            onSubscriberError?.(error, event, i);
          } catch {
            // Swallow — there is nowhere safe left to surface this.
          }
        }
      }
    },
  };
}

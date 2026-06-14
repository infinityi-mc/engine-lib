/**
 * Built-in {@link RunSubscriber} factories and event projection helpers.
 *
 * These are optional conveniences for the common external sinks. They depend
 * only on forge contracts (`Logger`, `MessageBus`) the host already owns, so
 * engine-lib never forces a transport or a logging backend on you.
 * `eventFields` and `eventPayload` are stable on the `@infinityi/engine-lib/events`
 * subpath for custom subscribers, but intentionally not exported from the root
 * barrel.
 *
 * @module
 */

import type { MessageBus } from "@infinityi/forge/messaging";

import type { RunEvent } from "../execution/types";
import type { Logger } from "../runtime/types";
import type { RunSubscriber } from "./types";

/** Log severities a {@link loggingSubscriber} may emit at. */
export type LogLevel = "trace" | "debug" | "info";

/** Options for {@link loggingSubscriber}. */
export interface LoggingSubscriberOptions {
  /** Severity for each event line. Defaults to `"debug"`. */
  readonly level?: LogLevel;
}

/**
 * A subscriber that writes one structured log line per {@link RunEvent} via a
 * forge {@link Logger}. It logs compact fields from {@link eventFields}, not
 * the full event payload.
 */
export function loggingSubscriber(
  logger: Logger,
  opts: LoggingSubscriberOptions = {},
): RunSubscriber {
  const level: LogLevel = opts.level ?? "debug";
  return (event) => {
    logger[level](`agent.run ${event.type}`, eventFields(event));
  };
}

/** Options for {@link messageBusSubscriber}. */
export interface MessageBusSubscriberOptions {
  /** Prefix prepended to each message `type`. Defaults to `"agent."`. */
  readonly typePrefix?: string;
}

/**
 * A subscriber that republishes every {@link RunEvent} onto a forge
 * {@link MessageBus} (e.g. `agent.run.start`, `agent.tool.call`). The payload
 * is a serialization-safe projection of the event (see {@link eventPayload}).
 * Publish is awaited; a failing publish surfaces through the hub's subscriber
 * isolation rather than aborting the run.
 */
export function messageBusSubscriber(
  bus: MessageBus,
  opts: MessageBusSubscriberOptions = {},
): RunSubscriber {
  const prefix = opts.typePrefix ?? "agent.";
  return async (event) => {
    await bus.publish({
      type: `${prefix}${event.type}`,
      payload: eventPayload(event),
    });
  };
}

/**
 * Compact, log-friendly fields describing an event (no large payloads).
 *
 * This is a stable projection helper for custom subscribers; it is not the full
 * event object.
 */
export function eventFields(
  event: RunEvent,
): Record<string, string | number | boolean> {
  switch (event.type) {
    case "run.start":
      return { runId: event.runId, agent: event.agent };
    case "message":
      return {
        runId: event.runId,
        role: event.message.role,
        parts: event.message.content.length,
      };
    case "token":
      return { runId: event.runId, length: event.delta.length };
    case "tool.call":
      return { runId: event.runId, id: event.id, name: event.name };
    case "tool.result":
      return {
        runId: event.runId,
        id: event.id,
        name: event.name,
        ok: event.result.ok,
      };
    case "run.finish":
      return {
        runId: event.runId,
        finishReason: event.result.finishReason,
        steps: event.result.steps,
        totalTokens: event.result.usage.totalTokens,
      };
    case "error":
      return {
        runId: event.runId,
        name: event.error.name,
        message: event.error.message,
      };
    case "agent.child":
      return {
        runId: event.runId,
        agent: event.agent,
        depth: event.depth,
        child: event.event.type,
      };
    case "agent.handoff":
      return { runId: event.runId, from: event.from, to: event.to };
    case "session.resumed":
      return {
        runId: event.runId,
        sessionId: event.sessionId,
        messageCount: event.messageCount,
        reconciledToolCalls: event.reconciledToolCalls,
      };
    case "session.compacted":
      return {
        runId: event.runId,
        sessionId: event.sessionId,
        removed: event.removed,
        summaryAdded: event.summaryAdded,
      };
    case "session.expired":
      return {
        runId: event.runId,
        sessionId: event.sessionId,
        reason: event.reason,
      };
    case "custom":
      return { runId: event.runId, name: event.name };
  }
}

/**
 * A JSON-serializable projection of an event, for publishing onto a bus.
 *
 * This projection is intentionally smaller and more serialization-friendly than
 * the full {@link RunEvent}; custom subscribers that need exact event objects
 * should consume `RunEvent` directly.
 */
export function eventPayload(event: RunEvent): Record<string, unknown> {
  switch (event.type) {
    case "run.start":
      return { runId: event.runId, agent: event.agent };
    case "message":
      return { runId: event.runId, message: event.message };
    case "token":
      return { runId: event.runId, delta: event.delta };
    case "tool.call":
      return {
        runId: event.runId,
        id: event.id,
        name: event.name,
        arguments: event.arguments,
      };
    case "tool.result":
      return {
        runId: event.runId,
        id: event.id,
        name: event.name,
        result: event.result,
      };
    case "run.finish":
      return {
        runId: event.runId,
        output: event.result.output,
        finishReason: event.result.finishReason,
        steps: event.result.steps,
        usage: event.result.usage,
        messages: event.result.messages,
      };
    case "error":
      return {
        runId: event.runId,
        name: event.error.name,
        message: event.error.message,
      };
    case "agent.child":
      return {
        runId: event.runId,
        agent: event.agent,
        depth: event.depth,
        event: eventPayload(event.event),
      };
    case "agent.handoff":
      return { runId: event.runId, from: event.from, to: event.to };
    case "session.resumed":
      return {
        runId: event.runId,
        sessionId: event.sessionId,
        messageCount: event.messageCount,
        reconciledToolCalls: event.reconciledToolCalls,
        resume: event.resume,
      };
    case "session.compacted":
      return {
        runId: event.runId,
        sessionId: event.sessionId,
        removed: event.removed,
        summaryAdded: event.summaryAdded,
      };
    case "session.expired":
      return {
        runId: event.runId,
        sessionId: event.sessionId,
        reason: event.reason,
      };
    case "custom":
      return { runId: event.runId, name: event.name, data: event.data };
  }
}

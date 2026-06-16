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

import { createHash } from "node:crypto";

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
  /** Payload redaction mode. Defaults to `"digest"`. */
  readonly redaction?: "digest" | "full";
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
  const redaction = opts.redaction ?? "digest";
  return async (event) => {
    await bus.publish({
      type: `${prefix}${event.type}`,
      payload: eventBusPayload(event, redaction),
    });
  };
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex");
}

function eventBusPayload(
  event: RunEvent,
  redaction: "digest" | "full",
): Record<string, unknown> {
  if (redaction === "full") return eventPayload(event);
  switch (event.type) {
    case "message":
      return {
        runId: event.runId,
        role: event.message.role,
        parts: event.message.content.length,
        contentDigest: digest(event.message.content),
      };
    case "token":
      return { runId: event.runId, length: event.delta.length };
    case "tool.call":
      return {
        runId: event.runId,
        id: event.id,
        name: event.name,
        argumentsDigest: digest(event.arguments),
      };
    case "tool.result":
      return {
        runId: event.runId,
        id: event.id,
        name: event.name,
        ok: event.result.ok,
        resultDigest: digest(event.result),
      };
    case "run.finish":
      return {
        runId: event.runId,
        finishReason: event.result.finishReason,
        steps: event.result.steps,
        usage: event.result.usage,
        outputDigest: digest(event.result.output),
        messagesDigest: digest(event.result.messages),
      };
    case "error":
      return {
        runId: event.runId,
        name: event.error.name,
        messageDigest: digest(event.error.message),
      };
    case "agent.child":
      return {
        runId: event.runId,
        agent: event.agent,
        depth: event.depth,
        event: eventBusPayload(event.event, redaction),
      };
    default:
      return eventPayload(event);
  }
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
    case "tool.approval_requested":
      return { runId: event.runId, id: event.id, name: event.name };
    case "tool.approval_decided":
      return {
        runId: event.runId,
        id: event.id,
        name: event.name,
        approved: event.approved,
      };
    case "human.input_requested":
      return { runId: event.runId, requestId: event.requestId };
    case "human.input_provided":
      return {
        runId: event.runId,
        requestId: event.requestId,
        cancelled: event.cancelled,
      };
    case "budget.warning":
      return {
        runId: event.runId,
        field: event.field,
        used: event.used,
        limit: event.limit,
      };
    case "provider.retry":
      return {
        runId: event.runId,
        attempt: event.attempt,
        delayMs: event.delayMs,
      };
    case "rate_limit.wait":
      return { runId: event.runId, waitedMs: event.waitedMs };
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
        code: event.error.constructor.name,
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
    case "tool.authorization_decided":
      return {
        runId: event.runId,
        id: event.id,
        name: event.name,
        allowed: event.allowed,
      };
    case "policy.decision":
      return {
        runId: event.runId,
        id: event.id,
        name: event.name,
        allowed: event.allowed,
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
    case "tool.approval_requested":
      return {
        runId: event.runId,
        id: event.id,
        name: event.name,
        argumentsDigest: event.argumentsDigest,
      };
    case "tool.approval_decided":
      return {
        runId: event.runId,
        id: event.id,
        name: event.name,
        approved: event.approved,
        reason: event.reason,
      };
    case "human.input_requested":
      return {
        runId: event.runId,
        requestId: event.requestId,
        question: event.question,
        context: event.context,
      };
    case "human.input_provided":
      return {
        runId: event.runId,
        requestId: event.requestId,
        cancelled: event.cancelled,
      };
    case "budget.warning":
      return {
        runId: event.runId,
        field: event.field,
        used: event.used,
        limit: event.limit,
      };
    case "provider.retry":
      return {
        runId: event.runId,
        attempt: event.attempt,
        delayMs: event.delayMs,
        status: event.status,
      };
    case "rate_limit.wait":
      return { runId: event.runId, waitedMs: event.waitedMs };
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
        code: event.error.constructor.name,
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
    case "tool.authorization_decided":
      return {
        runId: event.runId,
        id: event.id,
        name: event.name,
        allowed: event.allowed,
        reason: event.reason,
        argumentsDigest: event.argumentsDigest,
      };
    case "policy.decision":
      return {
        runId: event.runId,
        id: event.id,
        name: event.name,
        allowed: event.allowed,
        reason: event.reason,
        requiresApproval: event.requiresApproval,
        transformed: event.transformed,
        argumentsDigest: event.argumentsDigest,
      };
    case "custom":
      return { runId: event.runId, name: event.name, data: event.data };
  }
}

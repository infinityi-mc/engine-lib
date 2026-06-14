import { describe, expect, it } from "bun:test";

import type { RunEvent } from "../src/execution/index";
import {
  createEventHub,
  createRunTelemetry,
  eventFields,
  eventPayload,
  loggingSubscriber,
  messageBusSubscriber,
  SPAN_PROVIDER,
  SPAN_RUN,
  SPAN_TOOL,
  type Attrs,
  type EventHub,
  type EventHubOptions,
  type LoggingSubscriberOptions,
  type LogLevel,
  type MessageBusSubscriberOptions,
  type RunSubscriber,
  type RunTelemetry,
  type SpanHandle,
} from "../src/events/index";
import type { Logger, TelemetryHandle } from "../src/runtime/index";
import type { MessageBus } from "@infinityi/forge/messaging";

function assertEventTelemetryTypes(): void {
  const event: RunEvent = {
    type: "run.start",
    runId: "run_test",
    agent: "typed",
  };

  const syncSubscriber: RunSubscriber = (e) => {
    const type: RunEvent["type"] = e.type;
    void type;
  };
  const asyncSubscriber: RunSubscriber = async (e) => {
    await Promise.resolve(e.type);
  };

  const hubOptions: EventHubOptions = {
    subscribers: [undefined, syncSubscriber, asyncSubscriber],
    onSubscriberError: (error, failedEvent, index) => {
      const unknownError: unknown = error;
      const type: RunEvent["type"] = failedEvent.type;
      const i: number = index;
      void [unknownError, type, i];
    },
  };
  const hub: EventHub = createEventHub(hubOptions);
  hub.emit(event);

  const logLevel: LogLevel = "debug";
  const loggingOptions: LoggingSubscriberOptions = { level: logLevel };
  const logger = undefined as unknown as Logger;
  const logSub: RunSubscriber = loggingSubscriber(logger, loggingOptions);

  const busOptions: MessageBusSubscriberOptions = { typePrefix: "agent." };
  const bus = undefined as unknown as MessageBus;
  const busSub: RunSubscriber = messageBusSubscriber(bus, busOptions);
  void [logSub, busSub];

  const fields: Record<string, string | number | boolean> = eventFields(event);
  const payload: Record<string, unknown> = eventPayload(event);
  void [fields, payload];

  const attrs: Attrs = {
    "agent.name": "typed",
    "agent.steps": 1,
    "tool.ok": true,
  };
  const spanHandle: SpanHandle = {
    setAttributes(next: Attrs) {
      void next;
    },
    ok() {},
    fail(message: string) {
      void message;
    },
    end() {},
  };
  spanHandle.setAttributes(attrs);

  const telemetryHandle = undefined as unknown as TelemetryHandle;
  const runTelemetry: RunTelemetry = createRunTelemetry(telemetryHandle);
  const span = runTelemetry.startSpan(SPAN_RUN, attrs);
  runTelemetry.recordRun(attrs, 10, {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
  });
  runTelemetry.recordTool(attrs, 5);
  runTelemetry.withSpan(SPAN_PROVIDER, attrs, async (activeSpan) => {
    activeSpan.ok();
    return "ok";
  });
  void [span, SPAN_TOOL];

  // @ts-expect-error unsupported logging level.
  const badLogging: LoggingSubscriberOptions = { level: "warn" };
  // @ts-expect-error subscriber must receive a RunEvent.
  const badSubscriber: RunSubscriber = (value: string) => void value;
  // @ts-expect-error Attr values are constrained to primitive telemetry values.
  const badAttrs: Attrs = { nested: { nope: true } };
  void [badLogging, badSubscriber, badAttrs];
}

describe("event/telemetry type contract", () => {
  it("keeps subscribers, event projections, and telemetry bridge typings stable", () => {
    void assertEventTelemetryTypes;
    expect(true).toBe(true);
  });
});

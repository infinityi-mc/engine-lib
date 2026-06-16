import { describe, expect, it } from "bun:test";

import { defineAgent, defineTool } from "../src/agent/index";
import type { AgentHooks } from "../src/agent/index";
import { CancelledError } from "../src/errors";
import { runAgent } from "../src/execution/index";
import type { RunEvent } from "../src/execution/index";
import {
  createEventHub,
  eventFields,
  eventPayload,
  loggingSubscriber,
  messageBusSubscriber,
} from "../src/events/index";
import type { RunSubscriber } from "../src/events/index";
import type { CompletionResult, ToolCall, Usage } from "../src/providers/types";
import type { TelemetryHandle } from "../src/runtime/types";
import { s } from "../src/schema/index";
import { mockProvider } from "../src/testing/index";
import type { MessageBus } from "@infinityi/forge/messaging";

// --- fixtures (mirroring tests/execution.test.ts) --------------------------

function textResult(text: string, usage?: Usage): CompletionResult {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    toolCalls: [],
    finishReason: "stop",
    model: "mock-model",
    raw: {},
    ...(usage !== undefined ? { usage } : {}),
  };
}

function toolCallResult(calls: ToolCall[]): CompletionResult {
  return {
    message: {
      role: "assistant",
      content: calls.map((c) => ({
        type: "tool_call",
        id: c.id,
        name: c.name,
        arguments: c.arguments,
      })),
    },
    toolCalls: calls,
    finishReason: "tool_calls",
    model: "mock-model",
    raw: {},
  };
}

function scriptedProvider(results: CompletionResult[]) {
  let i = 0;
  return mockProvider({
    result: () => results[Math.min(i++, results.length - 1)]!,
  });
}

const echo = defineTool({
  name: "echo",
  parameters: s.object({ value: s.string() }),
  execute: ({ value }) => ({ ok: true, content: value }),
});

const RUN_ID = "run_test";

/** An agent that calls `echo` once, then answers. */
function toolThenAnswer(usage?: Usage) {
  return defineAgent({
    name: "a",
    tools: [echo],
    provider: scriptedProvider([
      toolCallResult([{ id: "c1", name: "echo", arguments: { value: "yo" } }]),
      textResult("done", usage),
    ]),
  });
}

// --- createEventHub --------------------------------------------------------

describe("createEventHub", () => {
  it("fans every event out to all subscribers in registration order", async () => {
    const log: string[] = [];
    const hub = createEventHub({
      subscribers: [
        (e) => void log.push(`s1:${e.type}`),
        (e) => void log.push(`s2:${e.type}`),
      ],
    });
    await hub.emit({ type: "run.start", runId: RUN_ID, agent: "a" });
    await hub.emit({ type: "token", runId: RUN_ID, delta: "x" });
    expect(log).toEqual([
      "s1:run.start",
      "s2:run.start",
      "s1:token",
      "s2:token",
    ]);
  });

  it("isolates a throwing/rejecting subscriber and reports it", async () => {
    const seen: string[] = [];
    const errors: Array<{ index: number; type: string }> = [];
    const hub = createEventHub({
      subscribers: [
        () => {
          throw new Error("sync boom");
        },
        async () => {
          throw new Error("async boom");
        },
        (e) => void seen.push(e.type),
      ],
      onSubscriberError: (_err, event, index) =>
        errors.push({ index, type: event.type }),
    });
    await hub.emit({ type: "token", runId: RUN_ID, delta: "x" });
    // The healthy third subscriber still ran despite the first two failing.
    expect(seen).toEqual(["token"]);
    expect(errors).toEqual([
      { index: 0, type: "token" },
      { index: 1, type: "token" },
    ]);
  });

  it("ignores undefined subscriber slots", async () => {
    const seen: string[] = [];
    const hub = createEventHub({
      subscribers: [undefined, (e) => void seen.push(e.type)],
    });
    await hub.emit({ type: "run.start", runId: RUN_ID, agent: "a" });
    expect(seen).toEqual(["run.start"]);
  });

  it("preserves isolation even when onSubscriberError itself throws", async () => {
    const seen: string[] = [];
    const hub = createEventHub({
      subscribers: [
        () => {
          throw new Error("boom");
        },
        (e) => void seen.push(e.type),
      ],
      onSubscriberError: () => {
        throw new Error("reporter boom");
      },
    });
    // emit must neither reject nor skip the healthy subscriber.
    await hub.emit({ type: "token", runId: RUN_ID, delta: "x" });
    expect(seen).toEqual(["token"]);
  });
});

// --- runAgent: multiple subscribers ---------------------------------------

describe("runAgent — subscribers", () => {
  it("delivers events to onEvent and every subscriber", async () => {
    const a: RunEvent["type"][] = [];
    const b: RunEvent["type"][] = [];
    const c: RunEvent["type"][] = [];
    await runAgent(toolThenAnswer(), {
      input: "go",
      onEvent: (e) => a.push(e.type),
      subscribers: [(e) => void b.push(e.type), (e) => void c.push(e.type)],
    });
    const expected: RunEvent["type"][] = [
      "run.start",
      "message", // assistant tool-call turn
      "tool.call",
      "tool.result",
      "message", // tool-result message
      "message", // final assistant answer
      "run.finish",
    ];
    expect(a).toEqual(expected);
    expect(b).toEqual(expected);
    expect(c).toEqual(expected);
  });

  it("does not abort the run when a subscriber throws", async () => {
    const seen: RunEvent["type"][] = [];
    const result = await runAgent(toolThenAnswer(), {
      input: "go",
      subscribers: [
        () => {
          throw new Error("subscriber boom");
        },
        (e) => void seen.push(e.type),
      ],
    });
    expect(result.output).toBe("done");
    expect(seen).toContain("run.finish");
  });
});

// --- event ↔ hook ordering -------------------------------------------------

describe("runAgent — event/hook ordering", () => {
  it("emits each public event before the corresponding agent hook", async () => {
    const timeline: string[] = [];
    const hooks: AgentHooks = {
      onStart: () => void timeline.push("hook:onStart"),
      onStep: () => void timeline.push("hook:onStep"),
      onToolCall: () => void timeline.push("hook:onToolCall"),
      onToolResult: () => void timeline.push("hook:onToolResult"),
      onFinish: () => void timeline.push("hook:onFinish"),
    };
    const base = toolThenAnswer();
    const agent = defineAgent({ ...base, hooks });
    await runAgent(agent, {
      input: "go",
      subscribers: [(e) => void timeline.push(`event:${e.type}`)],
    });

    // run.start before onStart.
    expect(timeline.indexOf("event:run.start")).toBeLessThan(
      timeline.indexOf("hook:onStart"),
    );
    // tool.call before onToolCall; tool.result before onToolResult.
    expect(timeline.indexOf("event:tool.call")).toBeLessThan(
      timeline.indexOf("hook:onToolCall"),
    );
    expect(timeline.indexOf("event:tool.result")).toBeLessThan(
      timeline.indexOf("hook:onToolResult"),
    );
    // run.finish before onFinish.
    expect(timeline.indexOf("event:run.finish")).toBeLessThan(
      timeline.indexOf("hook:onFinish"),
    );
  });
});

// --- built-in subscribers --------------------------------------------------

describe("loggingSubscriber", () => {
  it("writes one structured line per event at the chosen level", async () => {
    const lines: Array<{ level: string; message: string }> = [];
    const logger = {
      trace: () => {},
      debug: (message: string) => void lines.push({ level: "debug", message }),
      info: (message: string) => void lines.push({ level: "info", message }),
      warn: () => {},
      error: () => {},
      child: () => logger,
    } as unknown as Parameters<typeof loggingSubscriber>[0];

    const sub: RunSubscriber = loggingSubscriber(logger);
    await sub({ type: "run.start", runId: RUN_ID, agent: "a" });
    await sub({
      type: "tool.call",
      runId: RUN_ID,
      id: "c1",
      name: "echo",
      arguments: {},
    });
    expect(lines).toEqual([
      { level: "debug", message: "agent.run run.start" },
      { level: "debug", message: "agent.run tool.call" },
    ]);
  });
});

describe("messageBusSubscriber", () => {
  it("republishes each event onto the bus with a prefixed type and safe payload", async () => {
    const published: Array<{ type: string; payload: unknown }> = [];
    const bus = {
      publish: async (m: { type: string; payload: unknown }) =>
        void published.push(m),
      publishBatch: async () => {},
      flush: async () => {},
      shutdown: async () => {},
    } as unknown as MessageBus;

    await runAgent(toolThenAnswer(), {
      input: "go",
      subscribers: [messageBusSubscriber(bus)],
    });

    const types = published.map((m) => m.type);
    expect(types[0]).toBe("agent.run.start");
    expect(types).toContain("agent.tool.call");
    expect(types.at(-1)).toBe("agent.run.finish");

    const toolCall = published.find((m) => m.type === "agent.tool.call");
    expect(toolCall?.payload).toMatchObject({ id: "c1", name: "echo" });
  });

  it("redacts sensitive bus payloads by default and allows full opt-in", async () => {
    const secret = "super-secret-token";
    const redacted: Array<{ type: string; payload: unknown }> = [];
    const full: Array<{ type: string; payload: unknown }> = [];
    const makeBus = (target: Array<{ type: string; payload: unknown }>) =>
      ({
        publish: async (m: { type: string; payload: unknown }) =>
          void target.push(m),
        publishBatch: async () => {},
        flush: async () => {},
        shutdown: async () => {},
      }) as unknown as MessageBus;

    const event: RunEvent = {
      type: "tool.result",
      runId: RUN_ID,
      id: "c1",
      name: "echo",
      result: { ok: true, content: secret },
    } as never;

    await messageBusSubscriber(makeBus(redacted))(event);
    await messageBusSubscriber(makeBus(full), { redaction: "full" })(event);

    expect(JSON.stringify(redacted[0]?.payload)).not.toContain(secret);
    expect(JSON.stringify(redacted[0]?.payload)).toContain("resultDigest");
    expect(JSON.stringify(full[0]?.payload)).toContain(secret);
  });

  it("event projections do not expose raw error messages", () => {
    const secret = "Authorization: Bearer token123";
    const err = Object.assign(new Error(secret), { name: "ProviderError" });
    expect(
      eventPayload({ type: "error", runId: RUN_ID, error: err as never }),
    ).toEqual({
      runId: RUN_ID,
      name: "ProviderError",
      code: "Error",
    });
    expect(
      JSON.stringify(
        eventFields({ type: "error", runId: RUN_ID, error: err as never }),
      ),
    ).not.toContain(secret);
  });
});

// --- telemetry bridge ------------------------------------------------------

interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
  status?: { code: string; message?: string };
  ended: boolean;
  parent?: string;
}

interface RecordedMetric {
  name: string;
  value: number;
  attributes?: Record<string, unknown>;
}

/** A synchronous telemetry double that records spans (with nesting) + metrics. */
function recordingTelemetry() {
  const spans: RecordedSpan[] = [];
  const metrics: RecordedMetric[] = [];
  const stack: RecordedSpan[] = [];

  const make = (name: string, attrs?: Record<string, unknown>) => {
    const rec: RecordedSpan = {
      name,
      attributes: { ...attrs },
      ended: false,
      parent: stack.length > 0 ? stack[stack.length - 1]!.name : undefined,
    };
    spans.push(rec);
    const span = {
      traceId: "t",
      spanId: String(spans.length),
      isRecording: true,
      setAttribute: (k: string, v: unknown) => {
        rec.attributes[k] = v;
        return span;
      },
      setAttributes: (a: Record<string, unknown>) => {
        Object.assign(rec.attributes, a);
        return span;
      },
      setStatus: (sx: { code: string; message?: string }) => {
        rec.status = sx;
        return span;
      },
      addEvent: () => span,
      addLink: () => span,
      end: () => {
        rec.ended = true;
      },
    };
    return { span, rec };
  };

  const tracer = {
    startSpan: (
      name: string,
      opts?: { attributes?: Record<string, unknown> },
    ) => make(name, opts?.attributes).span,
    withSpan: (
      name: string,
      fn: (span: unknown) => unknown,
      opts?: { attributes?: Record<string, unknown> },
    ) => {
      const { span, rec } = make(name, opts?.attributes);
      stack.push(rec);
      const settle = () => {
        rec.ended = true;
        stack.pop();
      };
      try {
        const result = fn(span) as { then?: unknown };
        if (result && typeof result.then === "function") {
          return (result as Promise<unknown>).then(
            (v) => {
              settle();
              return v;
            },
            (e) => {
              rec.status = {
                code: "error",
                message: e instanceof Error ? e.message : String(e),
              };
              settle();
              throw e;
            },
          );
        }
        settle();
        return result;
      } catch (e) {
        rec.status = {
          code: "error",
          message: e instanceof Error ? e.message : String(e),
        };
        settle();
        throw e;
      }
    },
  };

  const meter = {
    createCounter: (name: string) => ({
      add: (value: number, attributes?: Record<string, unknown>) =>
        void metrics.push({ name, value, attributes }),
    }),
    createGauge: () => ({ record: () => {} }),
    createHistogram: (name: string) => ({
      record: (value: number, attributes?: Record<string, unknown>) =>
        void metrics.push({ name, value, attributes }),
    }),
  };

  const telemetry = {
    tracer,
    meter,
    log: undefined,
  } as unknown as TelemetryHandle;
  return { telemetry, spans, metrics };
}

describe("runAgent — telemetry bridge", () => {
  it("emits nested run/provider/tool spans and usage/latency metrics", async () => {
    const { telemetry, spans, metrics } = recordingTelemetry();
    await runAgent(
      toolThenAnswer({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
      {
        input: "go",
        telemetry,
      },
    );

    const run = spans.find((sp) => sp.name === "agent.run");
    const providerSpans = spans.filter(
      (sp) => sp.name === "agent.provider.call",
    );
    const toolSpans = spans.filter((sp) => sp.name === "agent.tool.execute");

    expect(run).toBeDefined();
    expect(run?.ended).toBe(true);
    expect(run?.status?.code).toBe("ok");
    expect(run?.attributes["agent.name"]).toBe("a");
    expect(run?.attributes["run.id"]).toMatch(/^run_/);
    expect(run?.attributes["agent.finish_reason"]).toBe("stop");

    // Two provider turns (tool-call turn + final answer), one tool execution.
    expect(providerSpans).toHaveLength(2);
    expect(toolSpans).toHaveLength(1);
    // Children nest under the run span and are all ended.
    for (const sp of [...providerSpans, ...toolSpans]) {
      expect(sp.parent).toBe("agent.run");
      expect(sp.attributes["run.id"]).toBe(run?.attributes["run.id"]);
      expect(sp.ended).toBe(true);
    }
    expect(toolSpans[0]?.attributes["tool.name"]).toBe("echo");
    expect(toolSpans[0]?.attributes["tool.ok"]).toBe(true);

    // Metrics: run + tool durations, run counter, and token counters.
    expect(metrics.find((m) => m.name === "agent.run.duration")).toBeDefined();
    expect(metrics.find((m) => m.name === "agent.tool.duration")).toBeDefined();
    expect(
      metrics.find(
        (m) =>
          m.name === "agent.runs" && m.attributes?.["agent.outcome"] === "ok",
      ),
    ).toBeDefined();
    const inputTokens = metrics.find(
      (m) =>
        m.name === "agent.tokens" && m.attributes?.["token.type"] === "input",
    );
    expect(inputTokens?.value).toBe(10);
    expect(
      metrics.some((m) => Object.hasOwn(m.attributes ?? {}, "run.id")),
    ).toBe(false);
  });

  it("marks the run span errored and records an error outcome when the run fails", async () => {
    const { telemetry, spans, metrics } = recordingTelemetry();
    const agent = defineAgent({
      name: "a",
      provider: scriptedProvider([textResult("answer")]),
      hooks: {
        onStart: () => {
          throw new Error("hook exploded");
        },
      },
    });

    await expect(runAgent(agent, { input: "go", telemetry })).rejects.toThrow();

    const run = spans.find((sp) => sp.name === "agent.run");
    expect(run?.status?.code).toBe("error");
    expect(run?.ended).toBe(true);
    expect(
      metrics.find(
        (m) =>
          m.name === "agent.runs" &&
          m.attributes?.["agent.outcome"] === "error",
      ),
    ).toBeDefined();
  });

  it("ends the run span and rejects `completed` when a stream is abandoned early", async () => {
    const { telemetry, spans, metrics } = recordingTelemetry();
    const handle = runAgent(toolThenAnswer(), {
      input: "go",
      stream: true,
      telemetry,
    });

    // Consume a single event, then break without draining the iterator.
    for await (const _ of handle) {
      void _;
      break;
    }

    const run = spans.find((sp) => sp.name === "agent.run");
    expect(run?.ended).toBe(true);
    expect(run?.status?.code).toBe("error");
    await expect(handle.completed).rejects.toBeInstanceOf(CancelledError);
    expect(
      metrics.find(
        (m) =>
          m.name === "agent.runs" &&
          m.attributes?.["agent.outcome"] === "incomplete",
      ),
    ).toBeDefined();
  });
});

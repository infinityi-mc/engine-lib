/**
 * The `forge/telemetry` bridge for agent runs (Phase 6).
 *
 * Wraps the run loop in spans and metrics expressed entirely in terms of
 * forge's `Telemetry` handle — engine-lib never invents its own observability
 * surface. Everything here is a no-op when no telemetry handle (or no
 * tracer/meter) is supplied, so the library stays usable with zero wiring.
 *
 * Spans:
 * - {@link SPAN_RUN} `agent.run` — one per {@link runAgent} call.
 * - {@link SPAN_PROVIDER} `agent.provider.call` — one per provider turn.
 * - {@link SPAN_TOOL} `agent.tool.execute` — one per tool execution.
 *
 * In buffered mode the run span is opened with `tracer.withSpan`, so it is the
 * active context for the whole loop and the provider/tool spans (and the
 * provider's own `tracedFetch` HTTP span) nest underneath it. In streaming mode
 * the run span is opened with `tracer.startSpan` and ended on completion;
 * child spans are still emitted but not nested under it.
 *
 * Metrics: `agent.run.duration` / `agent.tool.duration` (histograms, ms),
 * `agent.tokens` (counter, tagged `token.type`), `agent.runs` (counter, tagged
 * outcome).
 *
 * @module
 */

import type { Usage } from "../providers/types";
import type { TelemetryHandle } from "../runtime/types";

/** Span name for the whole run. */
export const SPAN_RUN = "agent.run";
/** Span name for a single provider turn. */
export const SPAN_PROVIDER = "agent.provider.call";
/** Span name for a single tool execution. */
export const SPAN_TOOL = "agent.tool.execute";

/** Attribute bag accepted by spans and metrics (forge's common subset). */
export type Attrs = Record<string, string | number | boolean>;

// Indexed-access aliases keep us decoupled from forge's exact subpath layout.
type Tracer = NonNullable<TelemetryHandle["tracer"]>;
type Meter = NonNullable<TelemetryHandle["meter"]>;
type Span = ReturnType<Tracer["startSpan"]>;

/** A started span the loop ends manually; a no-op when telemetry is absent. */
export interface SpanHandle {
  setAttributes(attrs: Attrs): void;
  ok(): void;
  fail(message: string): void;
  end(): void;
}

/** The telemetry surface the run loop drives. All methods are no-op safe. */
export interface RunTelemetry {
  /** Run `fn` inside `name` as the active context (nests children). */
  withSpan<T>(name: string, attrs: Attrs, fn: (span: SpanHandle) => Promise<T>): Promise<T>;
  /** Start `name`, parented to the current active span; caller ends it. */
  startSpan(name: string, attrs: Attrs): SpanHandle;
  /** Record run-level duration, outcome, and token usage. */
  recordRun(attrs: Attrs, durationMs: number, usage: Usage): void;
  /** Record one tool execution's duration. */
  recordTool(attrs: Attrs, durationMs: number): void;
}

const NOOP_SPAN: SpanHandle = {
  setAttributes() {},
  ok() {},
  fail() {},
  end() {},
};

function wrapSpan(span: Span): SpanHandle {
  return {
    setAttributes(attrs) {
      span.setAttributes(attrs);
    },
    ok() {
      span.setStatus({ code: "ok" });
    },
    fail(message) {
      span.setStatus({ code: "error", message });
    },
    end() {
      span.end();
    },
  };
}

function tokenTotal(usage: Usage): number {
  return usage.totalTokens + usage.inputTokens + usage.outputTokens;
}

/**
 * Build the {@link RunTelemetry} bridge from a forge telemetry handle.
 * Returns a fully no-op implementation when no tracer/meter is available.
 */
export function createRunTelemetry(telemetry?: TelemetryHandle): RunTelemetry {
  const tracer: Tracer | undefined = telemetry?.tracer;
  const meter: Meter | undefined = telemetry?.meter;

  const runDuration = meter?.createHistogram("agent.run.duration", {
    description: "Wall-clock duration of an agent run.",
    unit: "ms",
  });
  const toolDuration = meter?.createHistogram("agent.tool.duration", {
    description: "Wall-clock duration of a single tool execution.",
    unit: "ms",
  });
  const tokens = meter?.createCounter("agent.tokens", {
    description: "LLM tokens consumed by agent runs.",
    unit: "1",
  });
  const runs = meter?.createCounter("agent.runs", {
    description: "Completed agent runs, tagged by outcome.",
    unit: "1",
  });

  return {
    async withSpan(name, attrs, fn) {
      if (tracer === undefined) return fn(NOOP_SPAN);
      return tracer.withSpan(name, (span) => {
        span.setAttributes(attrs);
        return fn(wrapSpan(span));
      });
    },
    startSpan(name, attrs) {
      if (tracer === undefined) return NOOP_SPAN;
      const span = tracer.startSpan(name, { attributes: attrs });
      return wrapSpan(span);
    },
    recordRun(attrs, durationMs, usage) {
      runDuration?.record(durationMs, attrs);
      runs?.add(1, attrs);
      if (tokenTotal(usage) > 0) {
        tokens?.add(usage.inputTokens, { ...attrs, "token.type": "input" });
        tokens?.add(usage.outputTokens, { ...attrs, "token.type": "output" });
      }
    },
    recordTool(attrs, durationMs) {
      toolDuration?.record(durationMs, attrs);
    },
  };
}

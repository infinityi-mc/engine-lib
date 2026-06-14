/**
 * `@infinityi/engine-lib/testing` — in-memory helpers and assertions for tests.
 *
 * Phase 1 ships only the helpers relevant to the foundation layer;
 * provider and session doubles arrive with Phases 2 and 5.
 *
 * @module
 */

import type { Message } from "../messages/types";
import type { Schema } from "../schema/types";
import type { EngineContext } from "../runtime/types";
import type {
  CompletionRequest,
  CompletionResult,
  Provider,
  ProviderCapabilities,
  ToolCall,
  Usage,
} from "../providers/types";
import { InMemorySessionStore } from "../session/index";
import { collectStream } from "../providers/stream";
import type { StreamEvent } from "../providers/stream";

export { runSessionStoreConformance } from "./store-conformance";
export type {
  SessionStoreConformanceOptions,
  SessionStoreConformanceTestApi,
  SessionStoreFixture,
} from "./store-conformance";

/** Build a `Message[]` from arguments, for readable test fixtures. */
export function conversation(...messages: Message[]): Message[] {
  return messages;
}

const MOCK_CAPABILITIES: ProviderCapabilities = {
  tools: true,
  streaming: true,
  multimodalInput: true,
  parallelToolCalls: true,
  structuredOutput: true,
};

/** Options for {@link mockProvider}. */
export interface MockProviderOptions {
  readonly name?: string;
  readonly defaultModel?: string;
  readonly capabilities?: Partial<ProviderCapabilities>;
  /** Scripted buffered result (or a function of the request). */
  readonly result?:
    | CompletionResult
    | ((req: CompletionRequest) => CompletionResult);
  /** Scripted stream events (or a function of the request). When omitted, a
   * single text/finish stream is derived from {@link MockProviderOptions.result}. */
  readonly events?: StreamEvent[] | ((req: CompletionRequest) => StreamEvent[]);
  /** Called with every request, so tests can assert on what was sent. */
  readonly onRequest?: (req: CompletionRequest, ctx?: EngineContext) => void;
}

/**
 * A network-free {@link Provider} for contract tests and Phase-4 run-loop
 * tests. Returns scripted results/streams and records every request.
 */
export function mockProvider(opts: MockProviderOptions = {}): Provider {
  const name = opts.name ?? "mock";
  const defaultModel = opts.defaultModel ?? "mock-model";

  const resultFor = (req: CompletionRequest): CompletionResult => {
    if (typeof opts.result === "function") return opts.result(req);
    if (opts.result !== undefined) return opts.result;
    return {
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      toolCalls: [],
      finishReason: "stop",
      model: req.model ?? defaultModel,
      raw: {},
    };
  };

  const eventsFor = (req: CompletionRequest): StreamEvent[] => {
    if (typeof opts.events === "function") return opts.events(req);
    if (opts.events !== undefined) return opts.events;
    const result = resultFor(req);
    const text = result.message.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    const events: StreamEvent[] = [
      { type: "message_start", model: result.model },
    ];
    if (text !== "") events.push({ type: "text_delta", text });
    result.toolCalls.forEach((call, index) => {
      const argumentsText =
        call.argumentsText ??
        (call.arguments === undefined
          ? ""
          : (JSON.stringify(call.arguments) ?? ""));
      events.push({
        type: "tool_call_start",
        index,
        id: call.id,
        name: call.name,
      });
      if (argumentsText !== "")
        events.push({
          type: "tool_call_delta",
          index,
          argumentsTextDelta: argumentsText,
        });
      events.push({ type: "tool_call_end", index });
    });
    events.push({
      type: "finish",
      finishReason: result.finishReason,
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    });
    return events;
  };

  return {
    name,
    defaultModel,
    capabilities: { ...MOCK_CAPABILITIES, ...opts.capabilities },
    async complete(
      req: CompletionRequest,
      ctx?: EngineContext,
    ): Promise<CompletionResult> {
      opts.onRequest?.(req, ctx);
      return resultFor(req);
    },
    async *stream(
      req: CompletionRequest,
      ctx?: EngineContext,
    ): AsyncIterable<StreamEvent> {
      opts.onRequest?.(req, ctx);
      for (const event of eventsFor(req)) yield event;
    },
  };
}

/** Drain a {@link Provider.stream} into a {@link CompletionResult} for assertions. */
export async function collectProviderStream(
  provider: Provider,
  req: CompletionRequest,
  ctx?: EngineContext,
): Promise<CompletionResult> {
  return collectStream(
    provider.stream(req, ctx),
    req.model ?? provider.defaultModel,
  );
}

/**
 * Parse `input` with `schema`, returning the typed value. Throws (failing
 * the test) with a readable message listing all issues if invalid.
 */
export function expectValid<T>(schema: Schema<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  throw new Error(`expected input to be valid, but: ${detail}`);
}

// --- network-free `fetch` doubles -----------------------------------------

/** A recorded outbound call captured by a {@link RecordingFetch}. */
export interface RecordedCall {
  readonly url: string;
  readonly init?: RequestInit;
}

/** A fake `fetch` plus the list of calls it recorded. */
export interface RecordingFetch {
  readonly fetch: typeof fetch;
  readonly calls: RecordedCall[];
}

/** A `ReadableStream<Uint8Array>` that emits `chunks` (one enqueue each). */
export function byteStreamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/**
 * A `fetch` that returns a fixed JSON `body` / `status` and records every call,
 * for driving a {@link Provider} adapter without a network.
 */
export function jsonFetch(
  body: unknown,
  init?: { status?: number },
): RecordingFetch {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    requestInit?: RequestInit,
  ) => {
    calls.push({ url: String(input), init: requestInit });
    return new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/**
 * A `fetch` that returns a fixed `text/event-stream` body and records every
 * call, for driving a {@link Provider} adapter's `stream()` without a network.
 */
export function sseFetch(sse: string): RecordingFetch {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    requestInit?: RequestInit,
  ) => {
    calls.push({ url: String(input), init: requestInit });
    return new Response(byteStreamOf(sse), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

// --- scripted `CompletionResult` builders ---------------------------------

const SCRIPTED_MODEL = "mock-model";

/**
 * Build a buffered text {@link CompletionResult} (`finishReason: "stop"`) for
 * scripting a {@link mockProvider} or {@link scriptedProvider} turn.
 */
export function textResult(text: string, usage?: Usage): CompletionResult {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    toolCalls: [],
    finishReason: "stop",
    model: SCRIPTED_MODEL,
    raw: {},
    ...(usage !== undefined ? { usage } : {}),
  };
}

/**
 * Build a tool-call {@link CompletionResult} (`finishReason: "tool_calls"`),
 * mirroring each {@link ToolCall} as a `tool_call` message part.
 */
export function toolCallResult(
  calls: ToolCall[],
  usage?: Usage,
): CompletionResult {
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
    model: SCRIPTED_MODEL,
    raw: {},
    ...(usage !== undefined ? { usage } : {}),
  };
}

/**
 * A {@link Provider} that returns each scripted result in turn; the last
 * result repeats once the script is exhausted. Handy for multi-turn run-loop
 * tests (e.g. a tool call followed by a final answer).
 */
export function scriptedProvider(
  results: readonly CompletionResult[],
  opts?: MockProviderOptions,
): Provider {
  let i = 0;
  return mockProvider({
    ...opts,
    result: () => results[Math.min(i++, results.length - 1)]!,
  });
}

// --- session-store double --------------------------------------------------

export { InMemorySessionStore } from "../session/index";

/** Construct a fresh in-memory {@link SessionStore} double. */
export function inMemorySessionStore(): InMemorySessionStore {
  return new InMemorySessionStore();
}

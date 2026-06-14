/** Shared helpers for provider tests. */

import type { SseMessage } from "../../src/providers/sse";
import type { StreamEvent } from "../../src/providers/stream";

/** A `ReadableStream<Uint8Array>` emitting `chunks` (one enqueue each). */
export function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** An async iterable of canned SSE messages. */
export async function* sseMessages(
  ...messages: SseMessage[]
): AsyncIterable<SseMessage> {
  for (const message of messages) yield message;
}

/** Collect an async iterable of stream events into an array. */
export async function collect(
  events: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** A `fetch` returning a fixed JSON body / status, recording the last call. */
export function jsonFetch(
  body: unknown,
  init?: { status?: number },
): { fetch: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
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

/** A `fetch` returning a fixed SSE body. */
export function sseFetch(sse: string): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    requestInit?: RequestInit,
  ) => {
    calls.push({ url: String(input), init: requestInit });
    return new Response(streamOf(sse), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

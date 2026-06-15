/**
 * A minimal Server-Sent Events reader for provider streaming endpoints.
 *
 * Decodes a `ReadableStream<Uint8Array>` (the `res.raw.body` of a streaming
 * provider response) into `{ event?, data }` records, handling multi-line
 * `data:` fields, `event:` names, comment lines, and CRLF/LF newlines per the
 * SSE spec. Adapters parse each record's `data` as the provider's JSON event.
 *
 * @module
 */

/** Default maximum silence between SSE body chunks. */
export const DEFAULT_SSE_IDLE_TIMEOUT_MS = 30_000;

/** One dispatched SSE message. */
export interface SseMessage {
  /** The `event:` name, if the stream set one. */
  readonly event?: string;
  /** The concatenated `data:` payload (lines joined with `\n`). */
  readonly data: string;
}

/** Options for decoding an SSE byte stream. */
export interface SseParseOptions {
  /** Caller cancellation signal. */
  readonly signal?: AbortSignal;
  /** Maximum silence between body chunks. Default {@link DEFAULT_SSE_IDLE_TIMEOUT_MS}. */
  readonly idleTimeoutMs?: number;
}

function normalizeOptions(
  options?: AbortSignal | SseParseOptions,
): SseParseOptions {
  if (options === undefined) return {};
  if ("aborted" in options) return { signal: options };
  return options;
}

type SseReadResult = { readonly done: boolean; readonly value?: Uint8Array };

type SseReader = { read(): Promise<SseReadResult> };

async function readWithTimeout(
  reader: SseReader,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SseReadResult> {
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("SSE read timeout")),
          timeoutMs,
        );
        if (signal !== undefined) {
          onAbort = () => reject(new DOMException("aborted", "AbortError"));
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/** Decode an SSE byte stream into dispatched {@link SseMessage}s. */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  options?: AbortSignal | SseParseOptions,
): AsyncGenerator<SseMessage> {
  const { signal, idleTimeoutMs = DEFAULT_SSE_IDLE_TIMEOUT_MS } =
    normalizeOptions(options);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];
  let completed = false;

  const flush = (): SseMessage | undefined => {
    if (data.length === 0 && event === undefined) return undefined;
    const message: SseMessage =
      event !== undefined
        ? { event, data: data.join("\n") }
        : { data: data.join("\n") };
    event = undefined;
    data = [];
    return message;
  };

  /** Consume one complete line; returns a message when a blank line flushes one. */
  const consumeLine = (line: string): SseMessage | undefined => {
    if (line === "") return flush();
    if (line.startsWith(":")) return undefined; // comment / keep-alive

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let rest = colon === -1 ? "" : line.slice(colon + 1);
    if (rest.startsWith(" ")) rest = rest.slice(1);

    if (field === "event") event = rest;
    else if (field === "data") data.push(rest);
    // `id` / `retry` fields are ignored.
    return undefined;
  };

  function* drainLines(): Generator<SseMessage> {
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const message = consumeLine(line);
      if (message !== undefined) yield message;
    }
  }

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await readWithTimeout(
        reader,
        idleTimeoutMs,
        signal,
      );
      if (done) {
        completed = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      // Normalize CRLF/CR to LF, but hold back a *trailing* `\r`: it may be the
      // first half of a `\r\n` pair split across the chunk boundary, and
      // normalizing it eagerly would emit a spurious empty line.
      const trailingCr = buffer.endsWith("\r");
      const head = trailingCr ? buffer.slice(0, -1) : buffer;
      buffer = head.replace(/\r\n?/g, "\n") + (trailingCr ? "\r" : "");

      yield* drainLines();
    }

    // Stream ended: flush the decoder and process any remaining content,
    // including a final line with no trailing newline.
    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n?/g, "\n");
    yield* drainLines();
    if (buffer.length > 0) {
      const message = consumeLine(buffer);
      if (message !== undefined) yield message;
      buffer = "";
    }
    const tail = flush();
    if (tail !== undefined) yield tail;
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

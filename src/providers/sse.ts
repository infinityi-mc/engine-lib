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

/** One dispatched SSE message. */
export interface SseMessage {
  /** The `event:` name, if the stream set one. */
  readonly event?: string;
  /** The concatenated `data:` payload (lines joined with `\n`). */
  readonly data: string;
}

/** Decode an SSE byte stream into dispatched {@link SseMessage}s. */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];
  let completed = false;

  const flush = (): SseMessage | undefined => {
    if (data.length === 0 && event === undefined) return undefined;
    const message: SseMessage = event !== undefined
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
      const { done, value } = await reader.read();
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

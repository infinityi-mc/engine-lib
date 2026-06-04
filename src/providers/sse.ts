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

  const flush = (): SseMessage | undefined => {
    if (data.length === 0 && event === undefined) return undefined;
    const message: SseMessage = event !== undefined
      ? { event, data: data.join("\n") }
      : { data: data.join("\n") };
    event = undefined;
    data = [];
    return message;
  };

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      // Normalize CRLF/CR to LF as we split into complete lines.
      buffer = buffer.replace(/\r\n?/g, "\n");
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line === "") {
          const message = flush();
          if (message !== undefined) yield message;
          continue;
        }
        if (line.startsWith(":")) continue; // comment / keep-alive

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let rest = colon === -1 ? "" : line.slice(colon + 1);
        if (rest.startsWith(" ")) rest = rest.slice(1);

        if (field === "event") event = rest;
        else if (field === "data") data.push(rest);
        // `id` / `retry` fields are ignored.
      }
    }
    const message = flush();
    if (message !== undefined) yield message;
  } finally {
    reader.releaseLock();
  }
}

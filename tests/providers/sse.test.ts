import { describe, expect, it } from "bun:test";

import { parseSse } from "../../src/providers/sse";
import type { SseMessage } from "../../src/providers/sse";
import { streamOf } from "./helpers";

async function drain(
  stream: ReadableStream<Uint8Array>,
): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  for await (const message of parseSse(stream)) out.push(message);
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("parseSse", () => {
  it("dispatches on a blank line and parses event/data fields", async () => {
    const messages = await drain(streamOf('event: ping\ndata: {"a":1}\n\n'));
    expect(messages).toEqual([{ event: "ping", data: '{"a":1}' }]);
  });

  it("concatenates multiple data lines with newlines", async () => {
    const messages = await drain(streamOf("data: line1\ndata: line2\n\n"));
    expect(messages).toEqual([{ data: "line1\nline2" }]);
  });

  it("ignores comments and handles CRLF newlines", async () => {
    const messages = await drain(streamOf(": keep-alive\r\ndata: hi\r\n\r\n"));
    expect(messages).toEqual([{ data: "hi" }]);
  });

  it("reassembles messages split across chunk boundaries", async () => {
    const messages = await drain(streamOf("data: hel", "lo\n\ndata: bye\n\n"));
    expect(messages).toEqual([{ data: "hello" }, { data: "bye" }]);
  });

  it("flushes a trailing message with no final blank line", async () => {
    const messages = await drain(streamOf("data: tail\n"));
    expect(messages).toEqual([{ data: "tail" }]);
  });

  it("keeps a single event when a CRLF is split across chunk boundaries", async () => {
    // The `\r` of the first `\r\n` lands at the end of chunk 1; the `\n` opens
    // chunk 2. Eager normalization would split this into two events.
    const messages = await drain(
      streamOf("data: hello\r", "\ndata: world\r\n\r\n"),
    );
    expect(messages).toEqual([{ data: "hello\nworld" }]);
  });

  it("dispatches a final line that has no trailing newline at all", async () => {
    const messages = await drain(streamOf("data: a\n\ndata: b"));
    expect(messages).toEqual([{ data: "a" }, { data: "b" }]);
  });

  it("cancels the stream when iteration stops early", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: one\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const message of parseSse(stream)) {
      expect(message).toEqual({ data: "one" });
      break;
    }

    expect(cancelled).toBe(true);
  });

  it("times out when the body stalls between chunks", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });

    await expect(async () => {
      for await (const _message of parseSse(stream, { idleTimeoutMs: 5 })) {
        // no-op
      }
    }).toThrow("SSE read timeout");
    expect(cancelled).toBe(true);
  });

  it("allows slow-but-active chunks within the idle timeout", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode("data: one\n\n"));
        await delay(5);
        controller.enqueue(encoder.encode("data: two\n\n"));
        controller.close();
      },
    });

    const out: SseMessage[] = [];
    for await (const message of parseSse(stream, { idleTimeoutMs: 50 })) {
      out.push(message);
    }
    expect(out).toEqual([{ data: "one" }, { data: "two" }]);
  });

  it("cancels the stream when aborted while waiting for a chunk", async () => {
    let cancelled = false;
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    setTimeout(() => controller.abort(), 5);

    await expect(async () => {
      for await (const _message of parseSse(stream, {
        signal: controller.signal,
        idleTimeoutMs: 50,
      })) {
        // no-op
      }
    }).toThrow("aborted");
    expect(cancelled).toBe(true);
  });
});

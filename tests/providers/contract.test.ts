import { describe, expect, it } from "bun:test";

import { ProviderError } from "../../src/errors";
import { user } from "../../src/messages/index";
import { createAnthropic } from "../../src/providers/anthropic/index";
import { createGoogle } from "../../src/providers/google/index";
import { createOpenAI } from "../../src/providers/openai/index";
import { createOpenAICompatible } from "../../src/providers/openai-compatible/index";
import type { CompletionRequest } from "../../src/providers/types";
import { collectProviderStream, mockProvider } from "../../src/testing/index";
import { collect, jsonFetch, sseFetch } from "./helpers";

const req: CompletionRequest = { messages: [user("hi")] };

describe("mockProvider", () => {
  it("returns a scripted result and records the request", async () => {
    const seen: CompletionRequest[] = [];
    const provider = mockProvider({
      result: {
        message: { role: "assistant", content: [{ type: "text", text: "scripted" }] },
        toolCalls: [],
        finishReason: "stop",
        model: "mock-model",
        raw: {},
      },
      onRequest: (r) => seen.push(r),
    });
    const result = await provider.complete(req);
    expect(result.message.content).toEqual([{ type: "text", text: "scripted" }]);
    expect(seen).toHaveLength(1);
  });

  it("derives a stream from the result when no events are scripted", async () => {
    const provider = mockProvider();
    const result = await collectProviderStream(provider, req);
    expect(result.message.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("derives tool-call events from the result when no events are scripted", async () => {
    const provider = mockProvider({
      result: {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "tool_call", id: "call_1", name: "lookup", arguments: { city: "SF" } },
          ],
        },
        toolCalls: [
          { id: "call_1", name: "lookup", arguments: { city: "SF" }, argumentsText: '{"city":"SF"}' },
        ],
        finishReason: "tool_calls",
        model: "mock-model",
        raw: {},
      },
    });

    const result = await collectProviderStream(provider, req);

    expect(result.message.content).toEqual([
      { type: "text", text: "checking" },
      { type: "tool_call", id: "call_1", name: "lookup", arguments: { city: "SF" } },
    ]);
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "lookup", arguments: { city: "SF" }, argumentsText: '{"city":"SF"}' },
    ]);
    expect(result.finishReason).toBe("tool_calls");
  });
});

describe("adapter complete() over injected fetch", () => {
  it("openai posts to /responses and parses the result", async () => {
    const { fetch, calls } = jsonFetch({
      model: "gpt-5",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
    });
    const provider = createOpenAI({ apiKey: "k", fetch });
    const result = await provider.complete(req);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(result.message.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("anthropic posts to /messages", async () => {
    const { fetch, calls } = jsonFetch({ model: "claude", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" });
    const provider = createAnthropic({ apiKey: "k", fetch });
    const result = await provider.complete(req);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(result.finishReason).toBe("stop");
  });

  it("google posts to models/{model}:generateContent", async () => {
    const { fetch, calls } = jsonFetch({ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] });
    const provider = createGoogle({ apiKey: "k", model: "gemini-2.5-pro", fetch });
    const result = await provider.complete(req);
    expect(calls[0]?.url).toContain("models/gemini-2.5-pro:generateContent");
    expect(result.message.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("openai-compatible posts to /chat/completions", async () => {
    const { fetch, calls } = jsonFetch({ model: "m", choices: [{ finish_reason: "stop", message: { content: "hi" } }] });
    const provider = createOpenAICompatible({ baseUrl: "https://host/v1", model: "m", fetch });
    const result = await provider.complete(req);
    expect(calls[0]?.url).toBe("https://host/v1/chat/completions");
    expect(result.message.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("lets dedicated apiKey options override conflicting defaultHeaders", async () => {
    const openaiFetch = jsonFetch({ status: "completed", output: [] });
    await createOpenAI({
      apiKey: "sk-real",
      fetch: openaiFetch.fetch,
      defaultHeaders: { authorization: "Bearer sk-other" },
    }).complete(req);
    expect(new Headers(openaiFetch.calls[0]?.init?.headers).get("authorization")).toBe("Bearer sk-real");

    const anthropicFetch = jsonFetch({ content: [], stop_reason: "end_turn" });
    await createAnthropic({
      apiKey: "anthropic-real",
      version: "2023-06-01",
      fetch: anthropicFetch.fetch,
      defaultHeaders: { "x-api-key": "anthropic-other", "anthropic-version": "other-version" },
    }).complete(req);
    const anthropicHeaders = new Headers(anthropicFetch.calls[0]?.init?.headers);
    expect(anthropicHeaders.get("x-api-key")).toBe("anthropic-real");
    expect(anthropicHeaders.get("anthropic-version")).toBe("2023-06-01");

    const googleFetch = jsonFetch({ candidates: [] });
    await createGoogle({
      apiKey: "google-real",
      fetch: googleFetch.fetch,
      defaultHeaders: { "x-goog-api-key": "google-other" },
    }).complete(req);
    expect(new Headers(googleFetch.calls[0]?.init?.headers).get("x-goog-api-key")).toBe("google-real");
  });
});

describe("adapter stream() over injected SSE fetch", () => {
  it("openai-compatible streams text deltas into a finish", async () => {
    const sse = [
      `data: ${JSON.stringify({ model: "m", choices: [{ delta: { content: "he" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "llo" }, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const { fetch } = sseFetch(sse);
    const provider = createOpenAICompatible({ baseUrl: "https://host/v1", model: "m", fetch });
    const events = await collect(provider.stream(req));
    expect(events[0]).toEqual({ type: "message_start", model: "m" });
    expect(events).toContainEqual({ type: "text_delta", text: "he" });
    expect(events).toContainEqual({ type: "text_delta", text: "llo" });
    expect(events[events.length - 1]).toEqual({ type: "finish", finishReason: "stop" });
  });

  it("wraps a mid-stream body error as ProviderError", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ model: "m", choices: [{ delta: { content: "he" } }] })}\n\n`),
        );
        controller.error(new Error("network drop"));
      },
    });
    const fetchImpl = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;
    const provider = createOpenAICompatible({ baseUrl: "https://host/v1", model: "m", fetch: fetchImpl });
    await expect(collect(provider.stream(req))).rejects.toBeInstanceOf(ProviderError);
  });
});

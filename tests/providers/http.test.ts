import { describe, expect, it } from "bun:test";

import { ProviderError } from "../../src/errors";
import {
  createProviderHttp,
  defaultProviderResilience,
  openSseStream,
  toProviderError,
} from "../../src/providers/http";
import type { EngineContext } from "../../src/runtime/types";
import { jsonFetch, streamOf } from "./helpers";

describe("createProviderHttp", () => {
  it("resolves the base URL + path and merges default headers", async () => {
    const { fetch, calls } = jsonFetch({ ok: true });
    const http = createProviderHttp({
      baseUrl: "https://api.example.com/v1",
      headers: { authorization: "Bearer secret" },
      fetch,
    });
    const res = await http.post<{ ok: boolean }>("things", { a: 1 });
    expect(res.body).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("https://api.example.com/v1/things");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer secret",
    );
  });

  it("throws on a non-2xx response", async () => {
    const { fetch } = jsonFetch({ error: "nope" }, { status: 500 });
    const http = createProviderHttp({
      baseUrl: "https://api.example.com",
      headers: {},
      fetch,
    });
    await expect(http.post("things", {})).rejects.toBeDefined();
  });
});

describe("openSseStream", () => {
  it("honours ctx.signal even when req.signal is also provided", async () => {
    let captured: AbortSignal | undefined;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      captured = init?.signal ?? undefined;
      return new Response(streamOf("data: x\n\n"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const reqController = new AbortController();
    const ctxController = new AbortController();
    await openSseStream(
      "test",
      { baseUrl: "https://api.example.com/v1", headers: {}, fetch: fetchImpl },
      { path: "stream", body: {}, signal: reqController.signal },
      { signal: ctxController.signal },
    );

    expect(captured).toBeDefined();
    expect(captured?.aborted).toBe(false);
    ctxController.abort();
    expect(captured?.aborted).toBe(true);
  });

  it("retries transient HTTP statuses before returning the stream", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("rate limited", { status: 429 });
      }
      return new Response(streamOf("data: x\n\n"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const body = await openSseStream(
      "test",
      { baseUrl: "https://api.example.com/v1", headers: {}, fetch: fetchImpl },
      { path: "stream", body: {} },
    );

    expect(body).not.toBeNull();
    expect(attempts).toBe(2);
  });

  it("records streaming request telemetry", async () => {
    const spanNames: string[] = [];
    const metricRecords: Array<{
      value: number;
      attributes?: Record<string, unknown>;
    }> = [];
    const span = {
      setAttribute: () => span,
      setAttributes: () => span,
      setStatus: () => span,
      addEvent: () => span,
      end: () => {},
    };
    const ctx = {
      telemetry: {
        tracer: {
          startSpan: () => span,
          withSpan: (
            name: string,
            fn: (activeSpan: typeof span) => unknown,
          ) => {
            spanNames.push(name);
            return fn(span);
          },
        },
        meter: {
          createHistogram: () => ({
            record: (value: number, attributes?: Record<string, unknown>) => {
              metricRecords.push({ value, attributes });
            },
          }),
        },
      },
    } as unknown as EngineContext;
    const fetchImpl = (async (_input: unknown, _init?: RequestInit) =>
      new Response(streamOf("data: x\n\n"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;

    await openSseStream(
      "test",
      { baseUrl: "https://api.example.com/v1", headers: {}, fetch: fetchImpl },
      { path: "stream", body: {} },
      ctx,
    );

    expect(spanNames).toEqual(["HTTP POST"]);
    expect(metricRecords).toHaveLength(1);
    expect(metricRecords[0]?.attributes).toEqual({
      "http.request.method": "POST",
      "http.response.status_code": "200",
      "server.address": "api.example.com",
    });
  });
});

describe("defaultProviderResilience", () => {
  it("retries transient failures then succeeds", async () => {
    const pipeline = defaultProviderResilience(2_000);
    let attempts = 0;
    const result = await pipeline.execute(() => {
      attempts += 1;
      if (attempts < 3)
        throw Object.assign(new Error("unavailable"), { status: 503 });
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("does not retry an AbortError (user/engine cancellation)", async () => {
    const pipeline = defaultProviderResilience(2_000);
    let attempts = 0;
    await expect(
      pipeline.execute(() => {
        attempts += 1;
        throw new DOMException("aborted", "AbortError");
      }),
    ).rejects.toBeDefined();
    expect(attempts).toBe(1);
  });

  it("does not retry a non-transient (4xx) failure", async () => {
    const pipeline = defaultProviderResilience(2_000);
    let attempts = 0;
    await expect(
      pipeline.execute(() => {
        attempts += 1;
        throw Object.assign(new Error("bad request"), { status: 400 });
      }),
    ).rejects.toBeDefined();
    expect(attempts).toBe(1);
  });
});

describe("toProviderError", () => {
  it("wraps an unknown error, preserving status and cause", () => {
    const cause = Object.assign(new Error("boom"), { status: 502 });
    const error = toProviderError("openai", cause);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.provider).toBe("openai");
    expect(error.message).toContain("HTTP 502");
    expect(error.cause).toBe(cause);
  });

  it("passes an existing ProviderError through unchanged", () => {
    const original = new ProviderError("x", { provider: "anthropic" });
    expect(toProviderError("anthropic", original)).toBe(original);
  });
});

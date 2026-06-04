import { describe, expect, it } from "bun:test";

import { ProviderError } from "../../src/errors";
import {
  createProviderHttp,
  defaultProviderResilience,
  toProviderError,
} from "../../src/providers/http";
import { jsonFetch } from "./helpers";

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
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer secret");
  });

  it("throws on a non-2xx response", async () => {
    const { fetch } = jsonFetch({ error: "nope" }, { status: 500 });
    const http = createProviderHttp({ baseUrl: "https://api.example.com", headers: {}, fetch });
    await expect(http.post("things", {})).rejects.toBeDefined();
  });
});

describe("defaultProviderResilience", () => {
  it("retries transient failures then succeeds", async () => {
    const pipeline = defaultProviderResilience(2_000);
    let attempts = 0;
    const result = await pipeline.execute(() => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("unavailable"), { status: 503 });
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
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

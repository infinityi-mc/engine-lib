import { describe, expect, it } from "bun:test";

import type { RunBridgeEvent } from "../src/execution/types";
import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "../src/tools/types";
import {
  HttpPolicyError,
  createHttpToolClient,
  httpTools,
  type HttpRequestResult,
} from "../src/tools-http/index";

function captureCtx(signal?: AbortSignal): {
  ctx: ToolContext;
  events: RunBridgeEvent[];
} {
  const events: RunBridgeEvent[] = [];
  return {
    events,
    ctx: {
      toolCallId: "call-http",
      ...(signal !== undefined ? { signal } : {}),
      run: {
        emit: (event) => events.push(event),
        reportUsage: () => {},
      },
    },
  };
}

function customNames(events: readonly RunBridgeEvent[]): string[] {
  return events
    .filter(
      (event): event is Extract<RunBridgeEvent, { type: "custom" }> =>
        event.type === "custom",
    )
    .map((event) => event.name);
}

async function run(
  tool: ToolDefinition,
  args: unknown,
  ctx: ToolContext = { toolCallId: "call" },
): Promise<ToolResult> {
  return tool.execute(args as never, ctx);
}

function asFetch(
  fn: (input: unknown, init?: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  return fn as unknown as typeof fetch;
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    statusText: init?.statusText,
    headers: {
      "content-type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
}

describe("tools-http config validation", () => {
  it("requires explicit network scope and valid limits", () => {
    expect(() => createHttpToolClient({})).toThrow(HttpPolicyError);
    expect(() =>
      createHttpToolClient({ allowPublicInternet: true, maxResponseBytes: 0 }),
    ).toThrow(HttpPolicyError);
    expect(() =>
      createHttpToolClient({
        allowPublicInternet: true,
        minTimeoutMs: 500,
        maxTimeoutMs: 100,
      }),
    ).toThrow(HttpPolicyError);
  });

  it("exposes http_get and http_post", () => {
    const tools = httpTools({
      allowedHosts: ["example.com"],
      fetch: asFetch(async () => new Response("ok")),
    });
    expect(tools.httpGet.name).toBe("http_get");
    expect(tools.httpPost.name).toBe("http_post");
  });
});

describe("tools-http policy", () => {
  it("matches wildcard host patterns against apex hosts and subdomains", async () => {
    const requested: string[] = [];
    const { httpGet } = httpTools({
      allowedHosts: ["*.example.com"],
      fetch: asFetch(async (input) => {
        requested.push(String(input));
        return new Response("ok");
      }),
    });

    const apex = await run(httpGet, { url: "https://example.com/" });
    const subdomain = await run(httpGet, { url: "https://api.example.com/" });

    expect(apex.ok).toBe(true);
    expect(subdomain.ok).toBe(true);
    expect(requested).toEqual([
      "https://example.com/",
      "https://api.example.com/",
    ]);
  });

  it("normalizes IDN hosts before applying allow and deny policies", async () => {
    let calls = 0;
    const denied = httpTools({
      allowPublicInternet: true,
      deniedHosts: ["xn--e1awd7f.com"],
      fetch: asFetch(async () => {
        calls += 1;
        return new Response("blocked");
      }),
    });

    const deniedResult = await run(denied.httpGet, {
      url: "https://еріс.com/",
    });
    expect(deniedResult.ok).toBe(false);
    expect(calls).toBe(0);

    const allowed = httpTools({
      allowedHosts: ["*.xn--e1awd7f.com"],
      fetch: asFetch(async () => new Response("ok")),
    });
    const allowedResult = await run(allowed.httpGet, {
      url: "https://еріс.com/",
    });
    expect(allowedResult.ok).toBe(true);
  });

  it("rejects unsupported protocols, denied hosts, private targets, credentialed URLs, and unsafe redirects", async () => {
    let calls = 0;
    const fetchImpl = asFetch(async () => {
      calls += 1;
      return new Response("nope");
    });
    const { httpGet } = httpTools({
      allowPublicInternet: true,
      deniedHosts: ["denied.example"],
      fetch: fetchImpl,
    });

    for (const url of [
      "ftp://example.com/file",
      "https://denied.example/",
      "http://127.0.0.1/",
      "http://0/",
      "http://0x7f000001/",
      "https://user:pass@example.com/",
    ]) {
      const res = await run(httpGet, { url });
      expect(res.ok).toBe(false);
    }

    const redirecting = httpTools({
      allowedHosts: ["example.com"],
      fetch: asFetch(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://other.example/" },
          }),
      ),
    });
    const redirect = await run(redirecting.httpGet, {
      url: "https://example.com/",
    });
    expect(redirect.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it("strips model-supplied headers that are not allowlisted", async () => {
    let seen = new Headers();
    const { httpGet } = httpTools({
      allowedHosts: ["example.com"],
      defaultHeaders: [{ name: "accept", value: "application/json" }],
      allowedRequestHeaders: ["x-allowed"],
      fetch: asFetch(async (_input, init) => {
        seen = new Headers(init?.headers);
        return json({ ok: true });
      }),
    });

    const res = await run(httpGet, {
      url: "https://example.com/data",
      headers: [
        { name: "x-allowed", value: "yes" },
        { name: "authorization", value: "Bearer nope" },
      ],
    });
    expect(res.ok).toBe(true);
    expect(seen.get("accept")).toBe("application/json");
    expect(seen.get("x-allowed")).toBe("yes");
    expect(seen.get("authorization")).toBeNull();
  });
});

describe("http_get/http_post behavior", () => {
  it("parses JSON and text/html responses with compact metadata and events", async () => {
    const { httpGet } = httpTools({
      allowedHosts: ["example.com"],
      fetch: asFetch(async () =>
        json({ answer: 42 }, { headers: { etag: "v1", "x-secret": "hidden" } }),
      ),
    });
    const { ctx, events } = captureCtx();
    const res = await run(httpGet, { url: "https://example.com/json" }, ctx);
    expect(res.ok).toBe(true);
    const out = (res as { content: HttpRequestResult }).content;
    expect(out.bodyJson).toEqual({ answer: 42 });
    expect(out.headers).toEqual([
      { name: "content-type", value: "application/json" },
      { name: "etag", value: "v1" },
    ]);
    expect(customNames(events)).toEqual([
      "http.policy",
      "http.request.start",
      "http.request.end",
    ]);

    const eventUrls = events
      .filter(
        (event): event is Extract<RunBridgeEvent, { type: "custom" }> =>
          event.type === "custom",
      )
      .flatMap((event) => [event.data.url, event.data.finalUrl])
      .filter((url): url is string => typeof url === "string");
    expect(eventUrls.every((url) => !url.includes("secret-token"))).toBe(true);

    const htmlTools = httpTools({
      allowedHosts: ["example.com"],
      fetch: asFetch(
        async () =>
          new Response("<html><body>Hello</body></html>", {
            headers: { "content-type": "text/html" },
          }),
      ),
    });
    const html = await run(htmlTools.httpGet, { url: "https://example.com/" });
    expect(html.ok).toBe(true);
    expect((html as { content: HttpRequestResult }).content.body).toContain(
      "Hello",
    );
  });

  it("redacts sensitive query params in audit events", async () => {
    const { httpGet } = httpTools({
      allowedHosts: ["example.com"],
      fetch: asFetch(async () => new Response("ok")),
    });
    const { ctx, events } = captureCtx();
    const res = await run(
      httpGet,
      { url: "https://example.com/data?api_key=secret-token&keep=value" },
      ctx,
    );
    expect(res.ok).toBe(true);
    const custom = events.filter(
      (event): event is Extract<RunBridgeEvent, { type: "custom" }> =>
        event.type === "custom",
    );
    expect(custom.map((event) => event.data.url)).toContain(
      "https://example.com/data?api_key=%5BREDACTED%5D&keep=value",
    );
  });

  it("caps response bytes and reports truncation", async () => {
    const { httpGet } = httpTools({
      allowedHosts: ["example.com"],
      maxResponseBytes: 5,
      fetch: asFetch(
        async () =>
          new Response("hello world", {
            headers: { "content-type": "text/plain" },
          }),
      ),
    });
    const res = await run(httpGet, { url: "https://example.com/" });
    const out = (res as { content: HttpRequestResult }).content;
    expect(out.body).toBe("hello");
    expect(out.responseBytesTruncated).toBe(true);
    expect(out.bodyTruncated).toBe(true);
  });

  it("honors cancellation without retrying", async () => {
    let attempts = 0;
    const { httpGet } = httpTools({
      allowedHosts: ["example.com"],
      fetch: asFetch(async (_input, init) => {
        attempts += 1;
        if (init?.signal?.aborted) throw new Error("cancelled");
        return new Response("ok");
      }),
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const { ctx } = captureCtx(controller.signal);
    const res = await run(httpGet, { url: "https://example.com/" }, ctx);
    expect(res.ok).toBe(false);
    expect(attempts).toBe(1);
  });

  it("cancels redirect response bodies before following or denying redirect targets", async () => {
    let followedRedirectCancelled = false;
    const followedTools = httpTools({
      allowedHosts: ["example.com"],
      fetch: asFetch(async (input) => {
        const url = String(input);
        if (url.endsWith("/start")) {
          return new Response(
            new ReadableStream({
              cancel: () => {
                followedRedirectCancelled = true;
              },
            }),
            {
              status: 302,
              headers: { location: "https://example.com/final" },
            },
          );
        }
        return new Response("done", {
          headers: { "content-type": "text/plain" },
        });
      }),
    });
    const followed = await run(followedTools.httpGet, {
      url: "https://example.com/start",
    });
    expect(followed.ok).toBe(true);
    expect(followedRedirectCancelled).toBe(true);

    let deniedRedirectCancelled = false;
    const deniedTools = httpTools({
      allowedHosts: ["example.com"],
      fetch: asFetch(
        async () =>
          new Response(
            new ReadableStream({
              cancel: () => {
                deniedRedirectCancelled = true;
              },
            }),
            {
              status: 302,
              headers: { location: "https://other.example/final" },
            },
          ),
      ),
    });
    const denied = await run(deniedTools.httpGet, {
      url: "https://example.com/start",
    });
    expect(denied.ok).toBe(false);
    expect(deniedRedirectCancelled).toBe(true);
  });

  it("evaluates unified policy for redirect targets", async () => {
    const policyTargets: string[] = [];
    const policyArgumentUrls: string[] = [];
    let fetches = 0;
    const { httpGet } = httpTools({
      allowedHosts: ["example.com", "other.example"],
      policy: {
        evaluate: (action) => {
          policyTargets.push(action.target);
          policyArgumentUrls.push((action.arguments as { url: string }).url);
          if (action.target === "https://other.example/final") {
            return { allowed: false, reason: "redirect denied" };
          }
          return { allowed: true };
        },
      },
      fetch: asFetch(async () => {
        fetches += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "https://other.example/final" },
        });
      }),
    });

    const res = await run(httpGet, { url: "https://example.com/start" });

    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("redirect denied");
    expect(fetches).toBe(1);
    expect(policyTargets).toEqual([
      "https://example.com/start",
      "https://other.example/final",
    ]);
    expect(policyArgumentUrls).toEqual([
      "https://example.com/start",
      "https://other.example/final",
    ]);
  });

  it("strips configured and model-supplied headers on cross-origin redirects", async () => {
    let initialHeaders = new Headers();
    let redirectedHeaders = new Headers();
    const { httpGet } = httpTools({
      allowedHosts: ["example.com", "other.example"],
      defaultHeaders: [
        { name: "authorization", value: "Bearer host-secret" },
        { name: "x-api-key", value: "host-key" },
        { name: "accept", value: "application/json" },
      ],
      allowedRequestHeaders: ["x-allowed"],
      fetch: asFetch(async (input, init) => {
        const url = String(input);
        if (url.startsWith("https://example.com/")) {
          initialHeaders = new Headers(init?.headers);
          return new Response(null, {
            status: 302,
            headers: { location: "https://other.example/final" },
          });
        }
        redirectedHeaders = new Headers(init?.headers);
        return json({ ok: true });
      }),
    });

    const res = await run(httpGet, {
      url: "https://example.com/start",
      headers: [{ name: "x-allowed", value: "model-value" }],
    });
    expect(res.ok).toBe(true);
    expect(initialHeaders.get("authorization")).toBe("Bearer host-secret");
    expect(initialHeaders.get("x-api-key")).toBe("host-key");
    expect(initialHeaders.get("x-allowed")).toBe("model-value");
    expect(redirectedHeaders.get("authorization")).toBeNull();
    expect(redirectedHeaders.get("x-api-key")).toBeNull();
    expect(redirectedHeaders.get("accept")).toBeNull();
    expect(redirectedHeaders.get("x-allowed")).toBeNull();
  });

  it("retries transient GET failures and does not retry POST by default", async () => {
    let getAttempts = 0;
    const getTools = httpTools({
      allowedHosts: ["example.com"],
      fetch: asFetch(async () => {
        getAttempts += 1;
        if (getAttempts === 1) throw new Error("temporary network failure");
        return new Response("ok", {
          headers: { "content-type": "text/plain" },
        });
      }),
    });
    const get = await run(getTools.httpGet, { url: "https://example.com/" });
    expect(get.ok).toBe(true);
    expect(getAttempts).toBe(2);

    let postAttempts = 0;
    const postTools = httpTools({
      allowedHosts: ["example.com"],
      fetch: asFetch(async () => {
        postAttempts += 1;
        return new Response("unavailable", {
          status: 503,
          headers: { "content-type": "text/plain" },
        });
      }),
    });
    const post = await run(postTools.httpPost, {
      url: "https://example.com/",
      body: "x",
    });
    expect(post.ok).toBe(true);
    expect((post as { content: HttpRequestResult }).content.status).toBe(503);
    expect(postAttempts).toBe(1);
  });

  it("retries redirected GET requests after POST redirects", async () => {
    const methods: string[] = [];
    let finalAttempts = 0;
    const { httpPost } = httpTools({
      allowedHosts: ["example.com"],
      retry: { initialDelayMs: 0, maxDelayMs: 0 },
      fetch: asFetch(async (input, init) => {
        const url = String(input);
        methods.push(init?.method ?? "GET");
        if (url.endsWith("/start")) {
          return new Response(null, {
            status: 303,
            headers: { location: "https://example.com/final" },
          });
        }
        finalAttempts += 1;
        if (finalAttempts === 1) {
          return new Response("unavailable", {
            status: 503,
            headers: { "content-type": "text/plain" },
          });
        }
        return new Response("ok", {
          headers: { "content-type": "text/plain" },
        });
      }),
    });

    const res = await run(httpPost, {
      url: "https://example.com/start",
      body: "x",
    });
    expect(res.ok).toBe(true);
    const out = (res as { content: HttpRequestResult }).content;
    expect(out.status).toBe(200);
    expect(out.body).toBe("ok");
    expect(finalAttempts).toBe(2);
    expect(methods).toEqual(["POST", "GET", "GET"]);
  });
});

/**
 * Provider conformance suite (Phase 8).
 *
 * A shared, fixture-driven test battery that **every** {@link Provider} adapter
 * must pass — the in-house OpenAI / Anthropic / Google / OpenAI-compatible
 * adapters as well as any third-party adapter. It guarantees cross-provider
 * parity on the parts of the contract that callers above the provider layer
 * rely on: buffered completion, streaming, tool calling, usage reporting,
 * capability honesty, and error mapping.
 *
 * The battery is provider-agnostic: each adapter supplies its **native wire
 * fixtures** (the JSON / SSE bytes its vendor would return) plus the canonical
 * normalized values those fixtures should decode to. The battery drives the
 * public `Provider` seam through an injected fake `fetch` and asserts the
 * normalized {@link CompletionResult} / {@link StreamEvent} shape — never the
 * vendor wire format.
 *
 * Shipped from its own subpath (`@infinityi/engine-lib/testing/conformance`)
 * rather than the main `@infinityi/engine-lib/testing` barrel. It registers
 * tests against Bun's test-runner API when called, while remaining safe to
 * import in non-Bun runtimes.
 *
 * @example
 * ```ts
 * import { describe, expect, it } from "bun:test";
 * import { runProviderConformance } from "@infinityi/engine-lib/testing/conformance";
 * import { createOpenAICompatible } from "@infinityi/engine-lib/providers";
 *
 * runProviderConformance("openai-compatible", {
 *   testApi: { describe, expect, it },
 *   makeProvider: ({ fetch }) => createOpenAICompatible({ baseUrl: "https://h/v1", model: "m", fetch }),
 *   expectPath: "/chat/completions",
 *   fixtures: {
 *     text: { body: { choices: [{ finish_reason: "stop", message: { content: "hi" } }] }, expectText: "hi" },
 *     // …toolCall, usage, stream
 *   },
 * });
 * ```
 *
 * @module
 */

import type {
  describe as bunDescribe,
  expect as bunExpect,
  it as bunIt,
} from "bun:test";

import { combine } from "@infinityi/forge/resilience";
import type { PipelineLike } from "@infinityi/forge/http/client";
import { ProviderError } from "../errors";
import { user } from "../messages/index";
import type { CompletionRequest, Provider, Usage } from "../providers/types";
import type { StreamEvent } from "../providers/stream";
import { jsonFetch, sseFetch } from "./index";

/** A `fetch`-compatible function. */
type FetchFn = typeof globalThis.fetch;

export interface ConformanceTestApi {
  readonly describe: typeof bunDescribe;
  readonly expect: typeof bunExpect;
  readonly it: typeof bunIt;
}

function getTestApi(): ConformanceTestApi {
  const globals = globalThis as typeof globalThis & Partial<ConformanceTestApi>;
  if (
    typeof globals.describe === "function" &&
    typeof globals.expect === "function" &&
    typeof globals.it === "function"
  ) {
    return {
      describe: globals.describe,
      expect: globals.expect,
      it: globals.it,
    };
  }

  try {
    const requireFn = (0, eval)("require") as
      | ((id: string) => Partial<ConformanceTestApi>)
      | undefined;
    const api =
      typeof requireFn === "function" ? requireFn("bun:test") : undefined;
    if (
      typeof api?.describe === "function" &&
      typeof api.expect === "function" &&
      typeof api.it === "function"
    ) {
      return {
        describe: api.describe,
        expect: api.expect,
        it: api.it,
      };
    }
  } catch {
    // Fall through to the explicit error below.
  }

  throw new Error(
    "runProviderConformance requires Bun's test runner; call it from a Bun test file.",
  );
}

/** The transport seams the battery injects into the adapter under test. */
export interface ProviderIO {
  /** Fake `fetch` returning the fixture bytes. */
  readonly fetch: FetchFn;
  /** Optional resilience override (the battery passes a no-retry pipeline
   * for the error-mapping case so it doesn't pay the default retry backoff). */
  readonly resilience?: PipelineLike;
}

/** Build a fresh adapter wired to the supplied transport seams. */
export type MakeProvider = (io: ProviderIO) => Provider;

/** A single-attempt pipeline (`combine()` of no policies) — never retries. */
const NO_RETRY: PipelineLike = combine();

/** Native wire fixtures plus the canonical normalized values they decode to. */
export interface ConformanceFixtures {
  /** A buffered completion whose body decodes to assistant text. */
  readonly text: { readonly body: unknown; readonly expectText: string };
  /** A buffered completion whose body decodes to a single tool call. */
  readonly toolCall: {
    readonly body: unknown;
    readonly expectName: string;
    readonly expectArgs?: Record<string, unknown>;
  };
  /** A buffered completion whose body reports token usage. */
  readonly usage: { readonly body: unknown; readonly expect: Usage };
  /**
   * A streaming response (raw `text/event-stream` bytes) that yields text
   * deltas and a final finish. Provide this iff the adapter declares
   * `capabilities.streaming` — the battery cross-checks the two.
   */
  readonly stream?: { readonly sse: string; readonly expectText: string };
  /** A stream that omits the provider's normal terminal event but should still finish. */
  readonly streamingError?: {
    readonly sse: string;
    readonly expectText: string;
  };
  /** Whether the adapter should wrap a mid-body stream failure as ProviderError. */
  readonly truncatedBody?: true;
}

/** Options for {@link runProviderConformance}. */
export interface ConformanceOptions {
  /** Factory building the adapter under test from an injected fake `fetch`. */
  readonly makeProvider: MakeProvider;
  /** The native wire fixtures for this provider. */
  readonly fixtures: ConformanceFixtures;
  /** Substring asserted to appear in the request URL (e.g. `/messages`). */
  readonly expectPath?: string;
  /** Test-runner API. Pass Bun's `{ describe, expect, it }` from a test file. */
  readonly testApi?: ConformanceTestApi;
}

const REQUEST: CompletionRequest = { messages: [user("hi")] };

async function collect(
  events: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/**
 * Register a `describe()` block of shared assertions the `Provider` adapter
 * `name` must satisfy. Call it from a `*.test.ts` file (it uses `bun:test`).
 */
export function runProviderConformance(
  name: string,
  opts: ConformanceOptions,
): void {
  const { describe, expect, it } = opts.testApi ?? getTestApi();
  const { makeProvider, fixtures, expectPath } = opts;

  describe(`provider conformance — ${name}`, () => {
    it("declares honest, well-formed capabilities and identity", () => {
      const provider = makeProvider({
        fetch: jsonFetch(fixtures.text.body).fetch,
      });
      expect(typeof provider.name).toBe("string");
      expect(provider.name.length).toBeGreaterThan(0);
      expect(typeof provider.defaultModel).toBe("string");
      expect(provider.defaultModel.length).toBeGreaterThan(0);

      const caps = provider.capabilities;
      for (const flag of [
        caps.tools,
        caps.streaming,
        caps.multimodalInput,
        caps.parallelToolCalls,
        caps.structuredOutput,
      ]) {
        expect(typeof flag).toBe("boolean");
      }
      // A streaming fixture is meaningful only if the adapter claims streaming.
      if (fixtures.stream !== undefined) expect(caps.streaming).toBe(true);
    });

    it("completes a buffered turn into normalized text", async () => {
      const { fetch, calls } = jsonFetch(fixtures.text.body);
      const result = await makeProvider({ fetch }).complete(REQUEST);

      expect(calls.length).toBeGreaterThan(0);
      if (expectPath !== undefined) expect(calls[0]?.url).toContain(expectPath);

      expect(result.finishReason).toBe("stop");
      expect(typeof result.model).toBe("string");
      const text = result.message.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
      expect(text).toBe(fixtures.text.expectText);
    });

    it("surfaces a tool call with an id, name, and parsed arguments", async () => {
      const result = await makeProvider({
        fetch: jsonFetch(fixtures.toolCall.body).fetch,
      }).complete(REQUEST);

      expect(result.finishReason).toBe("tool_calls");
      expect(result.toolCalls.length).toBeGreaterThan(0);
      const call = result.toolCalls[0]!;
      expect(typeof call.id).toBe("string");
      expect(call.id.length).toBeGreaterThan(0);
      expect(call.name).toBe(fixtures.toolCall.expectName);
      if (fixtures.toolCall.expectArgs !== undefined) {
        expect(call.arguments).toEqual(fixtures.toolCall.expectArgs);
      }
      // The tool call is also present as a message part (Phase-1 model).
      expect(result.message.content.some((p) => p.type === "tool_call")).toBe(
        true,
      );
    });

    it("normalizes token usage", async () => {
      const result = await makeProvider({
        fetch: jsonFetch(fixtures.usage.body).fetch,
      }).complete(REQUEST);
      expect(result.usage).toBeDefined();
      expect(result.usage?.inputTokens).toBe(fixtures.usage.expect.inputTokens);
      expect(result.usage?.outputTokens).toBe(
        fixtures.usage.expect.outputTokens,
      );
      expect(result.usage?.totalTokens).toBe(fixtures.usage.expect.totalTokens);
    });

    it("maps a non-2xx response to a ProviderError", async () => {
      // Use a no-retry pipeline: a 500 would otherwise be retried 3× through the
      // adapter's default resilience, adding seconds of backoff to every run.
      const provider = makeProvider({
        fetch: jsonFetch({ error: "boom" }, { status: 500 }).fetch,
        resilience: NO_RETRY,
      });
      await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(
        ProviderError,
      );
    });

    const streamFixture = fixtures.stream;
    if (
      streamFixture === undefined &&
      (fixtures.streamingError !== undefined || fixtures.truncatedBody === true)
    ) {
      throw new Error(
        "Conformance fixtures: `streamingError`/`truncatedBody` require `stream`.",
      );
    }
    if (streamFixture !== undefined) {
      it("streams text deltas bracketed by message_start and finish", async () => {
        const events = await collect(
          makeProvider({ fetch: sseFetch(streamFixture.sse).fetch }).stream(
            REQUEST,
          ),
        );

        expect(events[0]?.type).toBe("message_start");
        expect(events[events.length - 1]?.type).toBe("finish");
        const text = events
          .filter(
            (e): e is Extract<StreamEvent, { type: "text_delta" }> =>
              e.type === "text_delta",
          )
          .map((e) => e.text)
          .join("");
        expect(text).toBe(streamFixture.expectText);
      });

      const streamingErrorFixture = fixtures.streamingError;
      if (streamingErrorFixture !== undefined) {
        it("emits a fallback finish when the stream omits its terminal event", async () => {
          const events = await collect(
            makeProvider({
              fetch: sseFetch(streamingErrorFixture.sse).fetch,
            }).stream(REQUEST),
          );

          expect(events[0]?.type).toBe("message_start");
          expect(events[events.length - 1]?.type).toBe("finish");
          const text = events
            .filter(
              (e): e is Extract<StreamEvent, { type: "text_delta" }> =>
                e.type === "text_delta",
            )
            .map((e) => e.text)
            .join("");
          expect(text).toBe(streamingErrorFixture.expectText);
        });
      }

      if (fixtures.truncatedBody === true) {
        it("wraps a truncated streaming body as ProviderError", async () => {
          const encoder = new TextEncoder();
          const truncatedSse =
            fixtures.streamingError?.sse ?? streamFixture.sse;
          let sent = false;
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(encoder.encode(truncatedSse));
                return;
              }
              controller.error(new Error("network drop"));
            },
          });
          const fetchImpl = (async () =>
            new Response(body, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            })) as unknown as FetchFn;

          await expect(
            collect(makeProvider({ fetch: fetchImpl }).stream(REQUEST)),
          ).rejects.toBeInstanceOf(ProviderError);
        });
      }
    } else {
      it.skip("streaming (no stream fixture provided)", () => {});
    }
  });
}

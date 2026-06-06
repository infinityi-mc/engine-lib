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
 * Shipped from its own subpath (`engine-lib/testing/conformance`) rather than
 * the main `engine-lib/testing` barrel, because it imports `bun:test`; keeping
 * it separate lets `engine-lib/testing` (mocks, fake `fetch`) stay importable
 * outside a test runner.
 *
 * @example
 * ```ts
 * import { runProviderConformance } from "engine-lib/testing/conformance";
 * import { createOpenAICompatible } from "engine-lib/providers";
 *
 * runProviderConformance("openai-compatible", {
 *   makeProvider: (fetch) => createOpenAICompatible({ baseUrl: "https://h/v1", model: "m", fetch }),
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

import { describe, expect, it } from "bun:test";

import { ProviderError } from "../errors";
import { user } from "../messages/index";
import type { CompletionRequest, Provider, Usage } from "../providers/types";
import type { StreamEvent } from "../providers/stream";
import { jsonFetch, sseFetch } from "./index";

/** A `fetch`-compatible function. */
type FetchFn = typeof globalThis.fetch;

/** Build a fresh adapter wired to the supplied fake `fetch`. */
export type MakeProvider = (fetch: FetchFn) => Provider;

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
}

/** Options for {@link runProviderConformance}. */
export interface ConformanceOptions {
  /** Factory building the adapter under test from an injected fake `fetch`. */
  readonly makeProvider: MakeProvider;
  /** The native wire fixtures for this provider. */
  readonly fixtures: ConformanceFixtures;
  /** Substring asserted to appear in the request URL (e.g. `/messages`). */
  readonly expectPath?: string;
}

const REQUEST: CompletionRequest = { messages: [user("hi")] };

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/**
 * Register a `describe()` block of shared assertions the `Provider` adapter
 * `name` must satisfy. Call it from a `*.test.ts` file (it uses `bun:test`).
 */
export function runProviderConformance(name: string, opts: ConformanceOptions): void {
  const { makeProvider, fixtures, expectPath } = opts;

  describe(`provider conformance — ${name}`, () => {
    it("declares honest, well-formed capabilities and identity", () => {
      const provider = makeProvider(jsonFetch(fixtures.text.body).fetch);
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
      const result = await makeProvider(fetch).complete(REQUEST);

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
      const result = await makeProvider(jsonFetch(fixtures.toolCall.body).fetch).complete(REQUEST);

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
      expect(result.message.content.some((p) => p.type === "tool_call")).toBe(true);
    });

    it("normalizes token usage", async () => {
      const result = await makeProvider(jsonFetch(fixtures.usage.body).fetch).complete(REQUEST);
      expect(result.usage).toBeDefined();
      expect(result.usage?.inputTokens).toBe(fixtures.usage.expect.inputTokens);
      expect(result.usage?.outputTokens).toBe(fixtures.usage.expect.outputTokens);
      expect(result.usage?.totalTokens).toBe(fixtures.usage.expect.totalTokens);
    });

    it("maps a non-2xx response to a ProviderError", async () => {
      const provider = makeProvider(jsonFetch({ error: "boom" }, { status: 500 }).fetch);
      await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(ProviderError);
    });

    const streamFixture = fixtures.stream;
    if (streamFixture !== undefined) {
      it("streams text deltas bracketed by message_start and finish", async () => {
        const events = await collect(makeProvider(sseFetch(streamFixture.sse).fetch).stream(REQUEST));

        expect(events[0]?.type).toBe("message_start");
        expect(events[events.length - 1]?.type).toBe("finish");
        const text = events
          .filter((e): e is Extract<StreamEvent, { type: "text_delta" }> => e.type === "text_delta")
          .map((e) => e.text)
          .join("");
        expect(text).toBe(streamFixture.expectText);
      });
    } else {
      it.skip("streaming (no stream fixture provided)", () => {});
    }
  });
}

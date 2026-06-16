/**
 * Drives every in-house adapter through the shared provider conformance
 * battery (`@infinityi/engine-lib/testing`), proving cross-provider parity on the
 * normalized contract: completion, tool calling, usage, capability honesty,
 * error mapping, and streaming. Each adapter supplies only its native wire
 * fixtures; the battery asserts the normalized result shape.
 */

import { describe, expect, it } from "bun:test";

import { createAnthropic } from "../../src/providers/anthropic/index";
import { createGoogle } from "../../src/providers/google/index";
import { createOpenAI } from "../../src/providers/openai/index";
import { createOpenAICompatible } from "../../src/providers/openai-compatible/index";
import { runProviderConformance } from "../../src/testing/conformance";

const testApi = { describe, expect, it };

runProviderConformance("openai", {
  testApi,
  makeProvider: ({ fetch, resilience }) =>
    createOpenAI({ apiKey: "k", fetch, resilience }),
  expectPath: "/responses",
  fixtures: {
    text: {
      body: {
        model: "gpt-5",
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: "hi" }] },
        ],
      },
      expectText: "hi",
    },
    toolCall: {
      body: {
        model: "gpt-5",
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "get_weather",
            arguments: '{"city":"SF"}',
          },
        ],
      },
      expectName: "get_weather",
      expectArgs: { city: "SF" },
    },
    usage: {
      body: {
        model: "gpt-5",
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: "hi" }] },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
      expect: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
    stream: {
      sse: [
        `data: ${JSON.stringify({ type: "response.created" })}\n\n`,
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}\n\n`,
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "hi" }],
              },
            ],
          },
        })}\n\n`,
      ].join(""),
      expectText: "hi",
    },
    streamingError: {
      sse: [
        `data: ${JSON.stringify({ type: "response.created" })}\n\n`,
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}\n\n`,
      ].join(""),
      expectText: "hi",
    },
    truncatedBody: true,
  },
});

runProviderConformance("anthropic", {
  testApi,
  makeProvider: ({ fetch, resilience }) =>
    createAnthropic({ apiKey: "k", fetch, resilience }),
  expectPath: "/messages",
  fixtures: {
    text: {
      body: {
        model: "claude",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
      },
      expectText: "hi",
    },
    toolCall: {
      body: {
        model: "claude",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "get_weather",
            input: { city: "SF" },
          },
        ],
        stop_reason: "tool_use",
      },
      expectName: "get_weather",
      expectArgs: { city: "SF" },
    },
    usage: {
      body: {
        model: "claude",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      expect: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
    stream: {
      sse: [
        `data: ${JSON.stringify({ type: "message_start", message: { model: "claude" } })}\n\n`,
        `data: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hi" },
        })}\n\n`,
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n`,
        `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ].join(""),
      expectText: "hi",
    },
    streamingError: {
      sse: [
        `data: ${JSON.stringify({ type: "message_start", message: { model: "claude" } })}\n\n`,
        `data: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hi" },
        })}\n\n`,
      ].join(""),
      expectText: "hi",
    },
    truncatedBody: true,
  },
});

runProviderConformance("google", {
  testApi,
  makeProvider: ({ fetch, resilience }) =>
    createGoogle({ apiKey: "k", model: "gemini-2.5-pro", fetch, resilience }),
  expectPath: "models/gemini-2.5-pro",
  fixtures: {
    text: {
      body: {
        candidates: [
          { content: { parts: [{ text: "hi" }] }, finishReason: "STOP" },
        ],
      },
      expectText: "hi",
    },
    toolCall: {
      body: {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: "get_weather", args: { city: "SF" } } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
      expectName: "get_weather",
      expectArgs: { city: "SF" },
    },
    usage: {
      body: {
        candidates: [
          { content: { parts: [{ text: "hi" }] }, finishReason: "STOP" },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      },
      expect: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
    stream: {
      sse: [
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }] })}\n\n`,
        `data: ${JSON.stringify({ candidates: [{ finishReason: "STOP" }] })}\n\n`,
      ].join(""),
      expectText: "hi",
    },
    streamingError: {
      sse: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }] })}\n\n`,
      expectText: "hi",
    },
    truncatedBody: true,
  },
});

runProviderConformance("openai-compatible", {
  testApi,
  makeProvider: ({ fetch, resilience }) =>
    createOpenAICompatible({
      baseUrl: "https://host/v1",
      model: "m",
      fetch,
      resilience,
    }),
  expectPath: "/chat/completions",
  fixtures: {
    text: {
      body: {
        model: "m",
        choices: [{ finish_reason: "stop", message: { content: "hi" } }],
      },
      expectText: "hi",
    },
    toolCall: {
      body: {
        model: "m",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"SF"}' },
                },
              ],
            },
          },
        ],
      },
      expectName: "get_weather",
      expectArgs: { city: "SF" },
    },
    usage: {
      body: {
        model: "m",
        choices: [{ finish_reason: "stop", message: { content: "hi" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      expect: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
    stream: {
      sse: [
        `data: ${JSON.stringify({ model: "m", choices: [{ delta: { content: "hi" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""),
      expectText: "hi",
    },
    streamingError: {
      sse: `data: ${JSON.stringify({ model: "m", choices: [{ delta: { content: "hi" } }] })}\n\n`,
      expectText: "hi",
    },
    truncatedBody: true,
  },
});

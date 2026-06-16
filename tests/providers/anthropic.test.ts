import { describe, expect, it } from "bun:test";

import { assistant, system, toolResult, user } from "../../src/messages/index";
import {
  buildAnthropicBody,
  parseAnthropicResponse,
} from "../../src/providers/anthropic/map";
import { translateAnthropicStream } from "../../src/providers/anthropic/stream";
import type { CompletionRequest } from "../../src/providers/types";
import type { ToolCallPart } from "../../src/messages/types";
import { collect, sseMessages } from "./helpers";

describe("buildAnthropicBody", () => {
  it("hoists system, defaults max_tokens, and maps a user turn", () => {
    const req: CompletionRequest = { messages: [system("sys"), user("hi")] };
    const body = buildAnthropicBody(req, "claude", false) as Record<
      string,
      any
    >;
    expect(body["system"]).toBe("sys");
    expect(body["max_tokens"]).toBe(4096);
    expect(body["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  it("folds a tool result into a user turn with tool_result block", () => {
    const toolCall: ToolCallPart = {
      type: "tool_call",
      id: "tu_1",
      name: "f",
      arguments: { a: 1 },
    };
    const req: CompletionRequest = {
      messages: [assistant([toolCall]), toolResult("tu_1", "ok")],
    };
    const body = buildAnthropicBody(req, "claude", false) as Record<
      string,
      any
    >;
    expect(body["messages"]).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "f", input: { a: 1 } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
      },
    ]);
  });

  it("maps tools to input_schema and required → any", () => {
    const req: CompletionRequest = {
      messages: [user("x")],
      tools: [{ name: "f", parameters: { type: "object" } }],
      toolChoice: "required",
    };
    const body = buildAnthropicBody(req, "claude", false) as Record<
      string,
      any
    >;
    expect(body["tools"]).toEqual([
      { name: "f", input_schema: { type: "object" }, strict: true },
    ]);
    expect(body["tool_choice"]).toEqual({ type: "any" });
  });
});

describe("parseAnthropicResponse", () => {
  it("parses text + tool_use + usage and maps stop_reason", () => {
    const raw = {
      model: "claude",
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", id: "tu_1", name: "f", input: { a: 1 } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 2 },
    };
    const result = parseAnthropicResponse(raw, "claude");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "tu_1", name: "f", arguments: { a: 1 }, argumentsText: '{"a":1}' },
    ]);
    expect(result.usage).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
      cachedInputTokens: 2,
    });
  });
});

describe("translateAnthropicStream", () => {
  it("translates Messages SSE into unified events", async () => {
    const events = await collect(
      translateAnthropicStream(
        sseMessages(
          {
            event: "message_start",
            data: JSON.stringify({
              type: "message_start",
              message: { model: "claude", usage: { input_tokens: 5 } },
            }),
          },
          {
            event: "content_block_start",
            data: JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: "tu_1", name: "f" },
            }),
          },
          {
            event: "content_block_delta",
            data: JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: '{"a":1}' },
            }),
          },
          {
            event: "content_block_stop",
            data: JSON.stringify({ type: "content_block_stop", index: 0 }),
          },
          {
            event: "message_delta",
            data: JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "tool_use" },
              usage: { output_tokens: 7 },
            }),
          },
          {
            event: "message_stop",
            data: JSON.stringify({ type: "message_stop" }),
          },
        ),
        "claude",
      ),
    );
    expect(events).toEqual([
      { type: "message_start", model: "claude" },
      { type: "tool_call_start", index: 0, id: "tu_1", name: "f" },
      { type: "tool_call_delta", index: 0, argumentsTextDelta: '{"a":1}' },
      { type: "tool_call_end", index: 0 },
      {
        type: "finish",
        finishReason: "tool_calls",
        usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
      },
    ]);
  });

  it("emits finish when the stream ends before message_stop", async () => {
    const events = await collect(
      translateAnthropicStream(
        sseMessages(
          {
            event: "message_start",
            data: JSON.stringify({
              type: "message_start",
              message: { model: "claude", usage: { input_tokens: 5 } },
            }),
          },
          {
            event: "content_block_delta",
            data: JSON.stringify({
              type: "content_block_delta",
              delta: { type: "text_delta", text: "hi" },
            }),
          },
          {
            event: "message_delta",
            data: JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 1 },
            }),
          },
        ),
        "claude",
      ),
    );
    expect(events).toEqual([
      { type: "message_start", model: "claude" },
      { type: "text_delta", text: "hi" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      },
    ]);
  });

  it("uses the last tool index for input_json_delta events missing index", async () => {
    const events = await collect(
      translateAnthropicStream(
        sseMessages(
          {
            event: "content_block_start",
            data: JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: "tu_1", name: "f" },
            }),
          },
          {
            event: "content_block_delta",
            data: JSON.stringify({
              type: "content_block_delta",
              delta: { type: "input_json_delta", partial_json: '{"a":1}' },
            }),
          },
          {
            event: "content_block_stop",
            data: JSON.stringify({ type: "content_block_stop", index: 0 }),
          },
          {
            event: "message_stop",
            data: JSON.stringify({ type: "message_stop" }),
          },
        ),
        "claude",
      ),
    );

    expect(events).toEqual([
      { type: "tool_call_start", index: 0, id: "tu_1", name: "f" },
      { type: "tool_call_delta", index: 0, argumentsTextDelta: '{"a":1}' },
      { type: "tool_call_end", index: 0 },
      {
        type: "finish",
        finishReason: "tool_calls",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    ]);
  });

  it("emits an error event when input_json_delta has no routable index", async () => {
    const events = await collect(
      translateAnthropicStream(
        sseMessages({
          event: "content_block_delta",
          data: JSON.stringify({
            type: "content_block_delta",
            delta: { type: "input_json_delta", partial_json: '{"a":1}' },
          }),
        }),
        "claude",
      ),
    );

    expect(events[0]?.type).toBe("error");
    if (events[0]?.type === "error") {
      expect(events[0].error.provider).toBe("anthropic");
    }
    expect(events[1]).toEqual({ type: "finish", finishReason: "other" });
  });
});

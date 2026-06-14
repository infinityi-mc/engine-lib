import { describe, expect, it } from "bun:test";

import { assistant, system, toolResult, user } from "../../src/messages/index";
import {
  buildChatBody,
  parseChatResponse,
} from "../../src/providers/openai-compatible/map";
import { translateChatStream } from "../../src/providers/openai-compatible/stream";
import type { CompletionRequest } from "../../src/providers/types";
import type { ToolCallPart } from "../../src/messages/types";
import { collect, sseMessages } from "./helpers";

describe("buildChatBody", () => {
  it("maps roles to chat messages", () => {
    const toolCall: ToolCallPart = {
      type: "tool_call",
      id: "c1",
      name: "f",
      arguments: { a: 1 },
    };
    const req: CompletionRequest = {
      messages: [
        system("sys"),
        user("hi"),
        assistant([toolCall]),
        toolResult("c1", "ok"),
      ],
    };
    const body = buildChatBody(req, "m", false) as Record<string, any>;
    expect(body["messages"]).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "f", arguments: '{"a":1}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ]);
  });

  it("wraps raw base64 images as a data URL in array content", () => {
    const req: CompletionRequest = {
      messages: [
        user([
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/jpeg", data: "BBBB" },
          { type: "image", mimeType: "image/jpeg", data: "https://x/y.jpg" },
        ]),
      ],
    };
    const body = buildChatBody(req, "m", false) as Record<string, any>;
    expect(body["messages"][0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        {
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64,BBBB" },
        },
        { type: "image_url", image_url: { url: "https://x/y.jpg" } },
      ],
    });
  });

  it("adds stream_options.include_usage when streaming and maps tools", () => {
    const req: CompletionRequest = {
      messages: [user("x")],
      tools: [{ name: "f", description: "d", parameters: { type: "object" } }],
    };
    const body = buildChatBody(req, "m", true) as Record<string, any>;
    expect(body["stream_options"]).toEqual({ include_usage: true });
    expect(body["tools"]).toEqual([
      {
        type: "function",
        function: {
          name: "f",
          description: "d",
          parameters: { type: "object" },
        },
      },
    ]);
  });
});

describe("parseChatResponse", () => {
  it("parses message content + tool_calls + usage", () => {
    const raw = {
      model: "m",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [
              { id: "c1", function: { name: "f", arguments: '{"a":1}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    };
    const result = parseChatResponse(raw, "m");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "c1", name: "f", arguments: { a: 1 }, argumentsText: '{"a":1}' },
    ]);
    expect(result.usage).toEqual({
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
    });
  });
});

describe("translateChatStream", () => {
  it("assembles incremental tool-call argument deltas by index", async () => {
    const events = await collect(
      translateChatStream(
        sseMessages(
          {
            data: JSON.stringify({
              model: "m",
              choices: [{ delta: { content: "hi" } }],
            }),
          },
          {
            data: JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "c1",
                        function: { name: "f", arguments: '{"a"' },
                      },
                    ],
                  },
                },
              ],
            }),
          },
          {
            data: JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: 0, function: { arguments: ":1}" } }],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }),
          },
          {
            data: JSON.stringify({
              choices: [],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            }),
          },
          { data: "[DONE]" },
        ),
        "m",
      ),
    );
    expect(events).toEqual([
      { type: "message_start", model: "m" },
      { type: "text_delta", text: "hi" },
      { type: "tool_call_start", index: 0, id: "c1", name: "f" },
      { type: "tool_call_delta", index: 0, argumentsTextDelta: '{"a"' },
      { type: "tool_call_delta", index: 0, argumentsTextDelta: ":1}" },
      { type: "tool_call_end", index: 0 },
      {
        type: "finish",
        finishReason: "tool_calls",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    ]);
  });
});

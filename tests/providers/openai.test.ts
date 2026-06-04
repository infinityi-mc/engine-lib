import { describe, expect, it } from "bun:test";

import { system, toolResult, user } from "../../src/messages/index";
import { buildOpenAIBody, parseOpenAIResponse } from "../../src/providers/openai/map";
import { translateOpenAIStream } from "../../src/providers/openai/stream";
import type { CompletionRequest } from "../../src/providers/types";
import { collect, sseMessages } from "./helpers";

describe("buildOpenAIBody", () => {
  it("maps system → instructions and user → input items", () => {
    const req: CompletionRequest = {
      messages: [system("be terse"), user("hi")],
    };
    const body = buildOpenAIBody(req, "gpt-5", false) as Record<string, any>;
    expect(body["instructions"]).toBe("be terse");
    expect(body["model"]).toBe("gpt-5");
    expect(body["input"]).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
    expect(body["stream"]).toBe(false);
  });

  it("maps tools with strict and a response schema to text.format", () => {
    const req: CompletionRequest = {
      messages: [user("x")],
      tools: [{ name: "get_weather", description: "w", parameters: { type: "object" } }],
      responseSchema: { name: "Out", schema: { type: "object" } },
    };
    const body = buildOpenAIBody(req, "gpt-5", false) as Record<string, any>;
    expect(body["tools"]).toEqual([
      { type: "function", name: "get_weather", description: "w", parameters: { type: "object" }, strict: true },
    ]);
    expect(body["text"]).toEqual({
      format: { type: "json_schema", name: "Out", schema: { type: "object" }, strict: true },
    });
  });

  it("emits function_call_output for tool results", () => {
    const req: CompletionRequest = { messages: [toolResult("call_1", "42")] };
    const body = buildOpenAIBody(req, "gpt-5", false) as Record<string, any>;
    expect(body["input"]).toEqual([{ type: "function_call_output", call_id: "call_1", output: "42" }]);
  });
});

describe("parseOpenAIResponse", () => {
  it("parses text + function_call + usage from a Responses object", () => {
    const raw = {
      model: "gpt-5",
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "hello" }] },
        { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"SF"}' },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };
    const result = parseOpenAIResponse(raw, "gpt-5");
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "get_weather", arguments: { city: "SF" }, argumentsText: '{"city":"SF"}' },
    ]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(result.message.content[0]).toEqual({ type: "text", text: "hello" });
  });

  it("maps an incomplete status to length", () => {
    const result = parseOpenAIResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, "gpt-5");
    expect(result.finishReason).toBe("length");
  });
});

describe("translateOpenAIStream", () => {
  it("translates Responses SSE into unified events", async () => {
    const events = await collect(
      translateOpenAIStream(
        sseMessages(
          { data: JSON.stringify({ type: "response.created" }) },
          { data: JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "f" } }) },
          { data: JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"a":1}' }) },
          { data: JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_1" }) },
          { data: JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "function_call", call_id: "call_1", name: "f", arguments: '{"a":1}' }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }) },
        ),
        "gpt-5",
      ),
    );
    expect(events).toEqual([
      { type: "message_start", model: "gpt-5" },
      { type: "tool_call_start", index: 0, id: "call_1", name: "f" },
      { type: "tool_call_delta", index: 0, argumentsTextDelta: '{"a":1}' },
      { type: "tool_call_end", index: 0 },
      { type: "finish", finishReason: "tool_calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ]);
  });
});

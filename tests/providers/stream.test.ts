import { describe, expect, it } from "bun:test";

import { collectStream, StreamAccumulator } from "../../src/providers/stream";
import type { StreamEvent } from "../../src/providers/stream";

async function* events(...list: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const event of list) yield event;
}

describe("StreamAccumulator", () => {
  it("folds text deltas into the assistant message", () => {
    const acc = new StreamAccumulator();
    acc.push({ type: "message_start", model: "m" });
    acc.push({ type: "text_delta", text: "Hello, " });
    acc.push({ type: "text_delta", text: "world" });
    acc.push({ type: "finish", finishReason: "stop" });
    const result = acc.result("m");
    expect(result.message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Hello, world" }],
    });
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toEqual([]);
  });

  it("assembles tool-call arguments by index", () => {
    const acc = new StreamAccumulator();
    acc.push({
      type: "tool_call_start",
      index: 0,
      id: "call_1",
      name: "get_weather",
    });
    acc.push({
      type: "tool_call_delta",
      index: 0,
      argumentsTextDelta: '{"city":',
    });
    acc.push({
      type: "tool_call_delta",
      index: 0,
      argumentsTextDelta: '"SF"}',
    });
    acc.push({ type: "tool_call_end", index: 0 });
    acc.push({ type: "finish", finishReason: "tool_calls" });
    const result = acc.result("m");
    expect(result.toolCalls).toEqual([
      {
        id: "call_1",
        name: "get_weather",
        arguments: { city: "SF" },
        argumentsText: '{"city":"SF"}',
      },
    ]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.message.content).toContainEqual({
      type: "tool_call",
      id: "call_1",
      name: "get_weather",
      arguments: { city: "SF" },
    });
  });

  it("interleaves multiple tool calls keyed by index", () => {
    const acc = new StreamAccumulator();
    acc.push({ type: "tool_call_start", index: 0, id: "a", name: "one" });
    acc.push({ type: "tool_call_start", index: 1, id: "b", name: "two" });
    acc.push({
      type: "tool_call_delta",
      index: 1,
      argumentsTextDelta: '{"x":1}',
    });
    acc.push({
      type: "tool_call_delta",
      index: 0,
      argumentsTextDelta: '{"y":2}',
    });
    acc.push({ type: "finish", finishReason: "tool_calls" });
    const result = acc.result("m");
    expect(result.toolCalls.map((t) => t.id)).toEqual(["a", "b"]);
    expect(result.toolCalls[0]?.arguments).toEqual({ y: 2 });
    expect(result.toolCalls[1]?.arguments).toEqual({ x: 1 });
  });
});

describe("collectStream", () => {
  it("drains an async iterable into a CompletionResult", async () => {
    const result = await collectStream(
      events(
        { type: "message_start", model: "m" },
        { type: "text_delta", text: "hi" },
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        },
      ),
      "m",
    );
    expect(result.message.content).toEqual([{ type: "text", text: "hi" }]);
    expect(result.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
    });
  });
});
